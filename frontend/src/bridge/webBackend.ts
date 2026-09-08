import type { Backend, RadioKind } from './backend'
import { APIClient } from './apiClient'
import type {
  AppState, Diagnostics, LyricsQuery, LyricsResult, PlayableSource, Playlist,
  PlayRecord, RadioSession, Recommendations, ResolverStatus, SearchResponse,
  Session, Settings, Track, UserIdentity,
} from './types'

interface ResolvedEntry {
  promise: Promise<PlayableSource>
  value?: PlayableSource
}

export function createWebBackend(baseURL = import.meta.env.VITE_MELO_API_URL || '/api/v1'): Backend {
  const api = new APIClient(baseURL)
  const playable = new Map<string, ResolvedEntry>()

  const resolve = (track: Track): Promise<PlayableSource> => {
    const existing = playable.get(track.id)
    if (existing?.value && existing.value.expiresAt > Date.now() + 30_000) return Promise.resolve(existing.value)
    if (existing && !existing.value) return existing.promise

    const entry: ResolvedEntry = { promise: Promise.resolve(null as unknown as PlayableSource) }
    entry.promise = api.send<PlayableSource>('POST', '/resolve', track)
      .then((source) => {
        const normalized = { ...source, url: api.absoluteURL(source.url) }
        entry.value = normalized
        return normalized
      })
      .catch((error) => {
        if (playable.get(track.id) === entry) playable.delete(track.id)
        throw error
      })
    playable.set(track.id, entry)
    return entry.promise
  }

  const radio = (kind: RadioKind, seedId: string, seed: Partial<Track> = {}) => {
    const params = new URLSearchParams()
    if (seed.title) params.set('title', seed.title)
    if (seed.artist) params.set('artist', seed.artist)
    if (seed.album) params.set('album', seed.album)
    const query = params.size ? `?${params}` : ''
    return api.get<RadioSession>(`/radio/${encodeURIComponent(kind)}/${encodeURIComponent(seedId)}${query}`)
  }

  return {
    isNative: false,
    getState: () => api.get<AppState>('/state'),
    getDiagnostics: () => api.get<Diagnostics>('/diagnostics'),
    search: (query, filter) => {
      const params = new URLSearchParams({ q: query })
      if (filter) params.set('filter', filter)
      return api.get<SearchResponse>(`/search?${params}`)
    },
    getPlayable: resolve,
    prefetchPlayable: async (track) => { await resolve(track) },
    invalidatePlayable: (trackId) => { playable.delete(trackId) },
    getLyrics: (query: LyricsQuery) => api.send<LyricsResult>('POST', '/lyrics', query),
    saveSettings: (settings: Settings) => api.send<Settings>('PUT', '/settings', settings),
    setLiked: (track: Track, liked: boolean) => api.send<Track[]>(liked ? 'POST' : 'DELETE', '/library/likes', track),
    recordPlay: (track: Track) => api.send<PlayRecord[]>('POST', '/history', track),
    clearHistory: () => api.send<void>('DELETE', '/history'),
    addSearchTerm: (term) => api.send<string[]>('POST', '/search-history', { term }),
    removeSearchTerm: (term) => api.request<string[]>(`/search-history?term=${encodeURIComponent(term)}`, { method: 'DELETE' }),
    clearSearchHistory: () => api.send<void>('DELETE', '/search-history'),
    libraryTracks: () => api.get<Track[]>('/library'),
    saveSession: (session: Session) => api.send<void>('PUT', '/session', session),
    clearSession: () => api.send<void>('DELETE', '/session'),
    createPlaylist: (name, tracks) => api.send<Playlist>('POST', '/playlists', { name, tracks }),
    renamePlaylist: (id, name) => api.send<Playlist>('PATCH', `/playlists/${encodeURIComponent(id)}`, { name }),
    deletePlaylist: (id) => api.send<void>('DELETE', `/playlists/${encodeURIComponent(id)}`),
    addTracksToPlaylist: (id, tracks) => api.send<Playlist>('POST', `/playlists/${encodeURIComponent(id)}/tracks`, { tracks }),
    removeTrackFromPlaylist: (id, index) => api.send<Playlist>('DELETE', `/playlists/${encodeURIComponent(id)}/tracks?index=${index}`),
    reorderPlaylist: (id, from, to) => api.send<Playlist>('PATCH', `/playlists/${encodeURIComponent(id)}/tracks`, { from, to }),
    duplicatePlaylist: (id) => api.send<Playlist>('POST', `/playlists/${encodeURIComponent(id)}/duplicate`),
    installResolver: async (): Promise<ResolverStatus> => (await api.get<Diagnostics>('/diagnostics')).resolver,
    setNowPlaying: async () => {},
    on: () => () => {},
    suggest: (query) => api.get<SearchResponse>(`/suggest?q=${encodeURIComponent(query)}`),
    radio,
    recommendations: () => api.get<Recommendations>('/recommendations'),
    getMe: () => api.get<UserIdentity>('/me'),
    login: (username, password) => api.send<UserIdentity>('POST', '/auth/login', { username, password }),
    register: (username, password) => api.send<UserIdentity>('POST', '/auth/register', { username, password }),
    logout: () => api.send<UserIdentity>('POST', '/auth/logout'),
  }
}
