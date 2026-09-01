/**
 * Public app API. Same function names as before the libmpv redesign; the
 * queue operations now route to the local controller (the queue is an
 * application concept), transport goes to the thin player commands.
 */

import { getBridge } from "@/app/ipc";
import type { CommandArgs } from "@/app/ipc/contract";
import { playbackController as controller } from "@/player/controller";
import type { SearchResults, Track } from "@/types/domain";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Thin forwarding helper; the bridge itself enforces the pairing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function call(cmd: string, arg?: unknown): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bridge: any = getBridge();
  return bridge.invoke(cmd, arg ?? {});
}

// ---- state ---------------------------------------------------------------
import type { LibraryData, Lyrics, PlaylistLite } from "@/types/domain";

export const getLibrary = (): Promise<LibraryData> => call("get_library");
export const getSettings = () => call("get_settings");
export const getDiagnostics = (): Promise<import("@/types/domain").Diagnostics> =>
  call("get_diagnostics");
export const repairRuntime = (): Promise<void> => call("repair_runtime");
export const setSettings = (settings: CommandArgs["set_settings"]["settings"]) =>
  call("set_settings", { settings });
export const search = (query: string, limit?: number): Promise<SearchResults> => call("search", { query, limit });
export const getLyrics = (track: Track): Promise<Lyrics | null> => call("get_lyrics", { track });

// ---- transport (libmpv) ----------------------------------------------------
export const play = () => call("player_play");
export const pause = () => call("player_pause");
export const togglePlay = () => controller.togglePlay();
export const stop = () => call("player_stop");
export const next = () => controller.next();
export const previous = () => controller.previous();
export const seekTo = (position: number) => controller.seekTo(position);
export const seekBy = (delta: number) => controller.seekBy(delta);
export const setVolume = (volume: number) => controller.setVolume(volume);
export const toggleMute = () => controller.toggleMute();
export const setSpeed = (speed: number) => controller.setSpeed(speed);

// ---- queue (application-level, in-process) ----------------------------------
export const playNow = (track: Track) => controller.playNow(track);
export const addToQueue = (tracks: Track[]) => controller.addToQueue(tracks);
export const playNext = (tracks: Track[]) => controller.playNext(tracks);
export const removeFromQueue = (itemId: string) => controller.removeFromQueue(itemId);
export const jumpTo = (itemId: string) => controller.jumpTo(itemId);
export const moveQueueItem = (itemId: string, up: boolean) => controller.moveQueueItem(itemId, up);
export const reorderQueue = (from: number, to: number) => controller.reorderQueue(from, to);
export const clearUpcoming = () => controller.clearUpcoming();
export const clearQueue = () => controller.clearQueue();
export const setShuffle = (enabled: boolean) => controller.setShuffle(enabled);
export const setRepeat = (mode: "off" | "all" | "one") => controller.setRepeat(mode);
export const startSequence = (tracks: Track[], shuffle: boolean) =>
  controller.startSequence(tracks, shuffle);
export const saveQueueAsPlaylist = async (title: string): Promise<void> => {
  const tracks = controller.queueTracks();
  const pl = await call("playlist_create", { title });
  if (tracks.length > 0 && pl && typeof pl === "object" && "id" in pl) {
    await call("playlist_add_tracks", {
      playlistId: String((pl as { id: string }).id),
      tracks,
    });
  }
};

// search typed helper (SearchResults carries the query for the UI)
export async function searchTracks(query: string, limit?: number): Promise<SearchResults> {
  return search(query, limit);
}

// ---- library helpers -------------------------------------------------------
export const toggleFavorite = (track: Track): Promise<boolean> => call("favorites_toggle", { track });
export const recordPlay = (track: Track): Promise<void> => call("record_play", { track });
export const clearSearchHistory = (): Promise<void> => call("search_history_clear");
export const removeSearchHistoryEntry = (query: string) =>
  call("search_history_remove", { query });
export const createPlaylist = (
  title: string,
  description?: string | null,
): Promise<PlaylistLite> => call("playlist_create", { title, description: description ?? null });
export const addTracksToPlaylist = (playlistId: string, tracks: Track[]): Promise<void> =>
  call("playlist_add_tracks", { playlistId, tracks });
export const deletePlaylist = (playlistId: string) => call("playlist_delete", { playlistId });
export const renamePlaylist = (playlistId: string, title: string) =>
  call("playlist_rename", { playlistId, title });
export const playlistTracks = (playlistId: string): Promise<Track[]> => call("playlist_tracks", { playlistId });
export const addToPlaylist = (playlistId: string, tracks: Track[]) =>
  call("playlist_add_tracks", { playlistId, tracks });
export const removeFromPlaylist = (playlistId: string, trackId: string) =>
  call("playlist_remove_track", { playlistId, trackId });
export const clearHistory = (): Promise<void> => call("history_clear");
export const removeHistoryEntry = (entryId: string): Promise<void> => call("history_remove", { entryId });
export const duplicatePlaylist = (playlistId: string, title: string): Promise<PlaylistLite> =>
  call("playlist_duplicate", { playlistId, title });
export const removeTrackFromPlaylist = (playlistId: string, trackId: string): Promise<void> =>
  call("playlist_remove_track", { playlistId, trackId });
export const reorderPlaylistTrack = (playlistId: string, from: number, to: number): Promise<void> =>
  call("playlist_reorder_track", { playlistId, from, to });
export const setPlaylistDescription = (playlistId: string, description: string | null): Promise<void> =>
  call("playlist_set_description", { playlistId, description });
