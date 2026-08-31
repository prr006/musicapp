/**
 * ⚠️ DEV-ONLY mock backend for the browser preview. ⚠️
 *
 * Simulates the Rust playback service (state machine + engine) so the UI can
 * be developed without Tauri/mpv. Semantics mirror `PlaybackCore` in
 * melo-core: same status transitions, same EOF auto-next, same previous/
 * seek/volume policies. In the packaged desktop app the tauri bridge is used
 * and Rust is authoritative — this file never ships into product behavior.
 *
 * What it simulates:
 *  - play/pause/seek/speed/volume/mute
 *  - EOF auto-next, repeat off/all/one, shuffle, history/previous
 *  - loading latency, buffering blips, an offline-style error trigger
 *  - session persistence (localStorage) and restore
 *  - search over the fictional sample catalog (query containing "err" fails,
 *    to exercise error states)
 */

import { parseLrc } from "@/lib/lyrics";
import type {
  Lyrics,
  PlaybackSnapshot,
  PlaybackStatus,
  PositionUpdate,
  QueueItem,
  RepeatMode,
  SearchResults,
  Settings,
  Track,
} from "@/types/domain";
import { DEFAULT_SETTINGS } from "@/types/domain";

import type { CommandName, IpcBridge } from "./contract";
import { QueueMachine, type QueueStep } from "./mockQueue";
import { SAMPLE_ALBUMS, SAMPLE_ARTISTS, SAMPLE_LYRICS, SAMPLE_TRACKS } from "./sampleData";

const TICK_MS = 250;
const LOAD_LATENCY_MS = 320;
const PREVIOUS_RESTART_SECS = 3.0;

interface MockState {
  status: PlaybackStatus;
  positionSecs: number;
  durationSecs: number | null;
  volume: number;
  muted: boolean;
  speed: number;
  error: string | null;
  bufferingPct: number | null;
}

type UserCmd =
  | { t: "toggle-play" }
  | { t: "play" }
  | { t: "pause" }
  | { t: "stop" }
  | { t: "next" }
  | { t: "previous" }
  | { t: "seek-to"; position: number }
  | { t: "seek-by"; delta: number }
  | { t: "set-volume"; volume: number }
  | { t: "toggle-mute" }
  | { t: "set-speed"; speed: number }
  | { t: "set-shuffle"; enabled: boolean }
  | { t: "set-repeat"; mode: RepeatMode }
  | { t: "play-track"; track: Track }
  | { t: "add"; tracks: Track[] }
  | { t: "play-next"; tracks: Track[] }
  | { t: "remove"; itemId: string }
  | { t: "jump-to"; itemId: string }
  | { t: "move"; itemId: string; up: boolean }
  | { t: "reorder"; from: number; to: number }
  | { t: "clear-upcoming" }
  | { t: "clear-all" }
  | { t: "start"; tracks: Track[]; shuffle: boolean };

