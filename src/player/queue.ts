/**
 * App-level queue machine (pure, deterministic, no React, no IPC).
 *
 * The queue is an APPLICATION concept — the media engine (libmpv) knows
 * nothing about it. The controller feeds engine events in and gets load
 * decisions out:
 *
 *   engine EOF  → onEngineEof() → advance EXACTLY ONCE per loaded track
 *   engine STOP → onStop()      → never advances (manual stop)
 *   user Next   → next()        → advances exactly once
 *
 * Duplicate engine EOF notifications cannot double-advance: every load gets
 * a fresh token and EOF consumes it. Rapid switching is safe for the same
 * reason — a stale EOF for a replaced track no longer matches the token.
 */

import type { QueueItem, QueueView, RepeatMode, Track } from "@/types/domain";

let idSeq = 1;
const nextId = (): string => `qi:${idSeq++}`;

/** Deterministic PRNG so shuffle orders are reproducible in tests. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: T[], seed: number): T[] {
  const rng = mulberry32(seed);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export type LoadDecision =
  | { kind: "load"; item: QueueItem; restart?: boolean }
  | { kind: "none"; exhausted: boolean };

/** What to do after removing an item (`QueueMachine.remove`). */
export interface RemovalDecision {
  /** The removed item was the current one and playback should move on. */
  advanced: { item: QueueItem; token: number } | null;
  /** True when the queue ran dry — the engine must stop (nothing to play). */
  stopped: boolean;
}

/**
 * When Previous restarts the current track instead of going back (seconds of
 * playback). Matches common desktop-player behavior: a quick tap restarts,
 * holding through the song goes to the previous item.
 */
export const PREVIOUS_RESTART_THRESHOLD_SECS = 3;

export interface QueueState {
  /** Added order (source of truth for ids → tracks). */
  items: QueueItem[];
  /** Current item id (played or loading), null when idle. */
  currentId: string | null;
  /** Play order of the ids AFTER the current one. */
  order: string[];
  /** Most-recent-first played items. */
  history: QueueItem[];
  shuffle: boolean;
  repeat: RepeatMode;
  /** Bumped on every visible change (React re-render key). */
  rev: number;
  /**
   * Monotonic load token. Every decision to load a file increments it, so an
   * end-of-file notification can be tied to exactly one loaded file.
   */
  token: number;
}

export class QueueMachine {
  state: QueueState;
  /** Shuffle seed; changes on every toggle so re-enabling reshuffles. */
  private seed: number;

  constructor(seed = 20260901) {
    this.seed = seed;
    this.state = {
      items: [],
      currentId: null,
      order: [],
      history: [],
      shuffle: false,
      repeat: "off",
      rev: 0,
      token: 0,
    };
  }

  private bump(): void {
    this.state.rev++;
  }

  private item(id: string): QueueItem | undefined {
    return this.state.items.find((i) => i.id === id);
  }

  private nextToken(): number {
    return ++this.state.token;
  }

  /** Regenerate the play order (shuffle on → seeded, off → added order). */
  private rebuildOrder(pinnedFirst?: string): void {
    const pending = this.state.items
      .filter((i) => i.id !== this.state.currentId)
      .map((i) => i.id);
    let ids = this.state.shuffle ? shuffled(pending, this.seed) : pending;
    if (pinnedFirst && ids.includes(pinnedFirst)) {
      ids = [pinnedFirst, ...ids.filter((id) => id !== pinnedFirst)];
    }
    this.state.order = ids;
  }

  // ---- user operations ----------------------------------------------------

  /** Replace whatever plays with `track` (history keeps the old current). */
  playNow(track: Track): { item: QueueItem; token: number } | null {
    return this.playNowAll([track]);
  }

  /** Start a fresh sequence: replace the whole queue with `tracks`. */
  startSequence(tracks: Track[], shuffle: boolean): { item: QueueItem; token: number } | null {
    if (tracks.length === 0) return null;
    this.state.items = tracks.map((track) => ({ id: nextId(), track }));
    this.state.history = [];
    this.state.currentId = null;
    this.setShuffle(shuffle, { silent: true });
    const first = shuffle
      ? this.state.order[0] ?? this.state.items[0]!.id
      : this.state.items[0]!.id;
    return this.selectCurrent(first);
  }

  private playNowAll(tracks: Track[]): { item: QueueItem; token: number } | null {
    if (tracks.length === 0) {
      const fallback = this.state.currentId ?? this.state.order[0];
      return fallback ? this.selectCurrent(fallback) : null;
    }
    const added = tracks.map((track) => ({ id: nextId(), track }));
    this.state.items.push(...added);
    return this.selectCurrent(added[0].id);
  }

  /** Add to the end of the queue. */
  add(tracks: Track[]): void {
    if (tracks.length === 0) return;
    const added = tracks.map((track) => ({ id: nextId(), track }));
    this.state.items.push(...added);
    if (this.state.shuffle) {
      // Append to the shuffled order too — no reshuffle of waiting items.
      this.state.order.push(...added.map((a) => a.id));
    } else {
      this.rebuildOrder();
    }
    this.bump();
  }

