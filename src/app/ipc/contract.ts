/**
 * The IPC contract (mirrors src-tauri/src/commands.rs + events.rs).
 * Full documentation: docs/IPC.md.
 */

import type {
  EngineStatusEvent,
  Lyrics,
  PlaybackSnapshot,
  PositionUpdate,
  QueueView,
  SearchResults,
  Settings,
  Track,
} from "@/types/domain";

export const Commands = {
  get_playback_state: null,
  get_queue: null,
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
  get_settings: null,
  set_settings: null,
  search: null,
  get_lyrics: null,
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
  set_settings: { settings: Settings };
  search: { query: string; limit?: number };
  get_lyrics: { trackId: string };
}

export interface CommandResult {
  get_playback_state: PlaybackSnapshot;
  get_queue: QueueView;
  get_settings: Settings;
  search: SearchResults;
  get_lyrics: Lyrics | null;
  [key: string]: unknown;
}

export const Events = {
  playbackState: "playback://state",
  playbackPosition: "playback://position",
  queueView: "queue://view",
  engineStatus: "engine://status",
} as const;

export type EventName = (typeof Events)[keyof typeof Events];

export interface EventPayloads {
  [Events.playbackState]: PlaybackSnapshot;
  [Events.playbackPosition]: PositionUpdate;
  [Events.queueView]: QueueView;
  [Events.engineStatus]: EngineStatusEvent;
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
