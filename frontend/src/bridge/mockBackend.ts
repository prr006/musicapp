/**
 * Fixture backend used only for browser-based UI work and tests
 * (`VITE_MELO_MOCK=1`, dev builds only). It never ships in a Wails build:
 * production selects the native bindings, and without them the app reports
 * that the backend is unavailable instead of quietly faking data.
 *
 * The audio it returns is a genuinely decoded WAV tone, so the transport,
 * seeking, EOF and queue advancement exercise the same code paths as
 * production streams.
 */
import type { Backend } from './backend'
import type {
  AppState, Diagnostics, LyricsQuery, LyricsResult, PlayableSource,
  Playlist, PlayRecord, ResolverStatus, SearchResponse, Session, Settings, Track,
} from './types'
import { defaultSettings } from '../lib/defaults'

const STORAGE_KEY = 'melo.mock.state'

function art(seed: string, hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="hsl(${hue},62%,52%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 48) % 360},55%,28%)"/>
    </linearGradient></defs>
    <rect width="400" height="400" fill="url(#g)"/>
    <text x="32" y="360" font-family="Inter,system-ui" font-size="42" font-weight="700"
      fill="rgba(255,255,255,.92)">${seed}</text>
  </svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

interface Fixture {
  id: string
  title: string
  artist: string
  album: string
  duration: number
  hue: number
  freq: number
}

const FIXTURES: Fixture[] = [
  { id: 'nightfall', title: 'Nightfall', artist: 'Halcyon', album: 'Blue Hours', duration: 18, hue: 18, freq: 220 },
  { id: 'paper-lanterns', title: 'Paper Lanterns', artist: 'Halcyon', album: 'Blue Hours', duration: 15, hue: 32, freq: 247 },
  { id: 'slow-tide', title: 'Slow Tide', artist: 'Marlow', album: 'Undertow', duration: 20, hue: 200, freq: 262 },
  { id: 'glass-city', title: 'Glass City', artist: 'Marlow', album: 'Undertow', duration: 14, hue: 214, freq: 294 },
  { id: 'ember-drive', title: 'Ember Drive', artist: 'Kite Season', album: '', duration: 17, hue: 340, freq: 330 },
  { id: 'low-orbit', title: 'Low Orbit', artist: 'Kite Season', album: 'Signals', duration: 16, hue: 268, freq: 349 },
  { id: 'saffron', title: 'Saffron', artist: 'Neon Atlas', album: 'Saffron', duration: 19, hue: 44, freq: 392 },
  { id: 'quiet-machines', title: 'Quiet Machines', artist: 'Neon Atlas', album: 'Saffron', duration: 13, hue: 156, freq: 440 },
]

function toTrack(f: Fixture): Track {
  return {
    id: `yt:${f.id}`,
    sourceId: f.id,
    source: 'youtube',
    url: `https://music.youtube.com/watch?v=${f.id}`,
    title: f.title,
    artist: f.artist,
    album: f.album,
    artwork: art(f.title, f.hue),
    duration: f.duration,
    explicit: false,
  }
}

function wavToneURL(freq: number, seconds: number): string {
  const rate = 8000
  const samples = Math.floor(rate * seconds)
  const buffer = new ArrayBuffer(44 + samples * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples * 2, true)
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate
    const envelope = Math.min(1, t * 4) * Math.min(1, (seconds - t) * 4)
    const value = Math.sin(2 * Math.PI * freq * t) * 0.22 * envelope
    view.setInt16(44 + i * 2, value * 32767, true)
  }
  return URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }))
}

function loadState(): AppState {
  const base: AppState = {
    settings: defaultSettings(),
    liked: [],
    playlists: [],
    history: [],
    searchHistory: [],
    session: null,
    version: 1,
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return base
    return { ...base, ...(JSON.parse(raw) as AppState) }
  } catch {
    return base
  }
}

