/** Domain types mirroring internal/model in the Go backend. */

export interface Track {
  id: string
  sourceId: string
  source: string
  url: string
  title: string
  /** Performing artist — only when the provider identifies one. */
  artist: string
  /** Channel/uploader when it is NOT the performing artist (e.g. uploads). */
  uploader?: string
  /** Diagnostics: where Artist came from ("browse" | "topic" | "metadata" | ""). */
  artistSrc?: string
  /** Diagnostics: which renderer/endpoint produced this row. */
  via?: string
  album: string
  artwork: string
  duration: number
  explicit: boolean
  addedAt?: number
}

export interface Album {
  id: string
  title: string
  artist: string
  artwork: string
  year: string
  tracks?: Track[]
}

export interface Artist {
  id: string
  name: string
  artwork: string
  tracks?: Track[]
  albums?: Album[]
}

export interface SearchResponse {
  query: string
  songs: Track[]
  videos: Track[]
  albums: Album[]
  artists: Artist[]
  provider: string
}

export interface PlayableSource {
  trackId: string
  url: string
  mimeType: string
  duration: number
  bitrate: number
  expiresAt: number
}

export interface Playlist {
  id: string
  name: string
  description: string
  tracks: Track[]
  createdAt: number
  updatedAt: number
}

export interface PlayRecord {
  track: Track
  playedAt: number
}

/**
 * Listening events recorded by the player — one per real user action, never
 * per transport-state update. "played_significantly" means the track was on
 * for a real listen (30s or half the song, whichever comes first).
 */
export type PlayEvent = 'play_started' | 'played_significantly' | 'completed' | 'skipped'

export interface PlayStats {
  playCount: number
  significantCount: number
  completeCount: number
  skipCount: number
  lastPlayedAt: number
}

/** History + per-track stats + dislikes: the local taste payload. */
export interface Taste {
  history: PlayRecord[]
  stats: Record<string, PlayStats>
  disliked: Track[]
}

/** The provider's dedicated related-music answer for a seed track. */
export interface RadioResponse {
  tracks: Track[]
  /** Which pipeline produced the candidates, e.g. "ytmusic-next". */
  source: string
  /** Which recommendation surfaces contributed how many candidates (diagnostics). */
  shelves?: { kind: string; count: number }[]
}

export type ThemeMode = 'dark' | 'light' | 'system'
export type RepeatMode = 'off' | 'one' | 'all'

export interface Settings {
  theme: ThemeMode
  accent: string
  autoplay: boolean
  defaultSpeed: number
  audioQuality: 'high' | 'medium' | 'low'
  restoreSession: boolean
  resumeOnStartup: boolean
  mediaKeys: boolean
  minimizeToTray: boolean
  notifications: boolean
  showLyrics: boolean
  volume: number
  muted: boolean
  shortcuts: Record<string, string>
}

export interface Session {
  queue: Track[]
  autoQueue: Track[]
  index: number
  position: number
  shuffle: boolean
  repeat: RepeatMode
  speed: number
  savedAt: number
}

export interface AppState {
  settings: Settings
  liked: Track[]
  disliked: Track[]
  playlists: Playlist[]
  history: PlayRecord[]
  stats: Record<string, PlayStats>
  searchHistory: string[]
  session: Session | null
  version: number
}

export interface LyricsQuery {
  trackId: string
  title: string
  artist: string
  album: string
  duration: number
}

export interface LyricLine {
  time: number
  text: string
}

export interface LyricsResult {
  trackId: string
  source: string
  synced: boolean
  lines: LyricLine[]
  plain: string
  instrumental: boolean
  offset: number
  matchedTitle: string
  matchedArtist: string
}

export interface ResolverStatus {
  installed: boolean
  path: string
  version: string
  message: string
}

export interface Diagnostics {
  appVersion: string
  goVersion: string
  platform: string
  dataDir: string
  streamProxy: string
  resolver: ResolverStatus
  resolverBinary: string
  mediaKeys: string
  tray: string
}
