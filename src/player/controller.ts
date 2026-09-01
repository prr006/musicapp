/**
 * Playback controller: the glue between the engine (libmpv via IPC), the
 * queue (application concept) and the UI stores.
 *
 * Data flow (one direction only — the engine is authoritative):
 *
 *   user op ──► controller ──► queue decision ──► resolve (yt-dlp) ──► player_load
 *   engine events ──► controller ──► queue decision ──► player_load / stores
 *
 * Track-change contract (the part that makes it feel like a real player):
 *   1. the engine is STOPPED immediately (never keeps playing the old song
 *      while the next one resolves),
 *   2. the local engine snapshot + interpolated clock are reset to the new
 *      track (position 0 / restored position, its duration, "loading"),
 *   3. the queue/UI publish the new metadata at once,
 *   4. only then resolve + `player_load` run (serialized in load order).
 *
 * Race guards:
 * * `epoch` (from player_load) drops stale engine events when tracks are
 *   switched rapidly — only the current epoch may update position/end flow.
 * * `loadGen` drops stale RESOLVES: play A → play B quickly, A's late
 *   resolve answer can never load over B.
 * * every load decision from the queue carries a token; a duplicate or
 *   stale end-of-file cannot double-advance (see player/queue.ts).
 */

import { getBridge, type CommandName, type IpcBridge } from "@/app/ipc";
import type { Settings } from "@/types/domain";
import { pushToast, uiStore } from "@/app/stores/ui";
import { onPositionEvent, resetClockForTest } from "@/app/stores/clock";
import { playbackStore, queueStore } from "@/app/stores/playback";
import type { PlaybackSnapshot, Track } from "@/types/domain";
import { QueueMachine } from "@/player/queue";
import { autoplayService } from "@/player/autoplay";

/** Resolved URL cache (media URLs expire; 30 min is safe). */
const RESOLVE_TTL_MS = 30 * 60 * 1000;

/** Session flush debounce: cheap writes, never on the audio path. */
const SESSION_FLUSH_DEBOUNCE_MS = 1500;

interface EngineState {
  status: string;
  positionSecs: number;
  durationSecs: number | null;
  paused: boolean;
  buffering: boolean;
  seeking: boolean;
  speed: number;
  volume: number;
  muted: boolean;
  epoch: number;
}

interface SessionDoc {
  queue?: Track[];
  history?: Track[];
  currentTrackId?: string | null;
  positionSecs?: number;
  volume?: number;
  muted?: boolean;
  speed?: number;
  shuffle?: boolean;
  repeat?: "off" | "all" | "one";
  savedAtMs?: number;
}

/**
 * Map IPC rejections (Tauri rejects with plain strings — `ProviderError`
 * serializes to kebab-case tags like "offline"/"timeout", commands with
 * their error string) to actionable copy. Never show "unknown error".
 */
function friendlyError(err: unknown, fallback: string): string {
  // Tauri rejects with plain strings; `ProviderError` serializes to a
  // kebab-case tag ("offline") or `{ detail: "..." }` for Detail variants.
  let raw = typeof err === "string" ? err : err instanceof Error ? err.message : "";
  if (!raw && err != null && typeof err === "object") {
    const detail = (err as { detail?: unknown }).detail;
    if (typeof detail === "string") raw = detail;
    else raw = String(err);
  }
  if (!raw) return fallback;
  if (raw.includes("yt-dlp runtime missing")) return "Playback engine unavailable — repair the runtime in Settings";
  if (/offline|network|dns|tls|ssl/i.test(raw)) return "Couldn't reach YouTube — check your connection";
  if (raw === "timeout" || raw.includes("timed out") || raw.includes("took too long"))
    return "That took too long — check your connection and retry";
  if (raw === "rate-limited" || raw.includes("Too many requests"))
    return "YouTube is rate-limiting requests — wait a moment and retry";
  if (raw === "not-found" || raw.includes("no longer available"))
    return "Couldn't find this track anymore — it may have been removed";
  if (raw === "invalid-input" || raw.includes("invalid")) return "That request wasn't valid";
  if (raw.includes("Playback engine is not running") || raw.includes("playback engine"))
    return "Playback engine unavailable — repair the runtime in Settings";
  return raw;
}

