/**
 * IPC contract: the exact command/event surface of the Rust layer.
 *
 * The native side is intentionally tiny (docs/IPC.md): the player is
 * libmpv, the queue lives in the frontend, and every event below carries
 * engine-authoritative data.
 */

import type {
  LibraryData,
  Lyrics,
  SearchResults,
  Settings,
  Track,
} from "@/types/domain";

export const Commands = {
  player_get_state: null,
  player_load: null,
  player_play: null,
  player_pause: null,
  player_toggle_play: null,
  player_stop: null,
  player_seek: null,
  player_set_volume: null,
  player_set_mute: null,
  player_set_speed: null,
  resolve_track: null,
  get_session: null,
  set_session: null,
  search: null,
  search_history_clear: null,
  search_history_remove: null,
  favorites_toggle: null,
  record_play: null,
  playlist_create: null,
  playlist_rename: null,
  playlist_set_description: null,
  playlist_delete: null,
  playlist_duplicate: null,
  playlist_add_tracks: null,
  playlist_remove_track: null,
  playlist_reorder_track: null,
  playlist_tracks: null,
  history_clear: null,
  history_remove: null,
  get_lyrics: null,
  get_settings: null,
  set_settings: null,
  get_diagnostics: null,
  repair_runtime: null,
  get_library: null,
} as const;

export type CommandName = keyof typeof Commands;

export interface CommandArgs {
  player_load: { url: string; startPaused?: boolean; startAt?: number | null };
  player_seek: { position: number };
  player_set_volume: { volume: number };
  player_set_mute: { muted: boolean };
  player_set_speed: { speed: number };
  resolve_track: { sourceId: string; quality?: string };
  set_session: { session: unknown };
  search: { query: string; limit?: number };
  search_history_remove: { query: string };
  favorites_toggle: { track: Track };
  playlist_create: { title: string; description?: string | null };
  playlist_rename: { playlistId: string; title: string };
  playlist_set_description: { playlistId: string; description: string | null };
  playlist_delete: { playlistId: string };
  playlist_duplicate: { playlistId: string; title: string };
  playlist_add_tracks: { playlistId: string; tracks: Track[] };
  playlist_remove_track: { playlistId: string; trackId: string };
  playlist_reorder_track: { playlistId: string; from: number; to: number };
  playlist_tracks: { playlistId: string };
  history_remove: { entryId: string };
  get_lyrics: { track: Track };
  set_settings: { settings: Settings };
}

export interface ResolvedMedia {
  url: string;
  isLocal: boolean;
  container: string | null;
  bitrateKbps: number | null;
}

export interface CommandResult {
  player_get_state: EngineStateIpc;
  player_load: number;
  player_play: void;
  player_pause: void;
  player_toggle_play: void;
  player_stop: void;
  player_seek: void;
  player_set_volume: void;
  player_set_mute: void;
  player_set_speed: void;
  resolve_track: ResolvedMedia;
  get_session: unknown;
  set_session: void;
  search: SearchResults;
  search_history_clear: void;
  search_history_remove: void;
  favorites_toggle: boolean;
  record_play: void;
  playlist_create: unknown;
  playlist_rename: void;
  playlist_set_description: void;
  playlist_delete: void;
  playlist_duplicate: unknown;
  playlist_add_tracks: void;
  playlist_remove_track: void;
  playlist_reorder_track: void;
  playlist_tracks: Track[];
  history_clear: void;
  history_remove: void;
  get_lyrics: Lyrics | null;
  get_settings: Settings;
  set_settings: void;
  get_diagnostics: DiagnosticsIpc;
  repair_runtime: void;
  get_library: LibraryDataIpc;
  [key: string]: unknown;
}

// ---- event payloads ---------------------------------------------------------

export interface EngineStateIpc {
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
  mpvVersion: string | null;
}

export interface DiagnosticsIpc {
  runtimeDir: string | null;
  libmpvPath: string | null;
  libmpvFound: boolean;
  engineRunning: boolean;
  mpvVersion: string | null;
  ytdlpFound: boolean;
  ytdlpPath: string | null;
  qualityLabel: string;
}

export type LibraryDataIpc = LibraryData;

export const Events = {
  playerState: "player://state",
  playerPosition: "player://position",
  playerEnd: "player://end",
  runtimeStatus: "runtime://status",
  libraryUpdated: "library://updated",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

export interface EventPayloads {
  [Events.playerState]: EngineStateIpc;
  [Events.playerPosition]: {
    positionSecs: number;
    durationSecs: number | null;
    epoch: number;
  };
  [Events.playerEnd]: {
    reason: "eof" | "stop" | "quit" | "error" | "redirect";
    error: string | null;
    epoch: number;
  };
  [Events.runtimeStatus]: { phase: "installing" | "ready" | "error"; message: string };
  [Events.libraryUpdated]: LibraryDataIpc;
}

/** Adapter-neutral IPC surface. */
export interface IpcBridge {
  readonly kind: "tauri" | "mock";
  invoke<K extends CommandName>(
    cmd: K,
    ...args: K extends keyof CommandArgs ? [CommandArgs[K]] : []
  ): Promise<K extends keyof CommandResult ? CommandResult[K] : void>;
  on<E extends EventName>(event: E, handler: (payload: EventPayloads[E]) => void): () => void;
}
