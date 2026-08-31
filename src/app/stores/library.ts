/**
 * Library store — caches the `LibraryData` document delivered by
 * `library://updated` / `get_library`. The Rust LibraryStore is authoritative;
 * the frontend only mirrors and selects.
 */

import { createStore, useStore } from "@/app/store";
import type { LibraryData, PlaylistLite, Track } from "@/types/domain";

export const libraryStore = createStore<{ data: LibraryData | null }>({ data: null });

export function onLibraryUpdated(data: LibraryData): void {
  libraryStore.set({ data });
}

export function useLibrary(): LibraryData | null {
  return useStore(libraryStore, (s) => s.data);
}

const NO_TRACKS: Track[] = [];
const NO_PLAYLISTS: PlaylistLite[] = [];
const NO_SEARCH: string[] = [];

export function useLiked(): Track[] {
  return useStore(libraryStore, (s) => s.data?.liked ?? NO_TRACKS);
}

export function usePlaylists(): PlaylistLite[] {
  return useStore(libraryStore, (s) => s.data?.playlists ?? NO_PLAYLISTS);
}

export function useSearchHistory(): string[] {
  return useStore(libraryStore, (s) => s.data?.searchHistory ?? NO_SEARCH);
}

export function isLiked(
  data: LibraryData | Track[] | null,
  trackId: string | null | undefined,
): boolean {
  if (!data || !trackId) return false;
  const liked = Array.isArray(data) ? data : data.liked;
  return liked.some((t) => t.id === trackId);
}