/** Duration clamp for completion stats. */
function completionOf(playedSecs: number, durationSecs: number | null): number {
  if (!durationSecs || durationSecs <= 0) return 0;
  return Math.max(0, Math.min(1, playedSecs / durationSecs));
}

class PlaybackController {
  private queue = new QueueMachine();
  private bridge: IpcBridge | null = null;
  /** Engine epoch of the currently loaded file (null = nothing loaded). */
  private currentEpoch: number | null = null;
  /** Epoch that was stopped to make room for a pending load. */
  private stoppedEpoch: number | null = null;
  /**
   * Generation of the newest requested load. Resolves from older generations
   * are discarded — play A → play B fast must never let A load over B.
   */
  private loadGen = 0;
  /** Queue token of the current load (correlates EOF to the loaded file). */
  private currentToken = 0;
  /** The track the engine currently holds (for progress bookkeeping). */
  private loadedTrack: Track | null = null;
  /**
   * Loads are serialized through this chain: resolve + `player_load` for
   * successive loads always reach the engine in queue order, even when a
   * natural EOF races a manual Next.
   */
  private loadChain: Promise<void> = Promise.resolve();
  /** Saved position of a restored session (used once, on first play). */
  private restoredPositionSecs = 0;
  private engine: EngineState = {
    status: "dead",
    positionSecs: 0,
    durationSecs: null,
    paused: true,
    buffering: false,
    seeking: false,
    speed: 1,
    volume: 80,
    muted: false,
    epoch: 0,
  };
  /** Desired audio prefs (persisted in the session; applied on engine ready). */
  private prefs = { volume: 80, muted: false, speed: 1 };
  private resolveCache = new Map<string, { url: string; at: number }>();
  private sessionDirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private unwire: (() => void) | null = null;
  private bootstrapped = false;

  // ---- wiring ---------------------------------------------------------------

  /**
   * Subscribe to engine events. Safe to call repeatedly (e.g. after a bridge
   * swap in tests): previous subscriptions are dropped first. The session
   * restore runs once.
   */
  wire(): () => void {
    this.unwire?.();
    const bridge = getBridge();
    this.bridge = bridge;
    const offs = [
      bridge.on("player://state", (s) => this.onEngineState(s as EngineState)),
      bridge.on("player://position", (p) => {
        const { positionSecs, durationSecs, epoch } = p as {
          positionSecs: number;
          durationSecs: number | null;
          epoch: number;
        };
        // Strict guard: only the CURRENT load's samples may move the clock.
        if (this.currentEpoch == null || epoch !== this.currentEpoch) return;
        this.engine.positionSecs = positionSecs;
        if (durationSecs != null) this.engine.durationSecs = durationSecs;
        this.anchorClock();
      }),
      bridge.on("player://end", (e) =>
        this.onEngineEnd(e as { reason: string; error: string | null; epoch: number }),
      ),
      bridge.on("runtime://status", (s) => {
        const { phase, message } = s as { phase: string; message: string };
        if (phase === "ready") void this.onEngineReady();
        else if (phase === "error") pushToast(message, "error");
      }),
    ];
    const teardown = () => {
      for (const off of offs) off();
    };
    this.unwire = teardown;
    this.publishQueue();
    if (!this.bootstrapped) {
      this.bootstrapped = true;
      void this.restoreSession();
      void this.syncEngine();
    }
    return teardown;
  }

  /** Reset all controller state (tests). */
  resetForTest(): void {
    this.queue = new QueueMachine();
    this.currentEpoch = null;
    this.stoppedEpoch = null;
    this.loadGen = 0;
    this.currentToken = 0;
    this.loadedTrack = null;
    this.loadChain = Promise.resolve();
    this.restoredPositionSecs = 0;
    this.resolveCache.clear();
    this.sessionDirty = false;
    if (this.flushTimer != null) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    resetClockForTest();
    this.engine = {
      status: "dead",
      positionSecs: 0,
      durationSecs: null,
      paused: true,
      buffering: false,
      seeking: false,
      speed: 1,
      volume: this.prefs.volume,
      muted: this.prefs.muted,
      epoch: 0,
    };
    this.publishQueue();
  }

