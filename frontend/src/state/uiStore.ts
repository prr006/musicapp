import { create } from 'zustand'

export type Route =
  | { name: 'home' }
  | { name: 'search' }
  | { name: 'library'; tab: 'songs' | 'albums' | 'artists' | 'playlists' | 'liked' | 'recent' | 'most-played' }
  | { name: 'playlist'; id: string }
  | { name: 'album'; key: string }
  | { name: 'artist'; artist: string }
  | { name: 'settings' }

export interface Toast {
  id: number
  message: string
  tone: 'info' | 'error'
}

export interface UIState {
  route: Route
  history: Route[]
  future: Route[]
  queueOpen: boolean
  nowPlayingOpen: boolean
  lyricsOpen: boolean
  toasts: Toast[]
  resolverError: string | null
  resolverProgress: { done: number; total: number } | null
}

export const useUIStore = create<UIState>(() => ({
  route: { name: 'home' },
  history: [],
  future: [],
  queueOpen: false,
  nowPlayingOpen: false,
  lyricsOpen: false,
  toasts: [],
  resolverError: null,
  resolverProgress: null,
}))

const set = useUIStore.setState
const get = useUIStore.getState

let toastId = 0

export const ui = {
  navigate(route: Route): void {
    const current = get().route
    const same = JSON.stringify(current) === JSON.stringify(route)
    // Navigating dismisses the expanded Now Playing (and its lyrics pane) so the
    // route is immediately visible — even when the target is the route the user
    // is already on, the click still reveals it. The queue drawer stays put.
    set({
      route,
      history: same ? get().history : [...get().history, current],
      future: [],
      nowPlayingOpen: false,
      lyricsOpen: false,
    })
  },
  back(): void {
    const { history, route, future } = get()
    if (history.length === 0) return
    const previous = history[history.length - 1]
    set({
      route: previous,
      history: history.slice(0, -1),
      future: [route, ...future],
      nowPlayingOpen: false,
      lyricsOpen: false,
    })
  },
  forward(): void {
    const { future, route, history } = get()
    if (future.length === 0) return
    set({
      route: future[0],
      future: future.slice(1),
      history: [...history, route],
      nowPlayingOpen: false,
      lyricsOpen: false,
    })
  },
  toggleQueue(open?: boolean): void {
    set({ queueOpen: open ?? !get().queueOpen })
  },
  toggleNowPlaying(open?: boolean): void {
    set({ nowPlayingOpen: open ?? !get().nowPlayingOpen })
  },
  toggleLyrics(open?: boolean): void {
    const next = open ?? !get().lyricsOpen
    set({ lyricsOpen: next, nowPlayingOpen: next ? true : get().nowPlayingOpen })
  },
  toast(message: string, tone: 'info' | 'error' = 'info'): void {
    const id = ++toastId
    set({ toasts: [...get().toasts, { id, message, tone }] })
    setTimeout(() => ui.dismissToast(id), tone === 'error' ? 6000 : 3200)
  },
  dismissToast(id: number): void {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  },
  setResolverError(message: string | null): void {
    set({ resolverError: message })
  },
  setResolverProgress(progress: { done: number; total: number } | null): void {
    set({ resolverProgress: progress })
  },
}
