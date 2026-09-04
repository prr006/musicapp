import { create } from 'zustand'
import { backend } from '../bridge/backend'
import type { AppState, PlayEvent, PlayStats, Playlist, Settings, Taste, Track } from '../bridge/types'
import { canonicalSongKey } from '../lib/radio'
import { defaultSettings } from '../lib/defaults'

export interface LibraryState {
  ready: boolean
  loadError: string | null
  settings: Settings
  liked: Track[]
  /** "Don't recommend" feedback; excluded from autoplay. */
  disliked: Track[]
  playlists: Playlist[]
  history: Taste['history']
  /** Bounded per-track listening statistics (play/complete/skip counts). */
  stats: Record<string, PlayStats>
  searchHistory: string[]
}

export const useLibraryStore = create<LibraryState>(() => ({
  ready: false,
  loadError: null,
  settings: defaultSettings(),
  liked: [],
  disliked: [],
  playlists: [],
  history: [],
  stats: {},
  searchHistory: [],
}))

const set = useLibraryStore.setState
const get = useLibraryStore.getState

/** Applies a taste payload (history + stats + dislikes) in one step. */
function applyTaste(taste: Taste | null | undefined): void {
  if (!taste) return
  set({
    history: taste.history ?? [],
    stats: taste.stats ?? {},
    disliked: taste.disliked ?? [],
  })
}

export const library = {
  hydrate(state: AppState): void {
    set({
      ready: true,
      loadError: null,
      settings: { ...defaultSettings(), ...state.settings },
      liked: state.liked ?? [],
      disliked: state.disliked ?? [],
      playlists: state.playlists ?? [],
      history: state.history ?? [],
      stats: state.stats ?? {},
      searchHistory: state.searchHistory ?? [],
    })
  },

  setLoadError(message: string): void {
    set({ ready: true, loadError: message })
  },

  isLiked(id: string): boolean {
    return get().liked.some((t) => t.id === id)
  },

  isDisliked(id: string): boolean {
    return get().disliked.some((t) => t.id === id)
  },

  async toggleLike(track: Track): Promise<void> {
    const liked = !library.isLiked(track.id)
    const wasDisliked = library.isDisliked(track.id)
    // Canonical identity: another upload of the same song (official video,
    // lyric video, Topic channel…) is the SAME liked song — the freshest
    // metadata wins and no duplicate library entry appears.
    const canonicalKey = canonicalSongKey(track)
    const canonicalDups = liked
      ? get().liked.filter((t) => t.id !== track.id && canonicalSongKey(t) === canonicalKey)
      : []
    // Optimistic: likes must feel instant. The backend result is authoritative.
    set((s) => ({
      liked: liked
        ? [{ ...track, addedAt: Date.now() }, ...s.liked.filter((t) => t.id !== track.id && canonicalSongKey(t) !== canonicalKey)]
        : s.liked.filter((t) => t.id !== track.id),
    }))
    const result = await backend().setLiked(track, liked)
    set({ liked: result ?? [] })
    // Retire the superseded uploads in the persistent store too.
    for (const dup of canonicalDups) {
      try {
        const merged = await backend().setLiked(dup, false)
        if (merged) set({ liked: merged })
      } catch {
        set((s) => ({ liked: s.liked.filter((t) => t.id !== dup.id) }))
      }
    }
    // Like and dislike are mutually exclusive intents.
    if (liked && wasDisliked) await library.setDisliked(track, false)
  },

  /**
   * "Don't recommend this song". Excluded from future autoplay and purged from
   * the current autoplay list (the playback controller watches this list).
   */
  async setDisliked(track: Track, disliked: boolean): Promise<void> {
    const wasLiked = library.isLiked(track.id)
    set((s) => ({
      disliked: disliked
        ? [{ ...track, addedAt: Date.now() }, ...s.disliked.filter((t) => t.id !== track.id)]
        : s.disliked.filter((t) => t.id !== track.id),
    }))
    try {
      const taste = await backend().setDisliked(track, disliked)
      applyTaste(taste)
    } catch {
      /* the optimistic list stands; taste sync retries on the next event */
    }
    // Disliking removes the like; the two never coexist.
    if (disliked && wasLiked) {
      try {
        const result = await backend().setLiked(track, false)
        set({ liked: result ?? [] })
      } catch {
        set((s) => ({ liked: s.liked.filter((t) => t.id !== track.id) }))
      }
    }
  },

  async saveSettings(patch: Partial<Settings>): Promise<void> {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    const saved = await backend().saveSettings(next)
    set({ settings: { ...defaultSettings(), ...saved } })
  },

  async recordPlay(track: Track): Promise<void> {
    await library.recordPlayEvent(track, 'play_started')
  },

  /** Records one listening event (started / significant / completed / skipped). */
  async recordPlayEvent(track: Track, event: PlayEvent): Promise<void> {
    try {
      const taste = await backend().recordPlayEvent(track, event)
      applyTaste(taste)
    } catch {
      /* history is best-effort; the error surfaces through the store */
    }
  },

  async clearHistory(): Promise<void> {
    await backend().clearHistory()
    set({ history: [], stats: {} })
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