  private ipc(cmd: CommandName, arg?: unknown): Promise<unknown> {
    const bridge: { invoke: (cmd: CommandName, arg?: unknown) => Promise<unknown> } = (this
      .bridge ??
      getBridge()) as unknown as {
      invoke: (cmd: CommandName, arg?: unknown) => Promise<unknown>;
    };
    return bridge.invoke(cmd, arg ?? {});
  }

  // ---- engine events --------------------------------------------------------

  private onEngineState(s: EngineState): void {
    // A pending load just stopped the old file: the engine publishes an
    // "idle"/"ended" snapshot for the STOP — that must not overwrite the
    // "loading" state of the track being resolved.
    const regression =
      this.stoppedEpoch != null &&
      s.epoch <= this.stoppedEpoch &&
      (s.status === "idle" || s.status === "ended");
    if (regression) return;
    this.engine = { ...this.engine, ...s };
    this.anchorClock();
    this.publish();
  }

  private onEngineEnd(e: { reason: string; error: string | null; epoch: number }): void {
    if (this.currentEpoch == null || e.epoch !== this.currentEpoch) {
      return; // stale: the file was replaced (or stopped) before it ended
    }
    this.reportProgress();
    this.currentEpoch = null;
    this.stoppedEpoch = e.epoch;
    if (e.reason === "eof") {
      // THE natural end-of-track trigger — nothing else advances the queue.
      const decision = this.queue.onEngineEof(this.currentToken);
      if (decision.kind === "load") {
        this.beginLoad(decision.item.track, {
          token: decision.token,
          startAt: 0,
        });
      } else if (decision.exhausted) {
        void this.maybeAutoplay();
      }
      this.publishQueue();
      return;
    }
    if (e.reason === "error") {
      pushToast(
        e.error ? `Playback error: ${e.error}` : "Playback error",
        "error",
      );
    }
    // stop / quit / redirect / error — a manual stop NEVER auto-advances.
    this.queue.onEngineStop();
    this.publishQueue();
  }

  /** Engine (re)started or runtime became ready: sync truth, re-apply prefs. */
  private async onEngineReady(): Promise<void> {
    await this.syncEngine();
    await this.applyPrefs();
  }

  private async syncEngine(): Promise<void> {
    try {
      const s = (await this.ipc("player_get_state")) as EngineState;
      if (s.status === "dead") return;
      this.engine = { ...this.engine, ...s };
      // A load may already be in flight (restart/repair); keep loading truth.
      if (this.stoppedEpoch == null || s.epoch > this.stoppedEpoch) {
        this.currentEpoch = s.status === "idle" ? null : s.epoch;
      }
      this.publish();
    } catch {
      // Engine not up yet (runtime installing) — ready event will follow.
    }
  }

  private async maybeAutoplay(): Promise<void> {
    if (!autoplayService.enabled) return;
    const next = await autoplayService.pickNext(this.queue.queueTracks());
    if (next && this.queue.exhausted) {
      this.queue.add([next]);
      const decision = this.queue.next();
      if (decision) {
        this.beginLoad(decision.item.track, { token: decision.token, startAt: 0 });
      }
    }
  }

  // ---- loading ---------------------------------------------------------------

  private async resolve(track: Track): Promise<string> {
    const key = `${track.source}:${track.sourceId}`;
    const hit = this.resolveCache.get(key);
    if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.url;
    const media = (await this.ipc("resolve_track", {
      sourceId: track.sourceId,
    })) as { url: string };
    this.resolveCache.set(key, { url: media.url, at: Date.now() });
    return media.url;
  }

  /**
   * Synchronous head of every track change: stop the old audio, reset the
   * visible state to the new track, publish. The old song must never keep
   * playing (or stay on screen) while the new one resolves.
   */
  private beginLoad(
    track: Track,
    opts: { token: number; startAt?: number },
  ): void {
    const gen = ++this.loadGen;
    const startAt = Math.max(0, opts.startAt ?? this.restoredPositionSecs);
    // The saved position belongs to the restored track only — any explicit
    // new load consumes it.
    this.restoredPositionSecs = 0;

    // 1. Silence the old track right away (event suppressed via epochs).
    if (this.currentEpoch != null) {
      this.stoppedEpoch = this.currentEpoch;
      this.currentEpoch = null;
      void this.ipc("player_stop").catch(() => undefined);
    }
    this.reportProgress();

    // 2. Point every piece of visible state at the new track.
    this.currentToken = opts.token;
    this.loadedTrack = track;
    this.engine = {
      ...this.engine,
      status: "loading",
      positionSecs: startAt,
      durationSecs: track.durationSecs ?? null,
      paused: true,
      buffering: false,
      seeking: false,
    };
    this.anchorClock();

    // 3. Queue/UI show the new metadata immediately.
    this.publishQueue();
    this.markSessionDirty();

    // 4. Resolve + load, strictly in request order.
    this.loadChain = this.loadChain
      .then(() => this.loadItem(track, { ...opts, startAt, gen }))
      .catch(() => undefined);
  }