  /** Insert directly after the current track. */
  playNext(tracks: Track[]): void {
    if (tracks.length === 0) return;
    const added = tracks.map((track) => ({ id: nextId(), track }));
    this.state.items.push(...added);
    this.rebuildOrder(added[0].id);
    for (let i = added.length - 1; i >= 1; i--) {
      const idx = this.state.order.indexOf(added[i].id);
      if (idx >= 0) {
        this.state.order.splice(idx, 1);
        this.state.order.splice(1, 0, added[i].id);
      }
    }
    this.bump();
  }

  /** Jump to an upcoming item (used by queue clicks). */
  jumpTo(id: string): { item: QueueItem; token: number } | null {
    if (!this.item(id)) return null;
    return this.selectCurrent(id);
  }

  /** Manual next: advances exactly once. */
  next(): { item: QueueItem; token: number } | null {
    const decision = this.advance();
    if (decision.kind === "load") {
      return { item: decision.item, token: decision.token };
    }
    return null;
  }

  /**
   * Manual previous. Two behaviors, mirroring desktop players:
   * * position > `PREVIOUS_RESTART_THRESHOLD_SECS` → restart the CURRENT
   *   track (`restart: true`, no queue mutation, history untouched);
   * * otherwise → the most recent history item, else the first upcoming
   *   item, else restart the current one from zero.
   */
  previous(positionSecs = 0): {
    item: QueueItem;
    token: number;
    seekTo: number;
    restart: boolean;
  } | null {
    const current = this.currentItem();
    if (current && positionSecs > PREVIOUS_RESTART_THRESHOLD_SECS) {
      return { item: current, token: this.nextToken(), seekTo: 0, restart: true };
    }
    const prev = this.state.history[0];
    if (prev) {
      this.state.history.shift();
      const result = this.selectCurrent(prev.id);
      return { ...result, seekTo: 0, restart: false };
    }
    // No history: go to the first upcoming item if the current one just
    // started, otherwise restart the current one.
    if (current) {
      return { item: current, token: this.nextToken(), seekTo: 0, restart: true };
    }
    const first = this.state.order[0];
    if (first) {
      const result = this.selectCurrent(first);
      return { ...result, seekTo: 0, restart: false };
    }
    return null;
  }

  /**
   * Remove an item. Removing the CURRENT one is a single advance to the next
   * item (repeat rules apply); the controller receives the decision so the
   * engine actually loads the follow-up — the removed track must not keep
   * playing.
   */
  remove(id: string): RemovalDecision {
    const idx = this.state.items.findIndex((i) => i.id === id);
    if (idx < 0) return { advanced: null, stopped: false };
    if (id === this.state.currentId) {
      // Drop it without pushing it into history (the user removed it).
      this.state.items.splice(idx, 1);
      this.state.currentId = null;
      // NOTE: the order is NOT rebuilt here — it only ever contains
      // not-yet-played items, so `order[0]` is the true follow-up and
      // already-played tracks don't restart when repeat is off.
      const follow = this.state.order[0];
      if (follow) {
        const result = this.selectCurrent(follow);
        return { advanced: result, stopped: false };
      }
      if (this.state.repeat === "all" && this.state.items.length > 0) {
        this.state.history = [];
        this.rebuildOrder();
        const first = this.state.order[0];
        if (first) {
          const result = this.selectCurrent(first);
          return { advanced: result, stopped: false };
        }
      }
      this.bump();
      return { advanced: null, stopped: true };
    }
    this.state.items.splice(idx, 1);
    this.state.order = this.state.order.filter((o) => o !== id);
    this.bump();
    return { advanced: null, stopped: false };
  }

  move(id: string, up: boolean): void {
    const orderIdx = this.state.order.indexOf(id);
    if (orderIdx < 0) return;
    const target = up ? orderIdx - 1 : orderIdx + 1;
    if (target < 0 || target >= this.state.order.length) return;
    [this.state.order[orderIdx], this.state.order[target]] = [
      this.state.order[target],
      this.state.order[orderIdx],
    ];
    this.bump();
  }

  /** Drag-reorder the upcoming list (indices refer to the displayed order). */
  reorder(from: number, to: number): void {
    const n = this.state.order.length;
    if (from === to || from < 0 || to < 0 || from >= n || to >= n) return;
    const [moved] = this.state.order.splice(from, 1);
    this.state.order.splice(to, 0, moved);
    this.bump();
  }

  clearUpcoming(): void {
    this.state.order = [];
    this.state.items = this.state.items.filter(
      (i) => i.id === this.state.currentId || this.state.history.some((h) => h.id === i.id),
    );
    this.bump();
  }

  clearAll(): void {
    this.state.items = [];
    this.state.order = [];
    this.state.history = [];
    this.state.currentId = null;
    this.bump();
  }

  setShuffle(enabled: boolean, opts?: { silent?: boolean }): void {
    this.state.shuffle = enabled;
    this.seed = (this.seed * 1664525 + 1013904223 + this.state.rev) >>> 0;
    this.rebuildOrder();
    if (!opts?.silent) this.bump();
  }

