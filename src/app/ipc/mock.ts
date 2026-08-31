/**
 * ⚠️ DEV-ONLY mock backend for the browser preview. ⚠️
 *
 * Simulates the Rust playback service (state machine + engine) so the UI can
 * be developed without Tauri/mpv/yt-dlp. Semantics mirror `PlaybackCore` in
 * melo-core: same status transitions, same EOF auto-next, same previous/
 * seek/volume policies. In the packaged desktop app the tauri bridge is used
 * and Rust is authoritative — this file never ships into product behavior.
 * It is kept honest against the Rust core by mirrored test suites.
 *
 * Simulated: play/pause/seek/speed/volume/mute, EOF auto-next, repeat
 * off/all/one, shuffle, history/previous, loading latency, buffering blips,
 * search failure trigger (query containing "err"), session persistence,
 * library (favorites/playlists/history/search-history) via MockLibrary.
 */

import { parseLrc } from "@/lib/lyrics";
import type {
  LibraryData,
  Lyrics,
  PlaybackSnapshot,
  PlaybackStatus,
  PlaylistLite,
  PositionUpdate,
  QueueItem,
  RepeatMode,
  SearchResults,
  Settings,
  Track,
} from "@/types/domain";
import { DEFAULT_SETTINGS } from "@/types/domain";