  private async loadItem(
    track: Track,
    opts: { token: number; startAt: number; gen: number; startPaused?: boolean },
  ): Promise<void> {
    const gen = opts.gen;
    const superseded = (): boolean =>
      gen !== this.loadGen || this.queue.currentItem()?.track.id !== track.id;
    let url: string;
    try {
      if (track.source === "local") {
        url = track.sourceId;
      } else {
        url = await this.resolve(track);
      }
    } catch (err) {
      if (superseded()) return; // a newer request already replaced this one
      pushToast(
        `Couldn't resolve "${track.title}" — ${friendlyError(err, "try again in a moment")}`,
        "error",
      );
      // Resolution failed: advance ONCE to the next queue item (the queue
      // always moves to a different item, so this cannot loop on the same
      // unresolvable track) and let the UI see the skip immediately.
      const decision = this.queue.next();
      if (decision) {
        // `superseded()` above guarantees `gen` is still newest here.
        this.publishQueue();
        await this.loadItem(decision.item.track, {
          token: decision.token,
          startAt: 0,
          gen: ++this.loadGen,
        });
      } else {
        this.engine.status = "error";
        this.publish();
      }
      return;
    }
    if (superseded()) return; // replaced during resolve
    try {
      const epoch = (await this.ipc("player_load", {
        url,
        startPaused: opts.startPaused === true,
        startAt: opts.startAt > 0 ? opts.startAt : null,
      })) as number;
      if (gen !== this.loadGen) return; // replaced while loading
      this.currentEpoch = epoch;
      this.stoppedEpoch = null;
      // Listening history: the track actually started playing.
      if (uiStore.get().settings.historyEnabled) {
        void this.ipc("record_play", { track }).catch(() => undefined);
      }
      this.engine.status = "loading";
      this.publish();
    } catch (err) {
      if (gen !== this.loadGen) return;
      pushToast(
        friendlyError(err, "Playback engine is not available"),
        "error",
      );
      this.engine.status = "error";
      this.publish();
    }
  }

  // ---- user operations -------------------------------------------------------

  playNow(track: Track): void {
    const result = this.queue.playNow(track);
    if (result) this.beginLoad(result.item.track, { token: result.token, startAt: 0 });
  }

  startSequence(tracks: Track[], shuffle: boolean): void {
    const result = this.queue.startSequence(tracks, shuffle);
    if (result) this.beginLoad(result.item.track, { token: result.token, startAt: 0 });
    else this.publishQueue();
  }

  addToQueue(tracks: Track[]): void {
    this.queue.add(tracks);
    this.publishQueue();
    this.markSessionDirty();
  }

  playNext(tracks: Track[]): void {
    this.queue.playNext(tracks);
    this.publishQueue();
    this.markSessionDirty();
  }

  removeFromQueue(itemId: string): void {
    const removal = this.queue.remove(itemId);
    if (removal.advanced) {
      // The playing item was removed: move playback to the follow-up.
      this.beginLoad(removal.advanced.item.track, {
        token: removal.advanced.token,
        startAt: 0,
      });
      return;
    }
    if (removal.stopped) {
      // Queue ran dry: stop cleanly — never keep the removed track playing.
      this.stop();
      return;
    }
    this.publishQueue();
    this.markSessionDirty();
  }

  jumpTo(itemId: string): void {
    const result = this.queue.jumpTo(itemId);
    if (result) this.beginLoad(result.item.track, { token: result.token, startAt: 0 });
  }

