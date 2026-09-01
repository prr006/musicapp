/** Domain types mirroring internal/model in the Go backend. */

export interface Track {
  id: string
  sourceId: string
  source: string
  url: string
  title: string
  artist: string
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
  playlists: Playlist[]
  history: PlayRecord[]
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
