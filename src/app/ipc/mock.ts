/**
 * Mock bridge for the BROWSER preview and frontend tests.
 *
 * It mocks ONLY the native boundary (libmpv engine + yt-dlp + persistence),
 * which is explicitly allowed: domain behavior (queue, EOF semantics,
 * playback flow) lives in the frontend and is tested against its REAL
 * implementation with this bridge as the scripted native edge.
 *
 * The fake engine is deliberately dumb and honest: it ticks position
 * forward while "playing", emits real end-of-file at the duration, and
 * reports stop as stop. No queue logic here — that's the controller's job.
 */

import type {
  CommandArgs,
  CommandName,
  EngineStateIpc,
  EventPayloads,
  EventName,
  IpcBridge,
} from "./contract";
import type { Track } from "@/types/domain";
import { MockLibrary } from "./mockLibrary";
import { SAMPLE_TRACKS as sampleTracks, SAMPLE_LYRICS } from "./sampleData";

type Handler<E extends EventName> = (payload: EventPayloads[E]) => void;

interface FakeEngine {
  timer: ReturnType<typeof setInterval> | null;
  state: EngineStateIpc;
}

export function createMockBridge(): IpcBridge {
  const library = new MockLibrary();
  const listeners = new Map<EventName, Set<Handler<never>>>();
  library.subscribe(() => {
    emit("library://updated", library.snapshot());
  });
  let sessionStore: unknown = null;
  let mockSettings = { volume: 80 };

  const engine: FakeEngine = {
    timer: null,
    state: {
      status: "idle",
      positionSecs: 0,
      durationSecs: null,
      paused: false,
      buffering: false,
      seeking: false,
      speed: 1,
      volume: 80,
      muted: false,
      epoch: 0,
      mpvVersion: "mock libmpv",
    },
  };

  function emit<E extends EventName>(event: E, payload: EventPayloads[E]): void {
    for (const h of listeners.get(event) ?? []) {
      (h as Handler<E>)(payload);
    }
  }

  function publishState(): void {
    emit("player://state", { ...engine.state });
  }

  function tick(): void {
    const s = engine.state;
    if (s.status !== "playing") return;
    s.positionSecs = Math.min(s.positionSecs + 0.25 * s.speed, s.durationSecs ?? s.positionSecs);
    emit("player://position", {
      positionSecs: s.positionSecs,
      durationSecs: s.durationSecs,
      epoch: s.epoch,
    });
    if (s.durationSecs != null && s.positionSecs >= s.durationSecs) {
      // Natural EOF — same contract as the real engine.
      stopTimer();
      s.status = "ended";
      publishState();
      emit("player://end", { reason: "eof", error: null, epoch: s.epoch });
    }
  }

  function stopTimer(): void {
    if (engine.timer != null) {
      clearInterval(engine.timer);
      engine.timer = null;
    }
  }

  function startTimer(): void {
    stopTimer();
    engine.timer = setInterval(tick, 250);
  }

  function invoke<K extends CommandName>(
    cmd: K,
    ...args: K extends keyof CommandArgs ? [CommandArgs[K]] : []
  ): Promise<unknown> {
    const a = (args[0] ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "player_get_state":
        return nowait({ ...engine.state });
      case "player_load": {
        engine.state.epoch += 1;
        engine.state.status = "loading";
        engine.state.positionSecs =
          typeof a.startAt === "number" ? (a.startAt as number) : 0;
        engine.state.durationSecs = 180;
        engine.state.paused = a.startPaused === true;
        engine.state.status = a.startPaused === true ? "paused" : "playing";
        publishState();
        emit("player://position", {
          positionSecs: engine.state.positionSecs,
          durationSecs: engine.state.durationSecs,
          epoch: engine.state.epoch,
        });
        if (engine.state.status === "playing") startTimer();
        return nowait(engine.state.epoch);
      }
      case "player_play":
        engine.state.paused = false;
        engine.state.status = "playing";
        publishState();
        startTimer();
        return nowait(undefined);
      case "player_pause":
        engine.state.paused = true;
        engine.state.status = "paused";
        publishState();
        stopTimer();
        return nowait(undefined);
      case "player_toggle_play":
        if (engine.state.status === "playing") {
          return invoke("player_pause");
        }
        return invoke("player_play");
      case "player_stop":
        stopTimer();
        engine.state.status = "idle";
        publishState();
        emit("player://end", { reason: "stop", error: null, epoch: engine.state.epoch });
        return nowait(undefined);
      case "player_seek":
        engine.state.positionSecs = Math.max(0, a.position as number);
        publishState();
        emit("player://position", {
          positionSecs: engine.state.positionSecs,
          durationSecs: engine.state.durationSecs,
          epoch: engine.state.epoch,
        });
        return nowait(undefined);
      case "player_set_volume":
        engine.state.volume = a.volume as number;
        publishState();
        return nowait(undefined);
      case "player_set_mute":
        engine.state.muted = a.muted as boolean;
        publishState();
        return nowait(undefined);
      case "player_set_speed":
        engine.state.speed = a.speed as number;
        publishState();
        return nowait(undefined);
      case "resolve_track": {
        const id = String(a.sourceId ?? "");
        if (!id) return Promise.reject(new Error("invalid input"));
        return nowait({
          url: `mock://media/${id}`,
          isLocal: false,
          container: "m4a",
          bitrateKbps: 128,
        });
      }
      case "get_session":
        return nowait(sessionStore);
      case "set_session":
        sessionStore = a.session as unknown;
        return nowait(undefined);
      case "search": {
        const q = String(a.query ?? "").toLowerCase();
        const hits = sampleTracks
          .filter((t) => `${t.title} ${t.artists.map((a) => a.name).join(" ")}`.toLowerCase().includes(q))
          .slice(0, (a.limit as number) ?? 25);
        if (hits.length === 0) hits.push(...sampleTracks.slice(0, 4));
        return nowait({
          tracks: hits,
          artists: [],
          albums: [],
          playlists: [],
          query: a.query ?? "",
        });
      }
      case "get_library":
        return nowait(library.snapshot());
      case "get_diagnostics":
        return nowait({
          runtimeDir: "mock://runtime/bin",
          libmpvPath: "mock://runtime/bin/libmpv-2.dll",
          libmpvFound: true,
          engineRunning: true,
          mpvVersion: "mock libmpv",
          ytdlpFound: true,
          ytdlpPath: "mock://runtime/bin/yt-dlp.exe",
          qualityLabel: "Mock · ≤128 kbps",
        });
      case "repair_runtime":
        emit("runtime://status", {
          phase: "ready",
          message: "Runtime ready (mock).",
        });
        return nowait(undefined);
      case "favorites_toggle":
        return nowait(library.toggleLike(a.track as Track));
      case "record_play":
        library.recordPlay(a.track as Track);
        return nowait(undefined);
      case "playlist_create":
        return nowait(
          library.createPlaylist(String(a.title), (a.description as string) ?? null),
        );
      case "playlist_rename":
        if (!library.renamePlaylist(String(a.playlistId), String(a.title)))
          return Promise.reject(new Error("playlist not found"));
        return nowait(undefined);
      case "playlist_set_description":
        return nowait(undefined);
      case "playlist_delete":
        if (!library.deletePlaylist(String(a.playlistId)))
          return Promise.reject(new Error("playlist not found"));
        return nowait(undefined);
      case "playlist_duplicate": {
        const dup = library.duplicatePlaylist(String(a.playlistId), String(a.title));
        return dup ? nowait(dup) : Promise.reject(new Error("playlist not found"));
      }
      case "playlist_add_tracks":
        library.addTracks(String(a.playlistId), a.tracks as Track[]);
        return nowait(undefined);
      case "playlist_remove_track":
        library.removeTrack(String(a.playlistId), String(a.trackId));
        return nowait(undefined);
      case "playlist_reorder_track":
        library.reorderTrack(String(a.playlistId), a.from as number, a.to as number);
        return nowait(undefined);
      case "playlist_tracks":
        return nowait(library.playlistTracksOf(String(a.playlistId)));
      case "history_clear":
        library.clearHistory();
        return nowait(undefined);
      case "history_remove":
        library.removeHistoryEntry(String(a.entryId));
        return nowait(undefined);
      case "search_history_clear":
        library.clearSearchHistory();
        return nowait(undefined);
      case "search_history_remove":
        library.removeSearch(String(a.query));
        return nowait(undefined);
      case "get_settings":
        return nowait(mockSettings);
      case "set_settings":
        mockSettings = { ...mockSettings, ...(a.settings as object) };
        return nowait(undefined);
      case "get_lyrics": {
        const track = a.track as Track;
        const lrc = SAMPLE_LYRICS[track.id] ?? null;
        if (!lrc) return nowait(null);
        const lines = lrc
          .split("\n")
          .map((line) => {
            const m = /^\[(\d+):(\d+(?:\.\d+)?)\](.*)$/.exec(line);
            if (!m) return { timeMs: null, text: line };
            return {
              timeMs: (Number(m[1]) * 60 + Number(m[2])) * 1000,
              text: m[3],
            };
          })
          .filter((l) => l.text.length > 0);
        return nowait({ synced: lines.some((l) => l.timeMs != null), lines, offsetMs: 0 });
      }
      default:
        return Promise.reject(new Error(`mock: unsupported command ${String(cmd)}`));
    }
  }


  return {
    kind: "mock",
    invoke: invoke as unknown as IpcBridge["invoke"],
    on(event, handler) {
      const set = listeners.get(event) ?? new Set();
      set.add(handler as Handler<never>);
      listeners.set(event, set);
      return () => set.delete(handler as Handler<never>);
    },
  };
}

function nowait<T>(value: T): Promise<T> {
  return Promise.resolve(value);
}