  moveQueueItem(itemId: string, up: boolean): void {
    this.queue.move(itemId, up);
    this.publishQueue();
    this.markSessionDirty();
  }

  reorderQueue(from: number, to: number): void {
    this.queue.reorder(from, to);
    this.publishQueue();
    this.markSessionDirty();
  }

  shuffleUpcoming(): void {
    this.queue.shuffleUpcoming();
    this.publishQueue();
    this.markSessionDirty();
  }

  clearUpcoming(): void {
    this.queue.clearUpcoming();
    this.publishQueue();
    this.markSessionDirty();
  }

  clearQueue(): void {
    this.queue.clearAll();
    this.currentEpoch = null;
    this.stoppedEpoch = null;
    this.loadedTrack = null;
    this.loadGen++;
    void this.ipc("player_stop").catch(() => undefined);
    this.engine = {
      ...this.engine,
      status: "idle",
      positionSecs: 0,
      durationSecs: null,
    };
    this.anchorClock();
    this.publishQueue();
    this.publish();
    this.markSessionDirty();
  }

  /**
   * Manual stop: stop/unload the engine, keep the queue + current item so
   * Play can restart it. NEVER advances the queue (the engine reports the
   * stop and `onEngineEnd` ignores it for advancement purposes).
   */
  stop(): void {
    this.reportProgress();
    this.loadGen++;
    if (this.currentEpoch != null) {
      this.stoppedEpoch = this.currentEpoch;
      this.currentEpoch = null;
      void this.ipc("player_stop").catch(() => undefined);
    }
    this.engine = {
      ...this.engine,
      status: "idle",
      positionSecs: 0,
      paused: true,
      buffering: false,
      seeking: false,
    };
    this.anchorClock();
    this.publish();
    this.markSessionDirty();
  }

  setShuffle(enabled: boolean): void {
    this.queue.setShuffle(enabled);
    this.publishQueue();
    this.markSessionDirty();
  }

  setRepeat(mode: "off" | "all" | "one"): void {
    this.queue.setRepeat(mode);
    this.publishQueue();
    this.markSessionDirty();
  }

  next(): void {
    const result = this.queue.next();
    if (result) this.beginLoad(result.item.track, { token: result.token, startAt: 0 });
    else {
      // Nothing left: stop cleanly (queue stays for Play to restart).
      this.stop();
    }
  }

  previous(): void {
    const result = this.queue.previous(this.engine.positionSecs);
    if (!result) return;
    if (result.restart && this.currentEpoch != null) {
      // Same track, just started: an in-place seek is instant (no re-resolve).
      void this.ipc("player_seek", { position: 0 }).catch(() => undefined);
      this.engine.positionSecs = 0;
      this.anchorClock();
      this.publish();
      return;
    }
    this.beginLoad(result.item.track, { token: result.token, startAt: 0 });
  }

  async togglePlay(): Promise<void> {
    const nothingLoaded =
      this.currentEpoch == null ||
      ["idle", "ended", "dead", "error"].includes(this.engine.status);
    if (nothingLoaded) {
      // Restored session or fresh/stopped queue: play = load the current (or
      // first) track, resuming at the saved position when one exists.
      const target = this.queue.currentItem() ?? this.queue.firstItem();
      if (!target) return;
      const startAt = this.restoredPositionSecs > 1 ? this.restoredPositionSecs : 0;
      const result = this.queue.jumpTo(target.id);
      if (result) {
        this.beginLoad(result.item.track, { token: result.token, startAt });
      }
      return;
    }
    await this.ipc("player_toggle_play").catch(() => undefined);
  }

  async seekTo(position: number): Promise<void> {
    if (this.currentEpoch == null) return;
    await this.ipc("player_seek", { position: Math.max(0, position) }).catch(() => undefined);
    // Anchor immediately so the UI reflects the seek without waiting for the
    // engine round-trip; the next authoritative sample re-anchors anyway.
    this.engine.positionSecs = Math.max(0, position);
    this.anchorClock();
    this.publish();
  }

  async seekBy(delta: number): Promise<void> {
    await this.seekTo(this.engine.positionSecs + delta);
  }

