/**
 * ⚠️ DEV-ONLY ⚠️ — browser preview adapter internals.
 *
 * This is a faithful TypeScript port of the Rust `QueueMachine`
 * (crates/melo-core/src/queue.rs) used ONLY by the mock IPC bridge so the UI
 * can be developed/previewed in a plain browser. In the real desktop app the
 * Rust implementation is the single authority; this file must never be
 * imported outside `src/app/ipc/mock*`.
 *
 * It is ported 1:1 (same invariants, same algorithms) and covered by the same
 * test cases in `tests/queueMachine.test.ts`, which keeps the two honest
 * against each other.
 */

import type { QueueItem, QueueView, RepeatMode, Track } from "@/types/domain";

export type AddPosition = "end" | "after-current";

export type QueueStep =
  | { kind: "none" }
  | { kind: "load"; id: string }
  | { kind: "replay-current" }
  | { kind: "seek-start" }
  | { kind: "end-of-queue" };

const HISTORY_CAP = 500;

/** Seeded xorshift64* — same characteristics as the Rust side. */
export class Rng {
  private s: bigint;
  constructor(seed: bigint | number) {
    let s = BigInt(seed);
    if (s === 0n) s = 0x9e3779b97f4a7c15n;
    this.s = s;
  }
  next(): bigint {
    let x = this.s;
    x ^= x >> 12n;
    x ^= x << 25n;
    x ^= x >> 27n;
    this.s = x;
    return (x * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
  }
  below(n: number): number {
    if (n <= 0) return 0;
    return Number(this.next() % BigInt(n));
  }
  shuffled<T>(items: T[]): T[] {
    const v = [...items];
    for (let i = v.length - 1; i > 0; i--) {
      const j = this.below(i + 1);
      [v[i], v[j]] = [v[j], v[i]];
    }
    return v;
  }
}

export class QueueMachine {
  private items: QueueItem[] = [];
  private order: string[] = [];
  private cursor: number | null = null;
  private history: string[] = [];
  private shuffle = false;
  private repeat: RepeatMode = "off";
  private rng: Rng;
  private idSeq = 0;
  rev = 0;

  constructor(seed: number | bigint = 1) {
    this.rng = new Rng(seed);
  }

  // --- introspection -------------------------------------------------

  get length(): number {
    return this.items.length;
  }
  get isEmpty(): boolean {
    return this.items.length === 0;
  }
  get shuffleEnabled(): boolean {
    return this.shuffle;
  }
  get repeatMode(): RepeatMode {
    return this.repeat;
  }
  get orderIds(): readonly string[] {
    return this.order;
  }
  get cursorIndex(): number | null {
    return this.cursor;
  }
  get historyIds(): readonly string[] {
    return this.history;
  }

  current(): QueueItem | null {
    if (this.cursor == null) return null;
    const id = this.order[this.cursor];
    return id ? this.byId(id) : null;
  }

  byId(id: string): QueueItem | null {
    return this.items.find((i) => i.id === id) ?? null;
  }

  upcoming(): QueueItem[] {
    const start = this.cursor == null ? 0 : this.cursor + 1;
    return this.order.slice(start).map((id) => this.byId(id)!).filter(Boolean);
  }

  historyItems(): QueueItem[] {
    const out: QueueItem[] = [];
    for (let i = this.history.length - 1; i >= 0; i--) {
      const item = this.byId(this.history[i]);
      if (item) out.push(item);
    }
    return out;
  }

  view(): QueueView {
    return {
      current: this.current(),
      upcoming: this.upcoming(),
      history: this.historyItems(),
      shuffle: this.shuffle,
      repeat: this.repeat,
      rev: this.rev,
    };
  }

  // --- mutation ------------------------------------------------------

  addTracks(tracks: Track[], pos: AddPosition): string[] {
    if (tracks.length === 0) return [];
    const created = tracks.map((track) => {
      this.idSeq += 1;
      const id = `qi:${this.idSeq}`;
      this.items.push({ id, track });
      return id;
    });
    if (pos === "after-current") {
      const at = this.cursor == null ? 0 : this.cursor + 1;
      this.order.splice(at, 0, ...created);
    } else if (this.shuffle) {
      const start = this.cursor == null ? 0 : this.cursor + 1;
      for (const id of created) {
        const span = this.order.length - start + 1;
        this.order.splice(start + this.rng.below(span), 0, id);
      }
    } else {
      this.order.push(...created);
    }
    this.bump();
    return created;
  }

  playNow(track: Track): QueueStep {
    const ids = this.addTracks([track], "after-current");
    return this.jumpTo(ids[0]);
  }

  jumpTo(id: string): QueueStep {
    const pos = this.order.indexOf(id);
    if (pos === -1) return { kind: "none" };
    if (this.cursor != null && this.cursor !== pos) {
      this.pushHistory(this.order[this.cursor]);
    }
    this.cursor = pos;
    this.bump();
    return { kind: "load", id };
  }

  startSequence(tracks: Track[], shuffle: boolean): QueueStep {
    this.items = [];
    this.order = [];
    this.history = [];
    this.cursor = null;
    this.shuffle = shuffle;
    this.addTracks(tracks, "end");
    if (this.order.length === 0) {
      this.bump();
      return { kind: "none" };
    }
    if (shuffle) this.order = this.rng.shuffled(this.order);
    this.cursor = 0;
    this.bump();
    return { kind: "load", id: this.order[0] };
  }

