import type { Backend } from './backend'
import type {
  AppState, Diagnostics, LyricsQuery, LyricsResult, PlayableSource, Playlist,
  PlayRecord, ResolverStatus, SearchResponse, Session, Settings, Track,
} from './types'

type WailsApp = Record<string, (...args: unknown[]) => Promise<unknown>>
interface WailsWindow {
  go?: { main?: { App?: WailsApp } }
  runtime?: {
    EventsOn(event: string, cb: (...args: unknown[]) => void): () => void
    EventsOff(event: string): void
  }
}

function app(): WailsApp | undefined {
  return (window as unknown as WailsWindow).go?.main?.App
}

export function hasWailsBackend(): boolean {
  return typeof window !== 'undefined' && !!app()
}

function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const binding = app()
  if (!binding || typeof binding[method] !== 'function') {
    return Promise.reject(new Error(`MELO desktop backend is unavailable (${method})`))
  }
  return binding[method](...args) as Promise<T>
}

export function createWailsBackend(): Backend {
  return {
    isNative: true,
    getState: () => call<AppState>('GetState'),
    getDiagnostics: () => call<Diagnostics>('GetDiagnostics'),
    search: (query, filter) => call<SearchResponse>('Search', query, filter),
    getPlayable: (track) => call<PlayableSource>('GetPlayable', track),
    getLyrics: (query: LyricsQuery) => call<LyricsResult>('GetLyrics', query),
    saveSettings: (settings: Settings) => call<Settings>('SaveSettings', settings),
    setLiked: (track: Track, liked: boolean) => call<Track[]>('SetLiked', track, liked),
    recordPlay: (track: Track) => call<PlayRecord[]>('RecordPlay', track),
    clearHistory: () => call<void>('ClearHistory'),
    addSearchTerm: (term) => call<string[]>('AddSearchTerm', term),
    removeSearchTerm: (term) => call<string[]>('RemoveSearchTerm', term),
    clearSearchHistory: () => call<void>('ClearSearchHistory'),
    libraryTracks: () => call<Track[]>('LibraryTracks'),
    saveSession: (session: Session) => call<void>('SaveSession', session),
    clearSession: () => call<void>('ClearSession'),
    createPlaylist: (name, tracks) => call<Playlist>('CreatePlaylist', name, tracks),
    renamePlaylist: (id, name) => call<Playlist>('RenamePlaylist', id, name),
    deletePlaylist: (id) => call<void>('DeletePlaylist', id),
    addTracksToPlaylist: (id, tracks) => call<Playlist>('AddTracksToPlaylist', id, tracks),
    removeTrackFromPlaylist: (id, index) => call<Playlist>('RemoveTrackFromPlaylist', id, index),
    reorderPlaylist: (id, from, to) => call<Playlist>('ReorderPlaylist', id, from, to),
    duplicatePlaylist: (id) => call<Playlist>('DuplicatePlaylist', id),
    installResolver: () => call<ResolverStatus>('InstallResolver'),
    setNowPlaying: (title, artist) => call<void>('SetNowPlaying', title, artist),
    on(event, callback) {
      const runtime = (window as unknown as WailsWindow).runtime
      if (!runtime) return () => {}
      return runtime.EventsOn(event, callback)
    },
  }
}
