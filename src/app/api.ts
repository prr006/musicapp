/**
 * Typed API facade over the IPC bridge. Components call these — never the
 * bridge directly — so the entire command surface is auditable in one file.
 * Every function returns the backend's answer; errors propagate to callers
 * (views catch and toast them).
 */

import { getBridge } from "@/app/ipc";
import type { CommandArgs, CommandName, CommandResult } from "@/app/ipc";
import type { Track } from "@/types/domain";

export async function call<K extends CommandName>(
  cmd: K,
  ...args: unknown[]
): Promise<K extends keyof CommandResult ? CommandResult[K] : void> {
  const bridge = getBridge();
  // The runtime bridge is loosely typed; cast through it once, here.
  const invoke = bridge.invoke as (c: CommandName, ...a: unknown[]) => Promise<unknown>;
  return invoke(cmd, ...args) as Promise<K extends keyof CommandResult ? CommandResult[K] : void>;
}

// ---- state ---------------------------------------------------------------

export const getPlaybackState = () => call("get_playback_state");
export const getQueue = () => call("get_queue");
export const getLibrary = () => call("get_library");
export const getSettings = () => call("get_settings");
export const getDiagnostics = () => call("get_diagnostics");
export const setSettings = (settings: CommandArgs["set_settings"]["settings"]) =>
  call("set_settings", { settings });
export const search = (query: string, limit?: number) => call("search", { query, limit });
export const getLyrics = (track: Track) => call("get_lyrics", { track });

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
export const saveQueueAsPlaylist = (title: string) => call("queue_save_as_playlist", { title });

// ---- library: favorites ----------------------------------------------------

export const toggleFavorite = (track: Track) => call("favorites_toggle", { track });

// ---- library: playlists ----------------------------------------------------

export const createPlaylist = (title: string, description?: string | null) =>
  call("playlist_create", { title, description: description ?? null });
export const renamePlaylist = (playlistId: string, title: string) =>
  call("playlist_rename", { playlistId, title });
export const setPlaylistDescription = (playlistId: string, description: string | null) =>
  call("playlist_set_description", { playlistId, description });
export const deletePlaylist = (playlistId: string) => call("playlist_delete", { playlistId });
export const duplicatePlaylist = (playlistId: string, title: string) =>
  call("playlist_duplicate", { playlistId, title });
export const addTracksToPlaylist = (playlistId: string, tracks: Track[]) =>
  call("playlist_add_tracks", { playlistId, tracks });
export const removeTrackFromPlaylist = (playlistId: string, trackId: string) =>
  call("playlist_remove_track", { playlistId, trackId });
export const reorderPlaylistTrack = (playlistId: string, from: number, to: number) =>
  call("playlist_reorder_track", { playlistId, from, to });
export const playlistTracks = (playlistId: string) => call("playlist_tracks", { playlistId });

// ---- library: history + search history --------------------------------------

export const clearHistory = () => call("history_clear");
export const removeHistoryEntry = (entryId: string) => call("history_remove", { entryId });
export const clearSearchHistory = () => call("search_history_clear");
export const removeSearchHistory = (query: string) => call("search_history_remove", { query });