  async setVolume(volume: number): Promise<void> {
    const clamped = Math.min(100, Math.max(0, Math.round(volume)));
    this.prefs.volume = clamped;
    this.engine.volume = clamped;
    // Dragging the slider above zero while muted unmutes (standard behavior).
    const unmute = clamped > 0 && this.engine.muted;
    if (unmute) {
      this.prefs.muted = false;
      this.engine.muted = false;
    }
    this.publish();
    await Promise.allSettled([
      this.ipc("player_set_volume", { volume: clamped }),
      ...(unmute ? [this.ipc("player_set_mute", { muted: false })] : []),
    ]);
  }

  async toggleMute(): Promise<void> {
    const muted = !this.engine.muted;
    this.prefs.muted = muted;
    this.engine.muted = muted;
    this.publish();
    await this.ipc("player_set_mute", { muted }).catch(() => undefined);
  }

  async setSpeed(speed: number): Promise<void> {
    const clamped = Math.min(4, Math.max(0.25, speed));
    this.prefs.speed = clamped;
    this.engine.speed = clamped;
    this.anchorClock();
    this.publish();
    await this.ipc("player_set_speed", { speed: clamped }).catch(() => undefined);
  }

  /** mpv `af=loudnorm` toggle (Settings → Volume normalization). */
  async setNormalization(on: boolean): Promise<void> {
    await this.ipc("player_set_normalization", { enabled: on }).catch(() => undefined);
  }

  private async applyPrefs(): Promise<void> {
    await Promise.allSettled([
      this.ipc("player_set_volume", { volume: this.prefs.volume }),
      this.ipc("player_set_mute", { muted: this.prefs.muted }),
      this.ipc("player_set_speed", { speed: this.prefs.speed }),
    ]);
    const settings = uiStore.get().settings;
    await this.ipc("player_set_normalization", {
      enabled: settings.volumeNormalization,
    }).catch(() => undefined);
  }

  queueTracks(): Track[] {
    return this.queue.queueTracks();
  }

  snapshot(): PlaybackSnapshot {
    return playbackStore.get();
  }

  // ---- listening-history progress -------------------------------------------

  /**
   * Push the reached position of the track that was playing into the history
   * (drives "Recently played" completion). Called on track switch, stop and
   * session flush; the engine is authoritative for the position.
   */
  private reportProgress(): void {
    const track = this.loadedTrack;
    if (!track) return;
    const playedSecs = this.engine.positionSecs;
    if (playedSecs <= 1) return;
    void this.ipc("record_play_progress", {
      trackId: track.id,
      playedSecs,
      completion: completionOf(playedSecs, this.engine.durationSecs ?? track.durationSecs),
    }).catch(() => undefined);
  }

  // ---- session persistence ---------------------------------------------------

