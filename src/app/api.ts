/**
 * Typed API facade over the IPC bridge. Components call these — never the
 * bridge directly — so the command surface stays auditable in one file.
 */

import { getBridge } from "@/app/ipc";
import type { CommandName } from "@/app/ipc";
import type { CommandArgs, CommandResult } from "@/app/ipc";
import type { Track } from "@/types/domain";

type WithArgs = { [K in keyof CommandArgs]: K }[keyof CommandArgs];

export async function call<K extends CommandName>(
  cmd: K,
  ...args: K extends WithArgs ? [CommandArgs[K]] : []
): Promise<K extends keyof CommandResult ? CommandResult[K] : void> {
  return getBridge().invoke(cmd, ...(args as never));
}

// ---- state ---------------------------------------------------------------

export const getPlaybackState = () => call("get_playback_state");
export const getQueue = () => call("get_queue");
export const getSettings = () => call("get_settings");
export const setSettings = (settings: CommandArgs["set_settings"]["settings"]) =>
  call("set_settings", { settings });
export const search = (query: string, limit?: number) => call("search", { query, limit });
export const getLyrics = (trackId: string) => call("get_lyrics", { trackId });

// ---- transport -----------------------------------------------------------

export const togglePlay = () => call("player_toggle_play");
export const play = () => call("player_play");
export const pause = () => call("player_pause");
export const stop = () => call("player_stop");
export const next = () => call("player_next");
export const previous = () => call("player_previous");
export const seekTo = (position: number) => call("player_seek_to", { position });
export const seekBy = (delta: number) => call("player_seek_by", { delta });
export const setVolume = (volume: number) => call("player_set_volume", { volume });
export const toggleMute = () => call("player_toggle_mute");
export const setSpeed = (speed: number) => call("player_set_speed", { speed });

// ---- queue ---------------------------------------------------------------

export const playNow = (track: Track) => call("queue_play_now", { track });
export const addToQueue = (tracks: Track[]) => call("queue_add", { tracks });
export const playNext = (tracks: Track[]) => call("queue_play_next", { tracks });
export const removeFromQueue = (itemId: string) => call("queue_remove", { itemId });
export const jumpTo = (itemId: string) => call("queue_jump_to", { itemId });
export const moveQueueItem = (itemId: string, up: boolean) => call("queue_move", { itemId, up });
export const reorderQueue = (from: number, to: number) => call("queue_reorder", { from, to });
export const clearUpcoming = () => call("queue_clear_upcoming");
export const clearQueue = () => call("queue_clear_all");
export const setShuffle = (enabled: boolean) => call("queue_set_shuffle", { enabled });
export const setRepeat = (mode: "off" | "all" | "one") => call("queue_set_repeat", { mode });
export const startSequence = (tracks: Track[], shuffle: boolean) =>
  call("queue_start", { tracks, shuffle });
