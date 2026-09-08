/**
 * Stable frontend contract. Views, stores and playback code depend only on this
 * interface; Wails bindings and HTTP details live in separate adapters.
 */
import type {
  AppState, Diagnostics, LyricsQuery, LyricsResult, PlayableSource, Playlist,
  PlayRecord, RadioSession, Recommendations, ResolverStatus, SearchResponse,
  Session, Settings, Track, UserIdentity,
} from './types'

export type RadioKind = 'song' | 'artist' | 'album' | 'playlist' | 'liked' | 'library'

export interface Backend {
  getState(): Promise<AppState>
  getDiagnostics(): Promise<Diagnostics>
  search(query: string, filter: string): Promise<SearchResponse>
  getPlayable(track: Track): Promise<PlayableSource>
  getLyrics(query: LyricsQuery): Promise<LyricsResult>
  saveSettings(settings: Settings): Promise<Settings>
  setLiked(track: Track, liked: boolean): Promise<Track[]>
  recordPlay(track: Track): Promise<PlayRecord[]>
  clearHistory(): Promise<void>
  addSearchTerm(term: string): Promise<string[]>
  removeSearchTerm(term: string): Promise<string[]>
  clearSearchHistory(): Promise<void>
  libraryTracks(): Promise<Track[]>
  saveSession(session: Session): Promise<void>
  clearSession(): Promise<void>
  createPlaylist(name: string, tracks: Track[]): Promise<Playlist>
  renamePlaylist(id: string, name: string): Promise<Playlist>
  deletePlaylist(id: string): Promise<void>
  addTracksToPlaylist(id: string, tracks: Track[]): Promise<Playlist>
  removeTrackFromPlaylist(id: string, index: number): Promise<Playlist>
  reorderPlaylist(id: string, from: number, to: number): Promise<Playlist>
  duplicatePlaylist(id: string): Promise<Playlist>
  installResolver(): Promise<ResolverStatus>
  /** Mirrors metadata to native desktop integration; a no-op on web. */
  setNowPlaying(title: string, artist: string): Promise<void>
  on(event: string, cb: (...args: unknown[]) => void): () => void
  isNative: boolean

  // Hosted capabilities are optional so the unchanged desktop API remains
  // compatible. Playback uses the existing search fallback when absent.
  suggest?(query: string): Promise<SearchResponse>
  radio?(kind: RadioKind, seedId: string, seed?: Partial<Track>): Promise<RadioSession>
  recommendations?(): Promise<Recommendations>
  prefetchPlayable?(track: Track): Promise<void>
  invalidatePlayable?(trackId: string): void
  getMe?(): Promise<UserIdentity>
  login?(username: string, password: string): Promise<UserIdentity>
  register?(username: string, password: string): Promise<UserIdentity>
  logout?(): Promise<UserIdentity>
}

let override: Backend | null = null
let selected: Backend | null = null
let mockPromise: Promise<Backend> | null = null

/** Used by tests to install a controlled backend. */
export function setBackend(value: Backend | null): void {
  override = value
}

export function backend(): Backend {
  return override ?? selected ?? unavailableBackend
}

/**
 * Selects Wails when its bindings exist; otherwise selects the real HTTP web
 * adapter. The fixture backend is available only when explicitly requested.
 */
export async function initBackend(): Promise<Backend> {
  if (override) return override
  const { hasWailsBackend, createWailsBackend } = await import('./wailsBackend')
  if (hasWailsBackend()) {
    selected = createWailsBackend()
    return selected
  }
  if (import.meta.env.DEV && import.meta.env.VITE_MELO_MOCK === '1') {
    if (!mockPromise) mockPromise = import('./mockBackend').then((module) => module.createMockBackend())
    selected = await mockPromise
    return selected
  }
  const { createWebBackend } = await import('./webBackend')
  selected = createWebBackend()
  return selected
}

const backendDown = (what: string) => () => Promise.reject(new Error(`${what} — the MELO backend isn't running.`))

const unavailableBackend: Backend = {
  isNative: false,
  getState: backendDown('Couldn’t load your library'),
  getDiagnostics: backendDown('Diagnostics unavailable'),
  search: backendDown('Search is unavailable'),
  getPlayable: backendDown('Playback engine unavailable'),
  getLyrics: backendDown('Lyrics unavailable'),
  saveSettings: backendDown('Couldn’t save settings'),
  setLiked: backendDown('Couldn’t update your library'),
  recordPlay: backendDown('Couldn’t record playback'),
  clearHistory: backendDown('Couldn’t clear history'),
  addSearchTerm: backendDown('Couldn’t save search history'),
  removeSearchTerm: backendDown('Couldn’t update search history'),
  clearSearchHistory: backendDown('Couldn’t clear search history'),
  libraryTracks: backendDown('Couldn’t load your library'),
  saveSession: backendDown('Couldn’t save the session'),
  clearSession: backendDown('Couldn’t clear the session'),
  createPlaylist: backendDown('Couldn’t create the playlist'),
  renamePlaylist: backendDown('Couldn’t rename the playlist'),
  deletePlaylist: backendDown('Couldn’t delete the playlist'),
  addTracksToPlaylist: backendDown('Couldn’t update the playlist'),
  removeTrackFromPlaylist: backendDown('Couldn’t update the playlist'),
  reorderPlaylist: backendDown('Couldn’t reorder the playlist'),
  duplicatePlaylist: backendDown('Couldn’t duplicate the playlist'),
  installResolver: backendDown('Couldn’t install the media resolver'),
  setNowPlaying: async () => {},
  on: () => () => {},
}