  private markSessionDirty(): void {
    this.sessionDirty = true;
    if (this.flushTimer != null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushSession();
    }, SESSION_FLUSH_DEBOUNCE_MS);
  }

  flushSession(): void {
    if (!this.sessionDirty) return;
    this.sessionDirty = false;
    this.reportProgress();
    const current = this.queue.currentItem();
    const session: SessionDoc = {
      queue: this.queue.queueTracks().slice(0, 200),
      history: this.queue.snapshot().history.slice(0, 50).map((h) => h.track),
      currentTrackId: current?.track.id ?? null,
      positionSecs: this.engine.positionSecs,
      volume: this.prefs.volume,
      muted: this.prefs.muted,
      speed: this.prefs.speed,
      shuffle: this.queue.snapshot().shuffle,
      repeat: this.queue.snapshot().repeat,
      savedAtMs: Date.now(),
    };
    void this.ipc("set_session", { session }).catch(() => undefined);
  }

  /** Test-only: wipe local state and re-run the session restore. */
  async restoreForTest(settings?: Partial<Settings>): Promise<void> {
    this.queue.clearAll();
    this.publishQueue();
    this.currentEpoch = null;
    this.stoppedEpoch = null;
    this.loadedTrack = null;
    this.loadGen++;
    this.restoredPositionSecs = 0;
    if (settings) {
      uiStore.set((s) => ({ settings: { ...s.settings, ...settings } }));
      await this.ipc("set_settings", { settings: { ...uiStore.get().settings } }).catch(
        () => undefined,
      );
    }
    await this.restoreSession();
  }

  private async restoreSession(): Promise<void> {
    try {
      // Settings decide whether a session comes back at all.
      const [session, settings] = await Promise.all([
        this.ipc("get_session") as Promise<SessionDoc | null>,
        this.ipc("get_settings") as Promise<Partial<Settings> | null>,
      ]);
      const resumeLastSession = settings?.resumeLastSession === true;
      if (settings != null) {
        const patch = { ...uiStore.get().settings, ...settings };
        uiStore.set({ settings: patch });
      }
      // The engine is idle after a restart — nothing is loaded until the
      // user presses play (startup NEVER autoplays).
      this.engine.status = "idle";
      // Volume/mute/speed come back regardless of the session setting.
      if (typeof session?.volume === "number") {
        this.prefs.volume = Math.min(100, Math.max(0, session.volume));
        this.engine.volume = this.prefs.volume;
      }
      if (typeof session?.muted === "boolean") {
        this.prefs.muted = session.muted;
        this.engine.muted = session.muted;
      }
      if (typeof session?.speed === "number" && session.speed >= 0.25 && session.speed <= 4) {
        this.prefs.speed = session.speed;
        this.engine.speed = session.speed;
      }
      this.publish();
      await this.applyPrefs();

      if (!resumeLastSession) return;
      if (!session || !Array.isArray(session.queue) || session.queue.length === 0) return;
      const tracks = session.queue.filter((t) => t && typeof t.id === "string");
      if (tracks.length === 0) return;
      this.queue.clearAll();
      this.queue.add(tracks);
      if (typeof session.shuffle === "boolean") this.queue.setShuffle(session.shuffle);
      if (session.repeat) this.queue.setRepeat(session.repeat);
      if (typeof session.currentTrackId === "string") {
        const item = this.queue
          .upcomingItems()
          .find((i) => i.track.id === session.currentTrackId);
        if (item) {
          // Select without loading: restore NEVER autoplays (engine idle).
          this.queue.jumpTo(item.id);
          this.currentEpoch = null;
          this.loadedTrack = item.track;
          this.engine.positionSecs =
            typeof session.positionSecs === "number" && session.positionSecs > 0
              ? session.positionSecs
              : 0;
          this.engine.durationSecs = item.track.durationSecs ?? null;
          this.restoredPositionSecs = this.engine.positionSecs;
          this.anchorClock();
        }
      }
      this.publishQueue();
    } catch {
      // No session yet — fine.
    }
  }

  // ---- stores ----------------------------------------------------------------

  /**
   * Re-anchor the single interpolated clock (stores/clock.ts) on the current
   * controller truth. Called whenever position/status/speed change so the
   * UI (progress bar, lyrics) always derives from engine samples — never
   * from an independent timer.
   */
  private anchorClock(): void {
    onPositionEvent({
      positionSecs: this.engine.positionSecs,
      durationSecs: this.engine.durationSecs,
      speed: this.engine.speed,
      playing: this.engine.status === "playing",
      receivedAtMs: undefined,
    });
  }

  private publishQueue(): void {
    queueStore.set(this.queue.snapshot());
    this.publish();
  }

  private publish(): void {
    const view = this.queue.snapshot();
    const current = view.current;
    const e = this.engine;
    let status: PlaybackSnapshot["status"];
    switch (e.status) {
      case "playing":
        status = "playing";
        break;
      case "paused":
        status = "paused";
        break;
      case "buffering":
        status = "buffering";
        break;
      case "loading":
        status = current ? "loading" : "idle";
        break;
      case "ended":
        status = "idle";
        break;
      case "error":
      case "dead":
        status = current ? "error" : "idle";
        break;
      default:
        status = current ? "paused" : "idle";
    }
    playbackStore.set({
      status,
      currentItemId: current?.id ?? null,
      currentTrack: current?.track ?? null,
      positionSecs: e.positionSecs,
      durationSecs: e.durationSecs ?? current?.track.durationSecs ?? null,
      volume: e.volume,
      muted: e.muted,
      speed: e.speed,
      shuffle: view.shuffle,
      repeat: view.repeat,
      bufferingPct: e.buffering ? 0 : null,
      error: e.status === "error" || e.status === "dead" ? "engine unavailable" : null,
      queueRev: view.rev,
    });
  }
}

export const playbackController = new PlaybackController();