  advance(userInitiated: boolean): QueueStep {
    if (this.cursor == null) {
      if (this.order.length === 0) return { kind: "none" };
      this.cursor = 0;
      return { kind: "load", id: this.order[0] };
    }
    if (this.repeat === "one" && !userInitiated) return { kind: "replay-current" };
    const outgoing = this.order[this.cursor];
    if (this.cursor + 1 < this.order.length) {
      this.pushHistory(outgoing);
      this.cursor += 1;
      return { kind: "load", id: this.order[this.cursor] };
    }
    if (this.repeat === "all" && this.order.length > 0) {
      this.pushHistory(outgoing);
      this.cursor = 0;
      return { kind: "load", id: this.order[0] };
    }
    return { kind: "end-of-queue" };
  }

  previous(): QueueStep {
    const id = this.history.pop();
    if (id != null) {
      const pos = this.order.indexOf(id);
      if (pos !== -1) {
        this.cursor = pos;
        this.bump();
        return { kind: "load", id };
      }
    }
    if (this.cursor != null) return { kind: "seek-start" };
    if (this.order.length === 0) return { kind: "none" };
    this.cursor = 0;
    return { kind: "load", id: this.order[0] };
  }

  remove(id: string): QueueStep {
    const itemPos = this.items.findIndex((i) => i.id === id);
    if (itemPos === -1) return { kind: "none" };
    const orderPos = this.order.indexOf(id);
    const wasCurrent = this.cursor === orderPos;
    this.items.splice(itemPos, 1);
    if (orderPos !== -1) this.order.splice(orderPos, 1);
    if (this.cursor != null && orderPos !== -1 && orderPos < this.cursor) {
      this.cursor -= 1;
    }
    this.history = this.history.filter((h) => h !== id);
    this.bump();
    if (!wasCurrent) return { kind: "none" };
    const c = this.cursor;
    if (c != null && c < this.order.length) return { kind: "load", id: this.order[c] };
    if (this.repeat === "all" && this.order.length > 0) {
      this.cursor = 0;
      return { kind: "load", id: this.order[0] };
    }
    this.cursor = null;
    return { kind: "end-of-queue" };
  }

  clearUpcoming(): void {
    const keep = this.cursor == null ? 0 : this.cursor + 1;
    this.order = this.order.slice(0, keep);
    this.retainItemsInPlay();
    this.bump();
  }

  clearAll(): QueueStep {
    this.items = [];
    this.order = [];
    this.history = [];
    this.cursor = null;
    this.bump();
    return { kind: "end-of-queue" };
  }

  setShuffle(enabled: boolean): void {
    if (enabled === this.shuffle) return;
    this.shuffle = enabled;
    if (enabled) {
      const current = this.cursor == null ? null : this.order[this.cursor];
      const played = this.cursor == null ? [] : this.order.slice(0, this.cursor);
      const rest = this.cursor == null ? [...this.order] : this.order.slice(this.cursor + 1);
      const order: string[] = [];
      if (current) order.push(current);
      order.push(...this.rng.shuffled(rest));
      order.push(...played);
      this.order = order;
      this.cursor = current ? 0 : null;
    } else {
      const current = this.cursor == null ? null : this.order[this.cursor];
      this.order = this.items.map((i) => i.id);
      this.cursor = current ? this.order.indexOf(current) : null;
    }
    this.bump();
  }

  setRepeat(mode: RepeatMode): void {
    if (mode !== this.repeat) {
      this.repeat = mode;
      this.bump();
    }
  }

  moveUp(id: string): void {
    const pos = this.order.indexOf(id);
    const floor = this.cursor == null ? 0 : this.cursor + 1;
    if (pos > floor) {
      [this.order[pos - 1], this.order[pos]] = [this.order[pos], this.order[pos - 1]];
      this.bump();
    }
  }

  moveDown(id: string): void {
    const pos = this.order.indexOf(id);
    const floor = this.cursor == null ? 0 : this.cursor + 1;
    if (pos >= floor && pos + 1 < this.order.length) {
      [this.order[pos + 1], this.order[pos]] = [this.order[pos], this.order[pos + 1]];
      this.bump();
    }
  }

  reorderUpcoming(from: number, to: number): void {
    const floor = this.cursor == null ? 0 : this.cursor + 1;
    const upcomingLen = this.order.length - floor;
    if (from >= upcomingLen || to >= upcomingLen) return;
    const [id] = this.order.splice(floor + from, 1);
    this.order.splice(floor + to, 0, id);
    this.bump();
  }

  // --- serialization (session restore in the browser preview) --------

  serialize(): string {
    return JSON.stringify({
      items: this.items,
      order: this.order,
      cursor: this.cursor,
      history: this.history,
      shuffle: this.shuffle,
      repeat: this.repeat,
      idSeq: this.idSeq,
    });
  }

  static deserialize(json: string): QueueMachine {
    const d = JSON.parse(json);
    const q = new QueueMachine(Date.now());
    q.items = d.items ?? [];
    q.order = d.order ?? [];
    q.cursor = d.cursor ?? null;
    q.history = d.history ?? [];
    q.shuffle = d.shuffle ?? false;
    q.repeat = d.repeat ?? "off";
    q.idSeq = d.idSeq ?? q.items.length;
    q.bump();
    return q;
  }

  // --- internals ------------------------------------------------------

  private pushHistory(id: string): void {
    if (this.history[this.history.length - 1] === id) return;
    if (this.history.length >= HISTORY_CAP) this.history.shift();
    this.history.push(id);
  }

  private retainItemsInPlay(): void {
    const keep = new Set([...this.order, ...this.history]);
    this.items = this.items.filter((i) => keep.has(i.id));
  }

  private bump(): void {
    this.rev += 1;
  }
}
