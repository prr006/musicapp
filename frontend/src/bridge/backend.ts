/**
 * The single boundary between the React app and the Go backend.
 *
 * In a packaged build Wails injects `window.go.main.App.*` (promise-returning
 * bindings) and `window.runtime` (events). In a plain browser — used for UI
 * work and tests — a fixture backend is used instead, selected explicitly via
 * VITE_MELO_MOCK so production builds can never silently fall back to it.
 */
import type {
  AppState, Diagnostics, LyricsQuery, LyricsResult, PlayableSource, PlayEvent,
  Playlist, PlayRecord, RadioResponse, ResolverStatus, SearchResponse, Session, Settings, Taste, Track,
} from './types'

export interface Backend {
  getState(): Promise<AppState>
  getDiagnostics(): Promise<Diagnostics>
  search(query: string, filter: string): Promise<SearchResponse>
  /** Dedicated related-music source for autoplay radio (never plain search). */
  relatedTracks(track: Track): Promise<RadioResponse>
  getPlayable(track: Track): Promise<PlayableSource>
  getLyrics(query: LyricsQuery): Promise<LyricsResult>
  saveSettings(settings: Settings): Promise<Settings>
  setLiked(track: Track, liked: boolean): Promise<Track[]>
  setDisliked(track: Track, disliked: boolean): Promise<Taste>
  recordPlay(track: Track): Promise<PlayRecord[]>
  recordPlayEvent(track: Track, event: PlayEvent): Promise<Taste>
  getTaste(): Promise<Taste>
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
  /** Mirrors the current track to the desktop (tray tooltip + notification). */
  setNowPlaying(title: string, artist: string): Promise<void>
  on(event: string, cb: (...args: unknown[]) => void): () => void
  isNative: boolean
}

type WailsApp = Record<string, (...args: unknown[]) => Promise<unknown>>

interface WailsWindow {
  go?: { main?: { App?: WailsApp } }
  runtime?: {
    EventsOn(event: string, cb: (...args: unknown[]) => void): () => void
    EventsOff(event: string): void
  }
}

function wailsApp(): WailsApp | undefined {
  return (window as unknown as WailsWindow).go?.main?.App
}

export function hasNativeBackend(): boolean {
  return typeof window !== 'undefined' && !!wailsApp()
}

function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const app = wailsApp()
  if (!app || typeof app[method] !== 'function') {
    return Promise.reject(new Error(`MELO backend is unavailable (${method})`))
  }
  return app[method](...args) as Promise<T>
}

const nativeBackend: Backend = {
  isNative: true,
  getState: () => call('GetState'),
  getDiagnostics: () => call('GetDiagnostics'),
  search: (query, filter) => call('Search', query, filter),
  relatedTracks: (track) => call('RelatedTracks', track),
  getPlayable: (track) => call('GetPlayable', track),
  getLyrics: (query) => call('GetLyrics', query),
  saveSettings: (settings) => call('SaveSettings', settings),
  setLiked: (track, liked) => call('SetLiked', track, liked),
  setDisliked: (track, disliked) => call('SetDisliked', track, disliked),
  recordPlay: (track) => call('RecordPlay', track),
  recordPlayEvent: (track, event) => call('RecordPlayEvent', track, event),
  getTaste: () => call('GetTaste'),
  clearHistory: () => call('ClearHistory'),
  addSearchTerm: (term) => call('AddSearchTerm', term),
  removeSearchTerm: (term) => call('RemoveSearchTerm', term),
  clearSearchHistory: () => call('ClearSearchHistory'),
  libraryTracks: () => call('LibraryTracks'),
  saveSession: (session) => call('SaveSession', session),
  clearSession: () => call('ClearSession'),
  createPlaylist: (name, tracks) => call('CreatePlaylist', name, tracks),
  renamePlaylist: (id, name) => call('RenamePlaylist', id, name),
  deletePlaylist: (id) => call('DeletePlaylist', id),
  addTracksToPlaylist: (id, tracks) => call('AddTracksToPlaylist', id, tracks),
  removeTrackFromPlaylist: (id, index) => call('RemoveTrackFromPlaylist', id, index),
  reorderPlaylist: (id, from, to) => call('ReorderPlaylist', id, from, to),
  duplicatePlaylist: (id) => call('DuplicatePlaylist', id),
  installResolver: () => call('InstallResolver'),
  setNowPlaying: (title, artist) => call('SetNowPlaying', title, artist),
  on(event, cb) {
    const rt = (window as unknown as WailsWindow).runtime
    if (!rt) return () => {}
    return rt.EventsOn(event, cb)
  },
}

let override: Backend | null = null

/** Used by tests to install a controlled backend. */
export function setBackend(b: Backend | null): void {
  override = b
}

let mockPromise: Promise<Backend> | null = null

export function backend(): Backend {
  if (override) return override
  if (hasNativeBackend()) return nativeBackend
  return unavailableBackend
}

/** Resolves the backend, loading the fixture backend when explicitly enabled. */
export async function initBackend(): Promise<Backend> {
  if (override) return override
  if (hasNativeBackend()) return nativeBackend
  if (import.meta.env.DEV && import.meta.env.VITE_MELO_MOCK === '1') {
    if (!mockPromise) {
      mockPromise = import('./mockBackend').then((m) => {
        override = m.createMockBackend()
        return override
      })
    }
    return mockPromise
  }
  return unavailableBackend
}

const backendDown = (what: string) => () =>
  Promise.reject(new Error(`${what} — the MELO backend isn't running.`))

const unavailableBackend: Backend = {
  isNative: false,
  getState: backendDown('Couldn\u2019t load your library'),
  getDiagnostics: backendDown('Diagnostics unavailable'),
  search: backendDown('Search is unavailable'),
  relatedTracks: backendDown('Radio is unavailable'),
  getPlayable: backendDown('Playback engine unavailable'),
  getLyrics: backendDown('Lyrics unavailable'),
  saveSettings: backendDown('Couldn\u2019t save settings'),
  setLiked: backendDown('Couldn\u2019t update your library'),
  setDisliked: backendDown('Couldn\u2019t update your library'),
  recordPlay: backendDown('Couldn\u2019t record playback'),
  recordPlayEvent: backendDown('Couldn\u2019t record playback'),
  getTaste: backendDown('Couldn\u2019t load your listening history'),
  clearHistory: backendDown('Couldn\u2019t clear history'),
  addSearchTerm: backendDown('Couldn\u2019t save search history'),
  removeSearchTerm: backendDown('Couldn\u2019t update search history'),
  clearSearchHistory: backendDown('Couldn\u2019t clear search history'),
  libraryTracks: backendDown('Couldn\u2019t load your library'),
  saveSession: backendDown('Couldn\u2019t save the session'),
  clearSession: backendDown('Couldn\u2019t clear the session'),
  createPlaylist: backendDown('Couldn\u2019t create the playlist'),
  renamePlaylist: backendDown('Couldn\u2019t rename the playlist'),
  deletePlaylist: backendDown('Couldn\u2019t delete the playlist'),
  addTracksToPlaylist: backendDown('Couldn\u2019t update the playlist'),
  removeTrackFromPlaylist: backendDown('Couldn\u2019t update the playlist'),
  reorderPlaylist: backendDown('Couldn\u2019t reorder the playlist'),
  duplicatePlaylist: backendDown('Couldn\u2019t duplicate the playlist'),
  installResolver: backendDown('Couldn\u2019t install the media resolver'),
  // Desktop mirroring is best-effort: without a backend there is nothing to tell.
  setNowPlaying: async () => {},
  on: () => () => {},
}