export function createMockBackend(): Backend {
  const state = loadState()
  const urls = new Map<string, string>()
  const persist = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    } catch {
      /* storage may be unavailable */
    }
  }
  const delay = <T>(value: T, ms = 220): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms))

  return {
    isNative: false,
    getState: () => delay(structuredClone(state), 60),
    getDiagnostics: () =>
      delay<Diagnostics>({
        appVersion: '3.0.0-dev',
        goVersion: 'n/a (browser fixture)',
        platform: 'browser',
        dataDir: 'localStorage',
        streamProxy: 'blob:',
        resolver: { installed: true, path: 'fixture', version: 'fixture', message: '' },
        resolverBinary: 'fixture',
        mediaKeys: 'unsupported',
        tray: 'unsupported',
      }),
    search: (query: string): Promise<SearchResponse> => {
      const q = query.trim().toLowerCase()
      if (q === 'error') return Promise.reject(new Error('Couldn\u2019t reach YouTube.'))
      const songs = FIXTURES.filter(
        (f) => f.title.toLowerCase().includes(q) || f.artist.toLowerCase().includes(q) || f.album.toLowerCase().includes(q),
      ).map(toTrack)
      const albums = [...new Set(songs.filter((s) => s.album).map((s) => s.album))].map((title) => {
        const first = songs.find((s) => s.album === title)!
        return { id: `${title.toLowerCase()}|${first.artist.toLowerCase()}`, title, artist: first.artist, artwork: first.artwork, year: '' }
      })
      const artists = [...new Set(songs.map((s) => s.artist))].map((name) => ({
        id: name.toLowerCase(),
        name,
        artwork: songs.find((s) => s.artist === name)!.artwork,
      }))
      return delay({ query, songs, videos: [], albums, artists, provider: 'fixture' })
    },
    getPlayable: (track: Track): Promise<PlayableSource> => {
      const fixture = FIXTURES.find((f) => `yt:${f.id}` === track.id)
      if (!fixture) return Promise.reject(new Error('Couldn\u2019t load this song.'))
      let url = urls.get(track.id)
      if (!url) {
        url = wavToneURL(fixture.freq, fixture.duration)
        urls.set(track.id, url)
      }
      return delay({
        trackId: track.id,
        url,
        mimeType: 'audio/wav',
        duration: fixture.duration,
        bitrate: 128,
        expiresAt: Date.now() + 3600_000,
      }, 320)
    },
    getLyrics: (query: LyricsQuery): Promise<LyricsResult> => {
      const fixture = FIXTURES.find((f) => `yt:${f.id}` === query.trackId)
      if (!fixture) return Promise.reject(new Error('No lyrics found.'))
      if (fixture.id === 'glass-city') return Promise.reject(new Error('No lyrics found.'))
      const lines = Array.from({ length: Math.floor(fixture.duration / 2) }, (_, i) => ({
        time: i * 2,
        text: `${fixture.title} — line ${i + 1}`,
      }))
      return delay({
        trackId: query.trackId,
        source: 'fixture',
        synced: true,
        lines,
        plain: lines.map((l) => l.text).join('\n'),
        instrumental: false,
        offset: 0,
        matchedTitle: fixture.title,
        matchedArtist: fixture.artist,
      }, 400)
    },
    saveSettings: (settings: Settings) => {
      state.settings = settings
      persist()
      return delay(settings, 20)
    },
    setLiked: (track: Track, liked: boolean) => {
      state.liked = liked
        ? [{ ...track, addedAt: Date.now() }, ...state.liked.filter((t) => t.id !== track.id)]
        : state.liked.filter((t) => t.id !== track.id)
      persist()
      return delay(state.liked, 20)
    },
    recordPlay: (track: Track) => {
      const now = Date.now()
      const last = state.history[0]
      if (last && last.track.id === track.id && now - last.playedAt < 30_000) {
        last.playedAt = now
      } else {
        state.history = [{ track, playedAt: now }, ...state.history].slice(0, 200)
      }
      persist()
      return delay<PlayRecord[]>(state.history, 20)
    },
    clearHistory: () => {
      state.history = []
      persist()
      return delay(undefined, 10)
    },
    addSearchTerm: (term: string) => {
      state.searchHistory = [term, ...state.searchHistory.filter((t) => t.toLowerCase() !== term.toLowerCase())].slice(0, 50)
      persist()
      return delay(state.searchHistory, 10)
    },
    removeSearchTerm: (term: string) => {
      state.searchHistory = state.searchHistory.filter((t) => t !== term)
      persist()
      return delay(state.searchHistory, 10)
    },
    clearSearchHistory: () => {
      state.searchHistory = []
      persist()
      return delay(undefined, 10)
    },
    libraryTracks: () => delay(FIXTURES.map(toTrack), 20),
    saveSession: (session: Session) => {
      state.session = session
      persist()
      return delay(undefined, 10)
    },
    clearSession: () => {
      state.session = null
      persist()
      return delay(undefined, 10)
    },
    createPlaylist: (name: string, tracks: Track[]) => {
      const pl: Playlist = {
        id: `pl_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        name: name.trim() || 'New Playlist',
        description: '',
        tracks,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      state.playlists.push(pl)
      persist()
      return delay(pl, 20)
    },
    renamePlaylist: (id: string, name: string) => {
      const pl = state.playlists.find((p) => p.id === id)!
      pl.name = name
      persist()
      return delay(pl, 20)
    },
    deletePlaylist: (id: string) => {
      state.playlists = state.playlists.filter((p) => p.id !== id)
      persist()
      return delay(undefined, 20)
    },
    addTracksToPlaylist: (id: string, tracks: Track[]) => {
      const pl = state.playlists.find((p) => p.id === id)!
      const known = new Set(pl.tracks.map((t) => t.id))
      pl.tracks = [...pl.tracks, ...tracks.filter((t) => !known.has(t.id))]
      persist()
      return delay(pl, 20)
    },
    removeTrackFromPlaylist: (id: string, index: number) => {
      const pl = state.playlists.find((p) => p.id === id)!
      pl.tracks = pl.tracks.filter((_, i) => i !== index)
      persist()
      return delay(pl, 20)
    },
    reorderPlaylist: (id: string, from: number, to: number) => {
      const pl = state.playlists.find((p) => p.id === id)!
      const next = pl.tracks.slice()
      const [item] = next.splice(from, 1)
      next.splice(to, 0, item)
      pl.tracks = next
      persist()
      return delay(pl, 20)
    },
    duplicatePlaylist: (id: string) => {
      const src = state.playlists.find((p) => p.id === id)!
      const copy: Playlist = { ...src, id: `pl_${Date.now()}`, name: `${src.name} (copy)`, tracks: [...src.tracks] }
      state.playlists.push(copy)
      persist()
      return delay(copy, 20)
    },
    setNowPlaying: async () => {},
    installResolver: () =>
      delay<ResolverStatus>({ installed: true, path: 'fixture', version: 'fixture', message: '' }),
    on: () => () => {},
  }
}