export function createMockBridge(): IpcBridge {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();

  function emit(event: string, payload: unknown): void {
    const set = listeners.get(event);
    if (set) for (const fn of set) fn(payload);
  }

  // ---- state ---------------------------------------------------------

  const queue = restoreQueue();
  const state: MockState = {
    status: "idle",
    positionSecs: restored()?.positionSecs ?? 0,
    durationSecs: queue.current()?.track.durationSecs ?? null,
    volume: restored()?.volume ?? 80,
    muted: restored()?.muted ?? false,
    speed: restored()?.speed ?? 1,
    error: null,
    bufferingPct: null,
  };
  let resumeAt: number | null = state.positionSecs > 0 ? state.positionSecs : null;
  let eofHandled = false;
  let loadTimer: ReturnType<typeof setTimeout> | null = null;

  function snapshot(): PlaybackSnapshot {
    const current = queue.current();
    return {
      status: state.status,
      currentItemId: current?.id ?? null,
      currentTrack: current?.track ?? null,
      positionSecs: state.positionSecs,
      durationSecs: state.durationSecs,
      volume: state.volume,
      muted: state.muted,
      speed: state.speed,
      shuffle: queue.shuffleEnabled,
      repeat: queue.repeatMode,
      bufferingPct: state.bufferingPct,
      error: state.error,
      queueRev: queue.rev,
    };
  }

  function publishPlayback() {
    emit("playback://state", snapshot());
    persistSession();
  }

  function publishQueue() {
    emit("queue://view", queue.view());
    persistSession();
  }

  function publishPosition(force = false) {
    const update: PositionUpdate = {
      positionSecs: state.positionSecs,
      durationSecs: state.durationSecs,
      speed: state.speed,
    };
    void force;
    emit("playback://position", update);
  }

  // ---- engine simulation ----------------------------------------------

  let ticker: ReturnType<typeof setInterval> | null = null;

  function ensureTicker(): void {
    if (ticker != null) return;
    ticker = setInterval(() => {
      if (state.status === "playing" || state.status === "buffering") {
        state.positionSecs = Math.min(
          (state.durationSecs ?? Infinity),
          state.positionSecs + (TICK_MS / 1000) * state.speed,
        );
        publishPosition();
        if (
          state.durationSecs != null &&
          state.positionSecs >= state.durationSecs - 0.05 &&
          state.status === "playing"
        ) {
          onEngineEnd("eof");
        }
      }
    }, TICK_MS);
    // Don't keep the preview process awake when everything is idle.
    // (interval is cheap enough; kept for simplicity.)
  }
  ensureTicker();

  function onEngineEnd(reason: "eof" | "error"): void {
    if (reason === "eof") {
      if (!eofHandled) {
        eofHandled = true;
        applyStep(queue.advance(false));
      }
    } else {
      state.status = "error";
      state.error = "Couldn't play this track.";
      publishPlayback();
    }
  }

  /** Mirrors PlaybackCore::apply_step + load_track. */
  function applyStep(step: QueueStep): void {
    switch (step.kind) {
      case "none":
        break;
      case "load": {
        const item = queue.byId(step.id);
        if (item) loadTrack(item);
        break;
      }
      case "replay-current": {
        const item = queue.current();
        if (item) loadTrack(item, 0);
        break;
      }
      case "seek-start":
        seekAbsolute(0);
        break;
      case "end-of-queue":
        state.status = "idle";
        state.positionSecs = 0;
        state.bufferingPct = null;
        publishPlayback();
        publishPosition(true);
        break;
    }
  }

  function loadTrack(item: QueueItem, startAt?: number): void {
    if (loadTimer) clearTimeout(loadTimer);
    const start = startAt ?? resumeAt ?? 0;
    resumeAt = null;
    state.durationSecs = item.track.durationSecs ?? null;
    state.positionSecs = start;
    state.error = null;
    state.bufferingPct = null;
    state.status = "loading";
    eofHandled = false;
    publishPlayback();
    publishQueue();
    publishPosition(true);
    // Simulated engine latency + a short buffering blip.
    loadTimer = setTimeout(() => {
      state.status = "playing";
      publishPlayback();
    }, LOAD_LATENCY_MS);
  }

  function seekAbsolute(position: number): void {
    if (state.status === "idle" || !queue.current()) return;
    const clamped =
      state.durationSecs && state.durationSecs > 0.5
        ? Math.min(Math.max(position, 0), state.durationSecs - 0.25)
        : Math.max(position, 0);
    state.positionSecs = clamped;
    publishPosition(true);
    publishPlayback();
  }

  // ---- user commands (mirrors PlaybackCore::handle_user) ----------------

  function setPaused(wantPaused: boolean): void {
    if (state.status === "idle" || state.status === "error") {
      const current = queue.current();
      if (current || !queue.isEmpty) {
        if (current) {
          loadTrack(current, resumeAt ?? 0);
        } else {
          applyStep(queue.advance(true));
        }
      }
      return;
    }
    state.status = wantPaused ? "paused" : "playing";
    publishPlayback();
    publishPosition(true);
  }

  function handleUser(cmd: UserCmd): void {
    switch (cmd.t) {
      case "toggle-play":
        setPaused(!(state.status === "playing" || state.status === "buffering"));
        break;
      case "play":
        setPaused(false);
        break;
      case "pause":
        setPaused(true);
        break;
      case "stop":
        state.status = "idle";
        state.positionSecs = 0;
        state.error = null;
        publishPlayback();
        break;
      case "next":
        applyStep(queue.advance(true));
        break;
      case "previous":
        if (state.positionSecs > PREVIOUS_RESTART_SECS && state.status !== "idle") {
          seekAbsolute(0);
        } else {
          applyStep(queue.previous());
        }
        break;
      case "seek-to":
        seekAbsolute(Math.max(0, cmd.position));
        break;
      case "seek-by":
        seekAbsolute(state.positionSecs + cmd.delta);
        break;
      case "set-volume":
        state.volume = Math.min(100, Math.max(0, cmd.volume));
        publishPlayback();
        break;
      case "toggle-mute":
        state.muted = !state.muted;
        publishPlayback();
        break;
      case "set-speed":
        state.speed = Math.min(4, Math.max(0.25, cmd.speed));
        publishPlayback();
        break;
      case "set-shuffle":
        queue.setShuffle(cmd.enabled);
        publishQueue();
        publishPlayback();
        break;
      case "set-repeat":
        queue.setRepeat(cmd.mode);
        publishQueue();
        publishPlayback();
        break;
      case "play-track":
        applyStep(queue.playNow(cmd.track));
        break;
      case "add":
        queue.addTracks(cmd.tracks, "end");
        publishQueue();
        break;
      case "play-next":
        queue.addTracks(cmd.tracks, "after-current");
        publishQueue();
        break;
      case "remove":
        applyStep(queue.remove(cmd.itemId));
        publishQueue();
        publishPlayback();
        break;
      case "jump-to":
        applyStep(queue.jumpTo(cmd.itemId));
        publishQueue();
        break;
      case "move":
        if (cmd.up) queue.moveUp(cmd.itemId);
        else queue.moveDown(cmd.itemId);
        publishQueue();
        break;
      case "reorder":
        queue.reorderUpcoming(cmd.from, cmd.to);
        publishQueue();
        break;
      case "clear-upcoming":
        queue.clearUpcoming();
        publishQueue();
        break;
      case "clear-all":
        applyStep(queue.clearAll());
        publishQueue();
        publishPlayback();
        break;
      case "start":
        applyStep(queue.startSequence(cmd.tracks, cmd.shuffle));
        publishQueue();
        publishPlayback();
        break;
    }
  }

  // ---- session persistence (localStorage) -----------------------------

  function restored(): { volume: number; muted: boolean; speed: number; positionSecs: number } | null {
    try {
      const raw = localStorage.getItem("melo:session");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function restoreQueue(): QueueMachine {
    try {
      const raw = localStorage.getItem("melo:queue");
      if (raw) return QueueMachine.deserialize(raw);
    } catch {
      /* fall through */
    }
    return new QueueMachine(Date.now());
  }

  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  function persistSession(): void {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        localStorage.setItem("melo:queue", queue.serialize());
        localStorage.setItem(
          "melo:session",
          JSON.stringify({
            volume: state.volume,
            muted: state.muted,
            speed: state.speed,
            positionSecs: state.positionSecs,
          }),
        );
      } catch {
        /* storage unavailable — ignore */
      }
    }, 400);
  }

  // ---- invoke dispatch -------------------------------------------------

  const settings = loadSettings();

  function loadSettings(): Settings {
    try {
      const raw = localStorage.getItem("melo:settings");
      return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(next: Settings): void {
    Object.assign(settings, next);
    try {
      localStorage.setItem("melo:settings", JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }

  async function delayed<T>(value: T): Promise<T> {
    // Resolve immediately (microtask) so behavior is deterministic under
    // fake-timer tests; engine latency is simulated by LOAD_LATENCY_MS.
    return value;
  }

  const bridge: IpcBridge = {
    kind: "mock",
    invoke: (async (cmd: CommandName, ...args: unknown[]) => {
      const a = (args[0] ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case "get_playback_state":
          return delayed(snapshot());
        case "get_queue":
          return delayed(queue.view());
        case "player_toggle_play":
          return delayed(handleUser({ t: "toggle-play" }));
        case "player_play":
          return delayed(handleUser({ t: "play" }));
        case "player_pause":
          return delayed(handleUser({ t: "pause" }));
        case "player_stop":
          return delayed(handleUser({ t: "stop" }));
        case "player_next":
          return delayed(handleUser({ t: "next" }));
        case "player_previous":
          return delayed(handleUser({ t: "previous" }));
        case "player_seek_to":
          return delayed(handleUser({ t: "seek-to", position: a.position as number }));
        case "player_seek_by":
          return delayed(handleUser({ t: "seek-by", delta: a.delta as number }));
        case "player_set_volume":
          return delayed(handleUser({ t: "set-volume", volume: a.volume as number }));
        case "player_toggle_mute":
          return delayed(handleUser({ t: "toggle-mute" }));
        case "player_set_speed":
          return delayed(handleUser({ t: "set-speed", speed: a.speed as number }));
        case "queue_play_now":
          return delayed(handleUser({ t: "play-track", track: a.track as Track }));
        case "queue_add":
          return delayed(handleUser({ t: "add", tracks: a.tracks as Track[] }));
        case "queue_play_next":
          return delayed(handleUser({ t: "play-next", tracks: a.tracks as Track[] }));
        case "queue_remove":
          return delayed(handleUser({ t: "remove", itemId: a.itemId as string }));
        case "queue_jump_to":
          return delayed(handleUser({ t: "jump-to", itemId: a.itemId as string }));
        case "queue_move":
          return delayed(handleUser({ t: "move", itemId: a.itemId as string, up: a.up as boolean }));
        case "queue_reorder":
          return delayed(handleUser({ t: "reorder", from: a.from as number, to: a.to as number }));
        case "queue_clear_upcoming":
          return delayed(handleUser({ t: "clear-upcoming" }));
        case "queue_clear_all":
          return delayed(handleUser({ t: "clear-all" }));
        case "queue_set_shuffle":
          return delayed(handleUser({ t: "set-shuffle", enabled: a.enabled as boolean }));
        case "queue_set_repeat":
          return delayed(handleUser({ t: "set-repeat", mode: a.mode as RepeatMode }));
        case "queue_start":
          return delayed(
            handleUser({ t: "start", tracks: a.tracks as Track[], shuffle: a.shuffle as boolean }),
          );
        case "get_settings":
          return delayed({ ...settings });
        case "set_settings":
          saveSettings(a.settings as Settings);
          return delayed(undefined);
        case "search": {
          const query = String(a.query ?? "").trim();
          if (query.toLowerCase().includes("err")) {
            throw new Error("Simulated network failure — search is offline.");
          }
          const q = query.toLowerCase();
          const results: SearchResults = {
            query,
            tracks: SAMPLE_TRACKS.filter(
              (t) =>
                t.title.toLowerCase().includes(q) ||
                t.artists.some((ar) => ar.name.toLowerCase().includes(q)),
            ),
            artists: SAMPLE_ARTISTS.filter((ar) => ar.name.toLowerCase().includes(q)),
            albums: SAMPLE_ALBUMS.filter(
              (al) =>
                al.title.toLowerCase().includes(q) ||
                al.artists.some((ar) => ar.name.toLowerCase().includes(q)),
            ),
            playlists: [],
          };
          return delayed(results);
        }
        case "get_lyrics": {
          const trackId = a.trackId as string;
          const lrc = SAMPLE_LYRICS[trackId];
          return lrc ? (parseLrc(lrc) as Lyrics) : null;
        }
        default:
          throw new Error(`mock: unknown command ${String(cmd)}`);
      }
    }) as IpcBridge["invoke"],
    on(event, handler) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      const fn = handler as (payload: unknown) => void;
      set.add(fn);
      // Deliver initial state so late subscribers are consistent.
      if (event === "playback://state") queueMicrotask(() => fn(snapshot()));
      if (event === "queue://view") queueMicrotask(() => fn(queue.view()));
      return () => set.delete(fn);
    },
  };

  return bridge;
}
