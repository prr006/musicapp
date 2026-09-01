/**
 * Playback controller: the glue between the engine (libmpv via IPC), the
 * queue (application concept) and the UI stores.
 *
 * Data flow (one direction only — the engine is authoritative):
 *
 *   user op ──► controller ──► queue decision ──► resolve (yt-dlp) ──► player_load
 *   engine events ──► controller ──► queue decision ──► player_load / stores
 *
 * Guards:
 * * `epoch` (from player_load) drops stale end-of-file notifications when
 *   tracks are switched rapidly — only the current epoch may advance.
 * * A resolve that finishes after its track was replaced is discarded.
 * * The engine reports buffering/seeking; the UI interpolates position ONLY
 *   between authoritative samples (see stores/clock.ts).
 */

import { getBridge } from "@/app/ipc";
/* eslint-disable @typescript-eslint/no-explicit-any */
function ipc(cmd: any, ...args: any[]): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bridge: any = getBridge();
  return bridge.invoke(cmd, ...args);
}
import { pushToast } from "@/app/stores/ui";
import { playbackStore, positionStore, queueStore } from "@/app/stores/playback";
import type { PlaybackSnapshot, Track } from "@/types/domain";
import { QueueMachine } from "@/player/queue";
import { autoplayService } from "@/player/autoplay";

/** Resolved URL cache (media URLs expire; 30 min is safe). */
const RESOLVE_TTL_MS = 30 * 60 * 1000;

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

