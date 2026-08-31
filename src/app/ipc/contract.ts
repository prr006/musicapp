/**
 * The IPC contract (mirrors src-tauri/src/commands.rs + events.rs).
 * Full documentation: docs/IPC.md.
 */

import type {
  Diagnostics,
  LibraryData,
  Lyrics,
  PlaybackSnapshot,
  PlaylistLite,
  PositionUpdate,
  QueueView,
  SearchResults,
  Settings,
  Track,
} from "@/types/domain";

export const Commands = {
  get_playback_state: null,
  get_queue: null,
  get_library: null,
  player_toggle_play: null,
  player_play: null,
  player_pause: null,
  player_stop: null,
  player_next: null,
  player_previous: null,
  player_seek_to: null,
  player_seek_by: null,
  player_set_volume: null,
  player_toggle_mute: null,
  player_set_speed: null,
  queue_play_now: null,
  queue_add: null,
  queue_play_next: null,
  queue_remove: null,
  queue_jump_to: null,
  queue_move: null,
  queue_reorder: null,
  queue_clear_upcoming: null,
  queue_clear_all: null,
  queue_set_shuffle: null,
  queue_set_repeat: null,
  queue_start: null,
  queue_save_as_playlist: null,
  search: null,
  search_history_clear: null,
  search_history_remove: null,
  favorites_toggle: null,
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
} as const;

export type CommandName = keyof typeof Commands;

export interface CommandArgs {
  player_seek_to: { position: number };
  player_seek_by: { delta: number };
  player_set_volume: { volume: number };
  player_set_speed: { speed: number };
  queue_play_now: { track: Track };
  queue_add: { tracks: Track[] };
  queue_play_next: { tracks: Track[] };
  queue_remove: { itemId: string };
  queue_jump_to: { itemId: string };
  queue_move: { itemId: string; up: boolean };
  queue_reorder: { from: number; to: number };
  queue_set_shuffle: { enabled: boolean };
  queue_set_repeat: { mode: "off" | "all" | "one" };
  queue_start: { tracks: Track[]; shuffle: boolean };
  queue_save_as_playlist: { title: string };
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

export interface CommandResult {
  get_playback_state: PlaybackSnapshot;
  get_queue: QueueView;
  get_library: LibraryData;
  get_settings: Settings;
  get_diagnostics: Diagnostics;
  get_lyrics: Lyrics | null;
  search: SearchResults;
  playlist_create: PlaylistLite;
  playlist_duplicate: PlaylistLite;
  queue_save_as_playlist: PlaylistLite;
  playlist_tracks: Track[];
  favorites_toggle: boolean;
  [key: string]: unknown;
}

export const Events = {
  playbackState: "playback://state",
  playbackPosition: "playback://position",
  queueView: "queue://view",
  engineStatus: "engine://status",
  libraryUpdated: "library://updated",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

export interface EventPayloads {
  [Events.playbackState]: PlaybackSnapshot;
  [Events.playbackPosition]: PositionUpdate;
  [Events.queueView]: QueueView;
  [Events.engineStatus]: { health: "starting" | "running" | "restarting" | "dead"; message: string };
  [Events.libraryUpdated]: LibraryData;
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
