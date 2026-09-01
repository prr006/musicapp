import { create } from 'zustand'
import { backend } from '../bridge/backend'
import type { AppState, PlayRecord, Playlist, Settings, Track } from '../bridge/types'
import { defaultSettings } from '../lib/defaults'

export interface LibraryState {
  ready: boolean
  loadError: string | null
  settings: Settings
  liked: Track[]
  playlists: Playlist[]
  history: PlayRecord[]
  searchHistory: string[]
}

export const useLibraryStore = create<LibraryState>(() => ({
  ready: false,
  loadError: null,
  settings: defaultSettings(),
  liked: [],
  playlists: [],
  history: [],
  searchHistory: [],
}))

const set = useLibraryStore.setState
const get = useLibraryStore.getState

export const library = {
  hydrate(state: AppState): void {
    set({
      ready: true,
      loadError: null,
      settings: { ...defaultSettings(), ...state.settings },
      liked: state.liked ?? [],
      playlists: state.playlists ?? [],
      history: state.history ?? [],
      searchHistory: state.searchHistory ?? [],
    })
  },

  setLoadError(message: string): void {
    set({ ready: true, loadError: message })
  },

  isLiked(id: string): boolean {
    return get().liked.some((t) => t.id === id)
  },

  async toggleLike(track: Track): Promise<void> {
    const liked = !library.isLiked(track.id)
    // Optimistic: likes must feel instant. The backend result is authoritative.
    set((s) => ({
      liked: liked ? [{ ...track, addedAt: Date.now() }, ...s.liked] : s.liked.filter((t) => t.id !== track.id),
    }))
    const result = await backend().setLiked(track, liked)
    set({ liked: result ?? [] })
  },

  async saveSettings(patch: Partial<Settings>): Promise<void> {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    const saved = await backend().saveSettings(next)
    set({ settings: { ...defaultSettings(), ...saved } })
  },

  async recordPlay(track: Track): Promise<void> {
    const history = await backend().recordPlay(track)
    set({ history: history ?? [] })
  },

  async clearHistory(): Promise<void> {
    await backend().clearHistory()
    set({ history: [] })
  },

  async addSearchTerm(term: string): Promise<void> {
    const next = await backend().addSearchTerm(term)
    set({ searchHistory: next ?? [] })
  },

  async removeSearchTerm(term: string): Promise<void> {
    const next = await backend().removeSearchTerm(term)
    set({ searchHistory: next ?? [] })
  },

  async clearSearchHistory(): Promise<void> {
    await backend().clearSearchHistory()
    set({ searchHistory: [] })
  },

  async createPlaylist(name: string, tracks: Track[] = []): Promise<Playlist> {
    const pl = await backend().createPlaylist(name, tracks)
    set((s) => ({ playlists: [...s.playlists, pl] }))
    return pl
  },

  async renamePlaylist(id: string, name: string): Promise<void> {
    const pl = await backend().renamePlaylist(id, name)
    library.replacePlaylist(pl)
  },

  async deletePlaylist(id: string): Promise<void> {
    await backend().deletePlaylist(id)
    set((s) => ({ playlists: s.playlists.filter((p) => p.id !== id) }))
  },

  async addToPlaylist(id: string, tracks: Track[]): Promise<void> {
    const pl = await backend().addTracksToPlaylist(id, tracks)
    library.replacePlaylist(pl)
  },

  async removeFromPlaylist(id: string, index: number): Promise<void> {
    const pl = await backend().removeTrackFromPlaylist(id, index)
    library.replacePlaylist(pl)
  },

  async reorderPlaylist(id: string, from: number, to: number): Promise<void> {
    const pl = await backend().reorderPlaylist(id, from, to)
    library.replacePlaylist(pl)
  },

  async duplicatePlaylist(id: string): Promise<Playlist> {
    const pl = await backend().duplicatePlaylist(id)
    set((s) => ({ playlists: [...s.playlists, pl] }))
    return pl
  },

  replacePlaylist(pl: Playlist): void {
    set((s) => ({ playlists: s.playlists.map((p) => (p.id === pl.id ? pl : p)) }))
  },
}
