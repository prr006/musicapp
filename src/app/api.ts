/**
 * Public app API. Transport goes to the thin player commands (libmpv);
 * queue operations route to the local controller (the queue is an
 * application concept).
 */

import { getBridge } from "@/app/ipc";
import type { CommandArgs, CommandName } from "@/app/ipc/contract";
import { playbackController as controller } from "@/player/controller";
import type { LibraryData, Lyrics, PlaylistLite, SearchResults, Track } from "@/types/domain";

/** Typed-name IPC invoke (the bridge enforces command-name pairing). */
export function call(cmd: CommandName, arg?: unknown): Promise<unknown> {
  const bridge: {
    invoke: (cmd: CommandName, arg?: unknown) => Promise<unknown>;
  } = getBridge() as unknown as {
    invoke: (cmd: CommandName, arg?: unknown) => Promise<unknown>;
  };
  return bridge.invoke(cmd, arg ?? {});
}

// ---- state ---------------------------------------------------------------

export const getLibrary = (): Promise<LibraryData> =>
  call("get_library") as Promise<LibraryData>;
export const getSettings = () => call("get_settings");
export const getDiagnostics = () => call("get_diagnostics");
export const repairRuntime = (): Promise<void> => call("repair_runtime") as Promise<void>;
export const setSettings = (settings: CommandArgs["set_settings"]["settings"]) =>
  call("set_settings", { settings });
export const search = (query: string, limit?: number): Promise<SearchResults> =>
  call("search", { query, limit }) as Promise<SearchResults>;
export const getLyrics = (track: Track): Promise<Lyrics | null> =>
  call("get_lyrics", { track }) as Promise<Lyrics | null>;

// ---- transport (libmpv) ----------------------------------------------------

export const togglePlay = () => controller.togglePlay();
export const stop = () => controller.stop();
export const next = () => controller.next();
export const previous = () => controller.previous();
export const seekTo = (position: number) => controller.seekTo(position);
export const seekBy = (delta: number) => controller.seekBy(delta);
export const setVolume = (volume: number) => controller.setVolume(volume);
export const toggleMute = () => controller.toggleMute();
export const setSpeed = (speed: number) => controller.setSpeed(speed);
export const setNormalization = (on: boolean) => controller.setNormalization(on);

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
export const shuffleUpcoming = () => controller.shuffleUpcoming();
export const startSequence = (tracks: Track[], shuffle: boolean) =>
  controller.startSequence(tracks, shuffle);
export const saveQueueAsPlaylist = async (title: string): Promise<void> => {
  const tracks = controller.queueTracks();
  const pl = (await call("playlist_create", { title })) as PlaylistLite | undefined;
  if (tracks.length > 0 && pl && typeof pl === "object" && "id" in pl) {
    await call("playlist_add_tracks", { playlistId: pl.id, tracks });
  }
};

// ---- library helpers -------------------------------------------------------

export const toggleFavorite = (track: Track): Promise<boolean> =>
  call("favorites_toggle", { track }) as Promise<boolean>;
export const clearSearchHistory = (): Promise<void> => call("search_history_clear") as Promise<void>;
export const removeSearchHistoryEntry = (query: string) =>
  call("search_history_remove", { query });
export const createPlaylist = (
  title: string,
  description?: string | null,
): Promise<PlaylistLite> =>
  call("playlist_create", { title, description: description ?? null }) as Promise<PlaylistLite>;
export const addTracksToPlaylist = (playlistId: string, tracks: Track[]): Promise<void> =>
  call("playlist_add_tracks", { playlistId, tracks }) as Promise<void>;
export const deletePlaylist = (playlistId: string) =>
  call("playlist_delete", { playlistId });
export const renamePlaylist = (playlistId: string, title: string) =>
  call("playlist_rename", { playlistId, title });
export const playlistTracks = (playlistId: string): Promise<Track[]> =>
  call("playlist_tracks", { playlistId }) as Promise<Track[]>;
export const removeFromPlaylist = (playlistId: string, trackId: string): Promise<void> =>
  call("playlist_remove_track", { playlistId, trackId }) as Promise<void>;
/** Alias kept for the playlist detail view. */
export const removeTrackFromPlaylist = removeFromPlaylist;
export const clearHistory = (): Promise<void> => call("history_clear") as Promise<void>;
export const removeHistoryEntry = (entryId: string): Promise<void> =>
  call("history_remove", { entryId }) as Promise<void>;
export const duplicatePlaylist = (playlistId: string, title: string): Promise<PlaylistLite> =>
  call("playlist_duplicate", { playlistId, title }) as Promise<PlaylistLite>;
export const reorderPlaylistTrack = (playlistId: string, from: number, to: number): Promise<void> =>
  call("playlist_reorder_track", { playlistId, from, to }) as Promise<void>;
export const setPlaylistDescription = (
  playlistId: string,
  description: string | null,
): Promise<void> =>
  call("playlist_set_description", { playlistId, description }) as Promise<void>;