class PlaybackController {
  private queue = new QueueMachine();
  /** Engine epoch of the currently loaded file (null = nothing loaded). */
  private currentEpoch: number | null = null;
  /** Queue token of the current load (correlates EOF to the loaded file). */
  private currentToken = 0;
  /**
   * Loads are serialized through this chain: resolve + `player_load` for
   * successive loads always reach the engine in queue order, even when a
   * natural EOF races a manual Next (out-of-order IPC submissions would
   * otherwise leave mpv playing a file the controller has already replaced).
   */
  private loadChain: Promise<void> = Promise.resolve();
  /** Saved position of a restored session (used once, on first play). */
  private restoredPositionSecs = 0;
  /** Queue token for the current load (duplicate-EOF guard is in the queue). */
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
  private resolveCache = new Map<string, { url: string; at: number }>();
  private sessionDirty = false;
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
    const offs = [
      bridge.on("player://state", (s) => this.onEngineState(s as EngineState)),
      bridge.on("player://position", (p) => {
        const { positionSecs, durationSecs, epoch } = p as {
          positionSecs: number;
          durationSecs: number | null;
          epoch: number;
        };
        if (this.currentEpoch != null && epoch !== this.currentEpoch) return;
        this.engine.positionSecs = positionSecs;
        if (durationSecs != null) this.engine.durationSecs = durationSecs;
        positionStore.set({ positionSecs, durationSecs: this.engine.durationSecs });
      }),
      bridge.on("player://end", (e) => this.onEngineEnd(e as { reason: string; error: string | null; epoch: number })),
    ];
    const teardown = () => {
      for (const off of offs) off();
    };
    this.unwire = teardown;
    this.publishQueue();
    if (!this.bootstrapped) {
      this.bootstrapped = true;
      void this.restoreSession();
    }
    return teardown;
  }

  // ---- engine events --------------------------------------------------------

  private onEngineState(s: EngineState): void {
    this.engine = { ...this.engine, ...s };
    this.publish();
  }

  private onEngineEnd(e: { reason: string; error: string | null; epoch: number }): void {
    if (this.currentEpoch != null && e.epoch !== this.currentEpoch) {
      return; // stale: the file was replaced before it ended
    }
    this.currentEpoch = null;
    if (e.reason === "eof") {
      // THE natural end-of-track trigger — nothing else advances the queue.
      const decision = this.queue.onEngineEof(this.currentToken);
      if (decision.kind === "load") {
        void this.enqueueLoad(decision.item.track, {
          token: decision.token,
          restart: decision.restart === true,
        });
      } else if (decision.exhausted) {
        void this.maybeAutoplay();
      }
      this.publishQueue();
      return;
    }
    if (e.reason === "error") {
      pushToast(e.error ? `Playback error: ${e.error}` : "Playback error", "error");
      this.queue.onEngineStop();
    } else {
      // stop / quit / redirect — manual stop MUST NOT auto-advance.
      this.queue.onEngineStop();
    }
    this.publishQueue();
  }

  private async maybeAutoplay(): Promise<void> {
    if (!autoplayService.enabled) return;
    const next = await autoplayService.pickNext(this.queue.queueTracks());
    if (next && this.queue.exhausted) {
      this.queue.add([next]);
      const decision = this.queue.next();
      if (decision) {
        void this.enqueueLoad(decision.item.track, { token: decision.token });
      }
    }
  }

  // ---- loading ---------------------------------------------------------------

  private async resolve(track: Track): Promise<string> {
    const key = `${track.source}:${track.sourceId}`;
    const hit = this.resolveCache.get(key);
    if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.url;
    const media = await ipc("resolve_track", {
      sourceId: track.sourceId,
      quality: undefined,
    });
    this.resolveCache.set(key, { url: media.url, at: Date.now() });
    return media.url;
  }

  /** Queue a load; never awaited by callers (fire-and-forget by design). */
  private enqueueLoad(
    track: Track,
    opts: { token: number; restart?: boolean; startPaused?: boolean; startAt?: number },
  ): void {
    this.loadChain = this.loadChain
      .then(() => this.loadItem(track, opts))
      .catch(() => undefined);
  }

  private async loadItem(
    track: Track,
    opts: { token: number; restart?: boolean; startPaused?: boolean; startAt?: number },
  ): Promise<void> {
    const token = opts.token;
    this.currentToken = token;
    this.publishQueue();
    this.markSessionDirty();
    let url: string;
    try {
      if (track.source === "local") {
        url = track.sourceId;
      } else {
        url = await this.resolve(track);
      }
    } catch (err) {
      if (this.queue.currentItem()?.track.id !== track.id) return; // replaced meanwhile
      pushToast(
        `Couldn't resolve "${track.title}": ${err instanceof Error ? err.message : "unknown error"}`,
        "error",
      );
      // Resolution failed: advance once to the next track (never loop on it).
      const decision = this.queue.next();
      if (decision && decision.item.track.id !== track.id) {
        await this.loadItem(decision.item.track, { token: decision.token });
      } else {
        this.currentEpoch = null;
        this.publishQueue();
      }
      return;
    }
    if (this.queue.currentItem()?.track.id !== track.id) return; // replaced during resolve
    try {
      const epoch = await ipc("player_load", {
        url,
        startPaused: opts.startPaused === true,
        startAt: opts.startAt ?? null,
      } as never);
      this.currentEpoch = epoch;
      // Listening history: the track actually started playing.
      ipc("record_play", { track }).catch(() => undefined);
      this.engine.status = "loading";
      this.engine.positionSecs = opts.startAt ?? 0;
      this.engine.durationSecs = track.durationSecs ?? null;
      this.publish();
    } catch (err) {
      pushToast(
        err instanceof Error ? err.message : "Playback engine is not available",
        "error",
      );
    }
    void token; // token bookkeeping lives in the queue
  }

  // ---- user operations -------------------------------------------------------

  playNow(track: Track): void {
    const { item, token } = this.queue.playNow(track);
    void this.enqueueLoad(item.track, { token });
  }

  startSequence(tracks: Track[], shuffle: boolean): void {
    const result = this.queue.startSequence(tracks, shuffle);
    if (result) void this.enqueueLoad(result.item.track, { token: result.token });
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
    this.queue.remove(itemId);
    this.publishQueue();
    this.markSessionDirty();
  }

  jumpTo(itemId: string): void {
    const result = this.queue.jumpTo(itemId);
    if (result) void this.enqueueLoad(result.item.track, { token: result.token });
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

  clearUpcoming(): void {
    this.queue.clearUpcoming();
    this.publishQueue();
    this.markSessionDirty();
  }

  clearQueue(): void {
    this.queue.clearAll();
    this.currentEpoch = null;
    void ipc("player_stop").catch(() => undefined);
    this.publishQueue();
    this.publish();
    this.markSessionDirty();
  }

  setShuffle(enabled: boolean): void {
    this.queue.setShuffle(enabled);
    this.publishQueue();
  }

  setRepeat(mode: "off" | "all" | "one"): void {
    this.queue.setRepeat(mode);
    this.publishQueue();
  }

  next(): void {
    const result = this.queue.next();
    if (result) void this.enqueueLoad(result.item.track, { token: result.token });
    else {
      void ipc("player_stop").catch(() => undefined);
      this.publishQueue();
    }
  }

  previous(): void {
    const result = this.queue.previous();
    if (result) void this.enqueueLoad(result.item.track, { token: result.token, startAt: result.seekTo });
  }

  async togglePlay(): Promise<void> {
    const nothingLoaded =
      this.currentEpoch == null ||
      ["idle", "ended", "dead", "error"].includes(this.engine.status);
    if (nothingLoaded) {
      // Restored session or fresh queue: play = load the current/first track
      // (resuming at the saved position when one exists).
      const item = this.queue.currentItem() ?? this.queue.upcomingItems()[0];
      if (!item) return;
      const startAt = this.restoredPositionSecs > 1 ? this.restoredPositionSecs : null;
      this.restoredPositionSecs = 0;
      const result = this.queue.jumpTo(item.id);
      if (result) {
        void this.enqueueLoad(result.item.track, {
          token: result.token,
          startAt: startAt ?? undefined,
        });
      }
      return;
    }
    await ipc("player_toggle_play").catch(() => undefined);
  }

  async seekTo(position: number): Promise<void> {
    await ipc("player_seek", { position }).catch(() => undefined);
  }

  async seekBy(delta: number): Promise<void> {
    const base = this.engine.positionSecs;
    await ipc("player_seek", { position: Math.max(0, base + delta) }).catch(() => undefined);
  }

  async setVolume(volume: number): Promise<void> {
    await ipc
      .call("player_set_volume", { volume })
      .then(() => {
        this.engine.volume = volume;
        this.publish();
      })
      .catch(() => undefined);
  }

  async toggleMute(): Promise<void> {
    const muted = !this.engine.muted;
    await ipc
      .call("player_set_mute", { muted })
      .then(() => {
        this.engine.muted = muted;
        this.publish();
      })
      .catch(() => undefined);
  }

  async setSpeed(speed: number): Promise<void> {
    await ipc
      .call("player_set_speed", { speed })
      .then(() => {
        this.engine.speed = speed;
        this.publish();
      })
      .catch(() => undefined);
  }

  queueTracks(): Track[] {
    return this.queue.queueTracks();
  }

  snapshot(): PlaybackSnapshot {
    return playbackStore.get();
  }

  // ---- session persistence ---------------------------------------------------

  private markSessionDirty(): void {
    this.sessionDirty = true;
  }

  flushSession(): void {
    if (!this.sessionDirty) return;
    this.sessionDirty = false;
    const current = this.queue.currentItem();
    const session = {
      queue: this.queue.queueTracks().slice(0, 200),
      history: this.queue.snapshot().history.slice(0, 50).map((h) => h.track),
      currentTrackId: current?.track.id ?? null,
      positionSecs: this.engine.positionSecs,
      volume: this.engine.volume,
      muted: this.engine.muted,
      speed: this.engine.speed,
      savedAtMs: Date.now(),
    };
    void ipc("set_session", { session }).catch(() => undefined);
  }

  private async restoreSession(): Promise<void> {
    try {
      const session = (await ipc("get_session")) as {
        queue?: Track[];
        history?: Track[];
        currentTrackId?: string | null;
        positionSecs?: number;
      } | null;
      if (!session || !Array.isArray(session.queue) || session.queue.length === 0) return;
      const tracks = session.queue as Track[];
      this.queue.clearAll();
      this.queue.add(tracks);
      if (typeof session.currentTrackId === "string") {
        const item = this.queue
          .upcomingItems()
          .find((i) => i.track.id === session.currentTrackId);
        if (item) {
          // Select without loading: restore never autoplays (engine idle).
          this.queue.jumpTo(item.id);
          this.currentEpoch = null;
          this.restoredPositionSecs =
            typeof session.positionSecs === "number" ? session.positionSecs : 0;
        }
      }
      this.publishQueue();
    } catch {
      // No session yet — fine.
    }
  }

  // ---- stores ----------------------------------------------------------------

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