import type { CommandName, IpcBridge } from "./contract";
import { MockLibrary } from "./mockLibrary";
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
  const library = new MockLibrary();
  library.subscribe(() => emit("library://updated", library.snapshot()));

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
  let historyEnabled = true;

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

  function publishPosition() {
    const update: PositionUpdate = {
      positionSecs: state.positionSecs,
      durationSecs: state.durationSecs,
      speed: state.speed,
    };
    emit("playback://position", update);
  }

  // ---- engine simulation ----------------------------------------------

  let ticker: ReturnType<typeof setInterval> | null = null;

  function ensureTicker(): void {
    if (ticker != null) return;
    ticker = setInterval(() => {
      if (state.status === "playing" || state.status === "buffering") {
        state.positionSecs = Math.min(
          state.durationSecs ?? Infinity,
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
  }
  ensureTicker();

  /** Finalize history when the current track is left (mirrors the service). */
  function finalizeHistory(): void {
    const track = queue.current()?.track;
    if (track) library.finishRecentFor(track.id, state.positionSecs, completion());
  }

  function completion(): number {
    const d = state.durationSecs;
    if (!d || d <= 0) return 0;
    if (state.positionSecs >= d - 1.0) return 1;
    return Math.min(1, Math.max(0, state.positionSecs / d));
  }

  function onEngineEnd(reason: "eof" | "error"): void {
    if (reason === "eof") {
      if (!eofHandled) {
        eofHandled = true;
        finalizeHistory();
        applyStep(queue.advance(false));
      }
    } else {
      finalizeHistory();
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
        finalizeHistory();
        state.status = "idle";
        state.positionSecs = 0;
        state.bufferingPct = null;
        publishPlayback();
        publishPosition();
        break;
    }
  }

  function loadTrack(item: QueueItem, startAt?: number): void {
    if (loadTimer) clearTimeout(loadTimer);
    finalizeHistory();
    const start = startAt ?? resumeAt ?? 0;
    resumeAt = null;
    state.durationSecs = item.track.durationSecs ?? null;
    state.positionSecs = start;
    state.error = null;
    state.bufferingPct = null;
    state.status = "loading";
    eofHandled = false;
    if (historyEnabled) library.recordPlay(item.track);
    publishPlayback();
    publishQueue();
    publishPosition();
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
    publishPosition();
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
    publishPosition();
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
        finalizeHistory();
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
        finalizeHistory();
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

  // ---- settings ---------------------------------------------------------

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
    historyEnabled = next.historyEnabled;
    try {
      localStorage.setItem("melo:settings", JSON.stringify(settings));
    } catch {
      /* ignore */
    }
  }

  async function nowait<T>(value: T): Promise<T> {
    return value;
  }

  const bridge: IpcBridge = {
    kind: "mock",
    invoke: (async (cmd: CommandName, ...args: unknown[]) => {
      const a = (args[0] ?? {}) as Record<string, unknown>;
      switch (cmd) {
        // ---- state reads ----
        case "get_playback_state":
          return nowait(snapshot());
        case "get_queue":
          return nowait(queue.view());
        case "get_library":
          return nowait(library.snapshot());
        case "get_diagnostics":
          return nowait({
            mpvProgram: "mock-engine",
            ytdlpFound: true,
            ytdlpPath: "mock://yt-dlp",
            qualityLabel: "Mock quality · ≤128 kbps",
          });

        // ---- transport ----
        case "player_toggle_play":
          return nowait(handleUser({ t: "toggle-play" }));
        case "player_play":
          return nowait(handleUser({ t: "play" }));
        case "player_pause":
          return nowait(handleUser({ t: "pause" }));
        case "player_stop":
          return nowait(handleUser({ t: "stop" }));
        case "player_next":
          return nowait(handleUser({ t: "next" }));
        case "player_previous":
          return nowait(handleUser({ t: "previous" }));
        case "player_seek_to":
          return nowait(handleUser({ t: "seek-to", position: a.position as number }));
        case "player_seek_by":
          return nowait(handleUser({ t: "seek-by", delta: a.delta as number }));
        case "player_set_volume":
          return nowait(handleUser({ t: "set-volume", volume: a.volume as number }));
        case "player_toggle_mute":
          return nowait(handleUser({ t: "toggle-mute" }));
        case "player_set_speed":
          return nowait(handleUser({ t: "set-speed", speed: a.speed as number }));

        // ---- queue ----
        case "queue_play_now":
          return nowait(handleUser({ t: "play-track", track: a.track as Track }));
        case "queue_add":
          return nowait(handleUser({ t: "add", tracks: a.tracks as Track[] }));
        case "queue_play_next":
          return nowait(handleUser({ t: "play-next", tracks: a.tracks as Track[] }));
        case "queue_remove":
          return nowait(handleUser({ t: "remove", itemId: a.itemId as string }));
        case "queue_jump_to":
          return nowait(handleUser({ t: "jump-to", itemId: a.itemId as string }));
        case "queue_move":
          return nowait(handleUser({ t: "move", itemId: a.itemId as string, up: a.up as boolean }));
        case "queue_reorder":
          return nowait(handleUser({ t: "reorder", from: a.from as number, to: a.to as number }));
        case "queue_clear_upcoming":
          return nowait(handleUser({ t: "clear-upcoming" }));
        case "queue_clear_all":
          return nowait(handleUser({ t: "clear-all" }));
        case "queue_set_shuffle":
          return nowait(handleUser({ t: "set-shuffle", enabled: a.enabled as boolean }));
        case "queue_set_repeat":
          return nowait(handleUser({ t: "set-repeat", mode: a.mode as RepeatMode }));
        case "queue_start":
          return nowait(
            handleUser({ t: "start", tracks: a.tracks as Track[], shuffle: a.shuffle as boolean }),
          );
        case "queue_save_as_playlist": {
          const title = String(a.title ?? "").trim();
          if (!title) throw new Error("title must not be empty");
          const view = queue.view();
          const tracks = [view.current?.track, ...view.upcoming.map((u) => u.track)].filter(
            (t): t is Track => !!t,
          );
          const pl = library.createPlaylist(title, null);
          if (tracks.length) library.addTracks(pl.id, tracks);
          return nowait(library.snapshot().playlists.find((p) => p.id === pl.id) ?? pl);
        }

        // ---- search + search history ----
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
          library.pushSearch(query);
          return nowait(results);
        }
        case "search_history_clear":
          return nowait(library.clearSearchHistory());
        case "search_history_remove":
          return nowait(library.removeSearch(String(a.query ?? "")));

        // ---- favorites ----
        case "favorites_toggle":
          return nowait(library.toggleLike(a.track as Track));

        // ---- playlists ----
        case "playlist_create": {
          const title = String(a.title ?? "").trim();
          if (!title) throw new Error("title must not be empty");
          const pl = library.createPlaylist(title, (a.description as string | null) ?? null);
          return nowait(library.snapshot().playlists.find((p) => p.id === pl.id) ?? pl);
        }
        case "playlist_rename": {
          const okRenamed = library.renamePlaylist(a.playlistId as string, String(a.title ?? ""));
          if (!okRenamed) throw new Error("playlist not found");
          return nowait(undefined);
        }
        case "playlist_set_description":
          return nowait(undefined);
        case "playlist_delete": {
          if (!library.deletePlaylist(a.playlistId as string)) throw new Error("playlist not found");
          return nowait(undefined);
        }
        case "playlist_duplicate": {
          const copy = library.duplicatePlaylist(a.playlistId as string, String(a.title ?? ""));
          if (!copy) throw new Error("playlist not found");
          return nowait(copy);
        }
        case "playlist_add_tracks": {
          const okAdded = library.addTracks(a.playlistId as string, a.tracks as Track[]);
          if (!okAdded) throw new Error("playlist not found");
          return nowait(undefined);
        }
        case "playlist_remove_track": {
          const okRemoved = library.removeTrack(a.playlistId as string, a.trackId as string);
          if (!okRemoved) throw new Error("track not in playlist");
          return nowait(undefined);
        }
        case "playlist_reorder_track": {
          const okMoved = library.reorderTrack(
            a.playlistId as string,
            a.from as number,
            a.to as number,
          );
          if (!okMoved) throw new Error("invalid reorder");
          return nowait(undefined);
        }
        case "playlist_tracks":
          return nowait(library.playlistTracksOf(a.playlistId as string));

        // ---- history ----
        case "history_clear":
          return nowait(library.clearHistory());
        case "history_remove":
          return nowait(library.removeHistoryEntry(a.entryId as string));

        // ---- lyrics ----
        case "get_lyrics": {
          const track = a.track as Track;
          if (track.id === "sample:3") {
            return nowait({
              synced: false,
              provider: "lrclib",
              lines: [],
              instrumental: true,
            } satisfies Lyrics);
          }
          const lrc = SAMPLE_LYRICS[track.id];
          const parsed = lrc ? parseLrc(lrc) : null;
          if (!parsed) return nowait(null);
          return nowait({ ...parsed, instrumental: false });
        }

        // ---- settings ----
        case "get_settings":
          return nowait({ ...settings });
        case "set_settings":
          saveSettings(a.settings as Settings);
          return nowait(undefined);

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
      if (event === "library://updated") queueMicrotask(() => fn(library.snapshot()));
      return () => set.delete(fn);
    },
  };

  // search history removal is handled above via MockLibrary.removeSearch.

  return bridge;
}

/** Exposed for tests: the mock library directly. */
export { MockLibrary };

/** Type re-export for the library snapshot used in tests. */
export type { LibraryData, PlaylistLite };
