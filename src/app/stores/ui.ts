/**
 * UI-only state: navigation, panels, settings, toasts, online status.
 * (Never playback truth — that lives in playback.ts stores.)
 */

import { createStore, useStore } from "@/app/store";
import { DEFAULT_SETTINGS, type Settings } from "@/types/domain";

export type ViewKey =
  | "home"
  | "search"
  | "liked"
  | "songs"
  | "albums"
  | "artists"
  | "playlists"
  | "recently-played";

export interface Toast {
  id: number;
  message: string;
  tone: "info" | "error" | "success";
}

interface UiState {
  view: ViewKey;
  searchQuery: string;
  queueOpen: boolean;
  nowPlayingOpen: boolean;
  settingsOpen: boolean;
  settings: Settings;
  online: boolean;
  toasts: Toast[];
  /** Playlist drill-down inside the Playlists view. */
  openPlaylistId: string | null;
}

export const uiStore = createStore<UiState>({
  view: "home",
  searchQuery: "",
  queueOpen: false,
  nowPlayingOpen: false,
  settingsOpen: false,
  settings: { ...DEFAULT_SETTINGS },
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  toasts: [],
  openPlaylistId: null,
});

let toastSeq = 1;

export function pushToast(message: string, tone: Toast["tone"] = "info"): void {
  const id = toastSeq++;
  uiStore.set((s) => ({ toasts: [...s.toasts, { id, message, tone }] }));
  setTimeout(() => dismissToast(id), tone === "error" ? 6000 : 3200);
}

export function dismissToast(id: number): void {
  uiStore.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

export function navigate(view: ViewKey): void {
  uiStore.set({ view, nowPlayingOpen: false });
}

export function setSearchQuery(query: string): void {
  uiStore.set({ searchQuery: query, view: query.trim() ? "search" : uiStore.get().view === "search" ? "home" : uiStore.get().view });
}

export function openNowPlaying(open = true): void {
  uiStore.set({ nowPlayingOpen: open });
}

export function toggleQueue(): void {
  uiStore.set((s) => ({ queueOpen: !s.queueOpen }));
}

export function applySettings(settings: Settings): void {
  uiStore.set({ settings });
}

export function useUi(): UiState {
  return useStore(uiStore, (s) => s);
}

export function useSettings(): Settings {
  return useStore(uiStore, (s) => s.settings);
}

export function openPlaylist(id: string | null): void {
  uiStore.set({ openPlaylistId: id });
}

/** Close every overlay (used by Escape and route changes). */
export function closeOverlays(): void {
  uiStore.set({ nowPlayingOpen: false, queueOpen: false, settingsOpen: false });
}