  setRepeat(mode: RepeatMode): void {
    this.state.repeat = mode;
    this.bump();
  }

  /**
   * Reshuffle ONLY the upcoming order (new seed). The current track and the
   * history are untouched — this never restarts or interrupts playback.
   */
  shuffleUpcoming(): void {
    if (this.state.order.length < 2) return;
    this.seed = (this.seed * 1664525 + 1013904223 + this.state.rev) >>> 0;
    const pending = this.state.order;
    const rng = mulberry32(this.seed);
    for (let i = pending.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pending[i], pending[j]] = [pending[j], pending[i]];
    }
    this.bump();
  }

  /** First item to (re)start from when the queue is exhausted (Play button). */
  firstItem(): QueueItem | null {
    return this.currentItem() ?? this.upcomingItems()[0] ?? this.state.items[0] ?? null;
  }

  // ---- engine events ------------------------------------------------------

  /**
   * Natural EOF from the engine for the file loaded under `token`.
   *
   * Only the CURRENT file's token may advance the queue. A duplicate
   * notification (same file ended twice) or a stale one (the file was
   * replaced mid-play and already ended) no longer matches the current
   * token and is ignored — so the queue can never double-advance.
   */
  onEngineEof(token: number): { kind: "load"; item: QueueItem; token: number; restart?: boolean } | { kind: "none"; exhausted: boolean; token: number } {
    if (!this.state.currentId || token !== this.state.token) {
      return { kind: "none", exhausted: this.state.currentId == null, token: this.state.token };
    }

    if (this.state.repeat === "one") {
      const current = this.currentItem();
      if (current) {
        const token = this.nextToken();
        return { kind: "load", item: current, restart: true, token };
      }
    }
    const decision = this.advance();
    if (decision.kind === "load") return decision;
    return { kind: "none", exhausted: decision.exhausted, token: this.state.token };
  }

  /** Engine reported manual stop / quit / replaced file: NEVER advance. */
  onEngineStop(): void {
    // The controller drops further end events for this load (its epoch is
    // already null); the queue state itself is intentionally unchanged.
  }

  /** Queue empty + repeat off + engine idle: is there anything left? */
  get exhausted(): boolean {
    return this.state.currentId == null && this.state.order.length === 0;
  }

  currentItem(): QueueItem | null {
    return this.state.currentId ? this.item(this.state.currentId) ?? null : null;
  }

  upcomingItems(): QueueItem[] {
    return this.state.order
      .map((id) => this.item(id))
      .filter((i): i is QueueItem => i != null);
  }

  /** Everything queued now (current + upcoming), in play order. */
  queueTracks(): Track[] {
    const current = this.currentItem();
    const tracks: Track[] = [];
    if (current) tracks.push(current.track);
    for (const item of this.upcomingItems()) tracks.push(item.track);
    return tracks;
  }

  snapshot(): QueueView {
    return {
      current: this.currentItem(),
      upcoming: this.upcomingItems(),
      history: [...this.state.history],
      shuffle: this.state.shuffle,
      repeat: this.state.repeat,
      rev: this.state.rev,
    };
  }

  // ---- internals -----------------------------------------------------------

  /**
   * Most-recent-first history. An item never appears twice (jumping back to
   * a history item and advancing again moves it to the front instead of
   * duplicating it).
   */
  private pushHistory(item: QueueItem): void {
    this.state.history = [
      item,
      ...this.state.history.filter((h) => h.id !== item.id),
    ];
    if (this.state.history.length > 200) this.state.history.length = 200;
  }

  /** Shared advance logic (manual next + EOF). */
  private advance(): { kind: "load"; item: QueueItem; token: number } | { kind: "none"; exhausted: boolean } {
    const current = this.currentItem();
    if (current) {
      this.pushHistory(current);
      this.state.currentId = null;
    }
    const nextIdInOrder = this.state.order[0];
    if (nextIdInOrder) {
      const result = this.selectCurrent(nextIdInOrder);
      return { kind: "load", item: result.item, token: result.token };
    }
    // Order exhausted.
    if (this.state.repeat === "all" && this.state.items.length > 0) {
      this.state.history = [];
      this.rebuildOrder();
      const first = this.state.order[0];
      if (first) {
        const result = this.selectCurrent(first);
        return { kind: "load", item: result.item, token: result.token };
      }
    }
    this.bump();
    return { kind: "none", exhausted: true };
  }

  /** Make `id` the current item and return its fresh load token. */
  private selectCurrent(id: string): { item: QueueItem; token: number } {
    const target = this.item(id);
    if (!target) {
      this.bump();
      return { item: { id, track: null as unknown as Track }, token: this.nextToken() };
    }
    // Preserve in items[] (history needs it), remove from upcoming order.
    this.state.order = this.state.order.filter((o) => o !== id);
    this.state.currentId = id;
    this.bump();
    return { item: target, token: this.nextToken() };
  }
}
