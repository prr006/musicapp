/**
 * Fixture backend for every browser deployment — `vite dev`, tests, CI, and
 * the public static web build. The packaged app never touches it: it selects
 * the native Wails bindings whenever those exist, so real user data can never
 * be shadowed by fixtures.
 *
 * The catalogue uses REAL, well-known YouTube video ids so that — in any
 * networked browser — the YouTube IFrame adapter can genuinely play these
 * tracks end to end. The search is a deterministic token matcher over the
 * catalogue, good enough to exercise the full queue / recommendation flow
 * offline. There is no playback source here: playback is the adapter's job.
 */
import type { Backend } from './backend'
import type {
  AppState, Diagnostics, LyricsQuery, LyricsResult, PlayEvent,
  Playlist, PlayRecord, SearchResponse, Settings, Track,
} from './types'
import { defaultSettings } from '../lib/defaults'

const STORAGE_KEY = 'melo.mock.state'
const MAX_HISTORY = 500

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
  tags: string[]
  hue: number
}

/**
 * The fixture catalogue. Every id is a real YouTube music video/upload; the
 * rest of the metadata approximates what the InnerTube provider returns.
 * Durations are in seconds.
 */
const FIXTURES: Fixture[] = [
  // --- Tamil / Indian film & indie (the listening pattern the recommender
  // is expected to learn when these dominate someone's history) ---
  { id: 'YR12Z8f1Dh8', title: 'Why This Kolaveri Di', artist: 'Dhanush, Anirudh Ravichander', album: '3', duration: 219, tags: ['tamil', 'film'], hue: 24 },
  { id: 'KL32FouCps8', title: 'Rowdy Baby', artist: 'Dhanush, Dhee', album: 'Maari 2', duration: 282, tags: ['tamil', 'film', 'dance'], hue: 335 },
  { id: 'Q_WDDQ8FsxE', title: 'Vaathi Coming', artist: 'Anirudh Ravichander, Gana Balachandar', album: 'Master', duration: 228, tags: ['tamil', 'film', 'dance'], hue: 42 },
  { id: 'KUN5Uf9mObQ', title: 'Arabic Kuthu (Halamithi Habibo)', artist: 'Anirudh Ravichander', album: 'Beast', duration: 256, tags: ['tamil', 'film', 'dance'], hue: 200 },
  { id: 'bQCtX8wzq74', title: 'Chaleya', artist: 'Arijit Singh, Shilpa Rao', album: 'Jawan', duration: 271, tags: ['hindi', 'film', 'melody'], hue: 12 },
  { id: 'Z0S8OOhuhIE', title: 'Katchi Sera', artist: 'Sai Abhyankar', album: 'Think Indie', duration: 194, tags: ['tamil', 'indie'], hue: 150 },
  { id: 'T94PHkuydcw', title: 'Kun Faya Kun', artist: 'A.R. Rahman, Javed Ali, Mohit Chauhan', album: 'Rockstar', duration: 486, tags: ['hindi', 'film', 'sufi'], hue: 30 },
  { id: 'ai_2a6hR7Bo', title: 'Jai Ho', artist: 'A.R. Rahman, Sukhwinder Singh', album: 'Slumdog Millionaire', duration: 323, tags: ['hindi', 'film'], hue: 275 },
  { id: 'cC8AmhPUJPA', title: 'Inkem Inkem Inkem Kaavaale', artist: 'Sid Sriram', album: 'Geetha Govindam', duration: 270, tags: ['telugu', 'film', 'melody'], hue: 320 },
  { id: '2_4yQc0Gl2E', title: 'Samajavaragamana', artist: 'Sid Sriram', album: 'Ala Vaikunthapurramuloo', duration: 265, tags: ['telugu', 'film', 'melody'], hue: 210 },
  { id: '4_eEgJhsBMo', title: 'Naatu Naatu', artist: 'Rahul Sipligunj, Kaala Bhairava', album: 'RRR', duration: 273, tags: ['telugu', 'film', 'dance'], hue: 88 },
  { id: 'GfSgBLjFFSo', title: 'Saami Saami', artist: 'Rajalakshmi Senthiganesh', album: 'Pushpa', duration: 238, tags: ['tamil', 'film', 'dance'], hue: 330 },
  { id: '3wDiqlTNlfQ', title: 'Naa Ready', artist: 'Anirudh Ravichander, Vijay', album: 'Leo', duration: 234, tags: ['tamil', 'film', 'dance'], hue: 18 },
  { id: '6RdS6wLu7RY', title: 'Kesariya', artist: 'Arijit Singh', album: 'Brahmastra', duration: 269, tags: ['hindi', 'film', 'melody'], hue: 40 },
  { id: '3lDJZr6kbsg', title: 'Apna Bana Le', artist: 'Arijit Singh, Sachin-Jigar', album: 'Bhediya', duration: 273, tags: ['hindi', 'film', 'melody'], hue: 130 },

  // --- Western pop ---
  { id: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', artist: 'Rick Astley', album: 'Whenever You Need Somebody', duration: 213, tags: ['pop', '80s'], hue: 350 },
  { id: 'yPYZpwSpKmA', title: 'Together Forever', artist: 'Rick Astley', album: 'Whenever You Need Somebody', duration: 205, tags: ['pop', '80s'], hue: 20 },
  { id: 'JGwWNGJdvx8', title: 'Shape of You', artist: 'Ed Sheeran', album: 'Divide', duration: 264, tags: ['pop'], hue: 15 },
  { id: '2Vv-BfVoq4g', title: 'Perfect', artist: 'Ed Sheeran', album: 'Divide', duration: 279, tags: ['pop', 'ballad'], hue: 330 },
  { id: 'lp-EO5I60KA', title: 'Thinking Out Loud', artist: 'Ed Sheeran', album: 'Multiply', duration: 297, tags: ['pop', 'ballad'], hue: 300 },
  { id: 'nSDgHBxUbVQ', title: 'Photograph', artist: 'Ed Sheeran', album: 'Multiply', duration: 258, tags: ['pop', 'ballad'], hue: 190 },
  { id: 'YQHsXMglC9A', title: 'Hello', artist: 'Adele', album: '25', duration: 367, tags: ['pop', 'ballad', 'soul'], hue: 45 },
  { id: 'rYEDA3JcQqw', title: 'Rolling in the Deep', artist: 'Adele', album: '21', duration: 234, tags: ['pop', 'soul'], hue: 5 },
  { id: 'DyDfgMOUjCI', title: 'bad guy', artist: 'Billie Eilish', album: 'When We All Fall Asleep, Where Do We Go?', duration: 194, tags: ['pop'], hue: 120 },
  { id: 'TUVcZfQe-KU', title: 'Levitating', artist: 'Dua Lipa', album: 'Future Nostalgia', duration: 203, tags: ['pop', 'dance'], hue: 250 },
  { id: '4NRXx6U8ABQ', title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', duration: 263, tags: ['pop', 'synthwave'], hue: 355 },
  { id: 'CevxZvSJLk8', title: 'Roar', artist: 'Katy Perry', album: 'Prism', duration: 269, tags: ['pop'], hue: 26 },
  { id: '9bZkp7q19f0', title: 'Gangnam Style', artist: 'PSY', album: 'Psy 6th Album', duration: 253, tags: ['pop', 'kpop', 'dance'], hue: 60 },
  { id: 'gdZLi9oWZgU', title: 'Dynamite', artist: 'BTS', album: 'Dynamite', duration: 224, tags: ['kpop', 'pop', 'dance'], hue: 210 },
  { id: 'e-ORhEE9VVg', title: 'Blank Space', artist: 'Taylor Swift', album: '1989', duration: 273, tags: ['pop'], hue: 320 },
  { id: 'fWNaR-ixAw8', title: 'Shake It Off', artist: 'Taylor Swift', album: '1989', duration: 244, tags: ['pop'], hue: 195 },
  { id: 'fRh_vgS2dFE', title: 'Sorry', artist: 'Justin Bieber', album: 'Purpose', duration: 206, tags: ['pop', 'dance'], hue: 225 },
  { id: 'kffacxfA7G4', title: 'Baby', artist: 'Justin Bieber', album: 'My World 2.0', duration: 236, tags: ['pop'], hue: 140 },
  { id: '450p7goxZqg', title: 'All of Me', artist: 'John Legend', album: 'Love in the Future', duration: 270, tags: ['pop', 'ballad'], hue: 300 },
  { id: 'OPf0YbXqDm0', title: 'Uptown Funk', artist: 'Mark Ronson, Bruno Mars', album: 'Uptown Special', duration: 271, tags: ['pop', 'funk', 'dance'], hue: 35 },
  { id: 'kJQP7kkanOQ', title: 'Con Calma', artist: 'Daddy Yankee, Snow', album: 'Con Calma', duration: 191, tags: ['reggaeton', 'dance'], hue: 160 },
  { id: 'q0hyYWKXF0Q', title: 'Dance Monkey', artist: 'Tones and I', album: 'The Kids Are Coming', duration: 241, tags: ['pop', 'indie'], hue: 265 },
  { id: 'RgKAFK5djSk', title: 'See You Again', artist: 'Wiz Khalifa, Charlie Puth', album: 'Furious 7', duration: 238, tags: ['hiphop'], hue: 220 },
  { id: 'pRpeEdMmmQ0', title: 'Waka Waka (This Time for Africa)', artist: 'Shakira', album: 'Sale el Sol', duration: 211, tags: ['pop', 'latin', 'dance'], hue: 90 },

  // --- Rock ---
  { id: '7wtfhZwyrcc', title: 'Believer', artist: 'Imagine Dragons', album: 'Evolve', duration: 217, tags: ['rock', 'pop'], hue: 40 },
  { id: 'ktvTqknDobU', title: 'Radioactive', artist: 'Imagine Dragons', album: 'Night Visions', duration: 247, tags: ['rock'], hue: 75 },
  { id: 'fKopy74weus', title: 'Thunder', artist: 'Imagine Dragons', album: 'Evolve', duration: 204, tags: ['rock', 'pop'], hue: 180 },
  { id: 'hT_nvWreIhg', title: 'Counting Stars', artist: 'OneRepublic', album: 'Native', duration: 284, tags: ['rock', 'pop'], hue: 230 },
  { id: 'dvgZkm1xWPE', title: 'Viva La Vida', artist: 'Coldplay', album: 'Viva la Vida or Death and All His Friends', duration: 243, tags: ['rock'], hue: 215 },
  { id: 'hTWKbfoikeg', title: 'Smells Like Teen Spirit', artist: 'Nirvana', album: 'Nevermind', duration: 299, tags: ['rock', 'grunge'], hue: 130 },
  { id: 'FTQbiNvZqaY', title: 'Africa', artist: 'Toto', album: 'Toto IV', duration: 256, tags: ['rock', 'classic'], hue: 55 },
  { id: 'fJ9rUzIMcZQ', title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', duration: 355, tags: ['rock', 'classic'], hue: 305 },
  { id: 'EqPtz5qN7HM', title: 'Hotel California (Live)', artist: 'Eagles', album: 'Hell Freezes Over', duration: 468, tags: ['rock', 'classic', 'live'], hue: 175 },
  { id: '8SbUC-UaAxE', title: 'November Rain', artist: 'Guns N\u2019 Roses', album: 'Use Your Illusion I', duration: 537, tags: ['rock', 'ballad'], hue: 10 },
  { id: 'v2AC41dglnM', title: 'Thunderstruck', artist: 'AC/DC', album: 'The Razors Edge', duration: 292, tags: ['rock'], hue: 235 },

  // --- Hip-hop / electronic ---
  { id: 'uelHwf8o7_U', title: 'Love The Way You Lie', artist: 'Eminem, Rihanna', album: 'Recovery', duration: 273, tags: ['hiphop'], hue: 240 },
  { id: '_Yhyp-_hX2s', title: 'Lose Yourself', artist: 'Eminem', album: '8 Mile', duration: 326, tags: ['hiphop'], hue: 145 },
  { id: '60ItHLz5WEA', title: 'Faded', artist: 'Alan Walker', album: 'Different World', duration: 213, tags: ['electronic'], hue: 200 },
  { id: 'PT2_F-1esPk', title: 'Closer', artist: 'The Chainsmokers, Halsey', album: 'Collage', duration: 253, tags: ['electronic', 'pop'], hue: 285 },
  { id: 'IcrbM1l_BoI', title: 'Wake Me Up', artist: 'Avicii', album: 'True', duration: 273, tags: ['electronic', 'folk'], hue: 95 },
  { id: 'JRfuAukYTKg', title: 'Titanium', artist: 'David Guetta, Sia', album: 'Nothing but the Beat', duration: 245, tags: ['electronic', 'pop'], hue: 185 },
  { id: 'gCYcHz2k5x0', title: 'Animals', artist: 'Martin Garrix', album: 'Gold Skies', duration: 203, tags: ['electronic'], hue: 165 },

  // --- more pop / soul ---
  { id: 'lDK9QqIzhwk', title: 'Livin\u2019 on a Prayer', artist: 'Bon Jovi', album: 'Slippery When Wet', duration: 250, tags: ['rock', 'classic'], hue: 200 },
  { id: '1k8craCGpgs', title: 'Don\u2019t Stop Believin\u2019', artist: 'Journey', album: 'Escape', duration: 251, tags: ['rock', 'classic'], hue: 215 },
  { id: 'I_izvAbhExY', title: 'Stayin\u2019 Alive', artist: 'Bee Gees', album: 'Saturday Night Fever', duration: 285, tags: ['pop', 'classic', 'dance'], hue: 45 },
  { id: 'Zi_XLOBDo_Y', title: 'Billie Jean', artist: 'Michael Jackson', album: 'Thriller', duration: 294, tags: ['pop', 'classic', 'dance'], hue: 12 },
  { id: 'RBumgq5yVrA', title: 'Let Her Go', artist: 'Passenger', album: 'All the Little Lights', duration: 253, tags: ['pop', 'indie', 'ballad'], hue: 30 },
  { id: 'LjhCEhWiKXk', title: 'Just the Way You Are', artist: 'Bruno Mars', album: 'Doo-Wops & Hooligans', duration: 220, tags: ['pop', 'ballad'], hue: 350 },
  { id: '2vjPBrBU-TM', title: 'Chandelier', artist: 'Sia', album: '1000 Forms of Fear', duration: 236, tags: ['pop', 'ballad'], hue: 280 },
  { id: '09R8_2nJtjg', title: 'Sugar', artist: 'Maroon 5', album: 'V', duration: 302, tags: ['pop', 'funk'], hue: 340 },
  { id: 'FM7MFYoylVs', title: 'Something Just Like This', artist: 'The Chainsmokers, Coldplay', album: 'Memories...Do Not Open', duration: 247, tags: ['electronic', 'pop'], hue: 205 },
  { id: 'yKNxeF4KMsY', title: 'Yellow', artist: 'Coldplay', album: 'Parachutes', duration: 267, tags: ['rock', 'ballad'], hue: 48 },
  { id: 'j5-yKhDd64s', title: 'Not Afraid', artist: 'Eminem', album: 'Recovery', duration: 259, tags: ['hiphop'], hue: 235 },
  { id: 'xpVfcZ0ZcFM', title: 'God\u2019s Plan', artist: 'Drake', album: 'Scorpion', duration: 341, tags: ['hiphop'], hue: 90 },
  { id: 'pbMwTqkKSps', title: 'when the party\u2019s over', artist: 'Billie Eilish', album: 'When We All Fall Asleep, Where Do We Go?', duration: 196, tags: ['pop', 'ballad'], hue: 105 },
  { id: '34Na4j8AVgA', title: 'Starboy', artist: 'The Weeknd, Daft Punk', album: 'Starboy', duration: 254, tags: ['pop', 'electronic'], hue: 355 },
  { id: 'BQ0mxQXmLsk', title: 'Havana', artist: 'Camila Cabello, Young Thug', album: 'Camila', duration: 219, tags: ['pop', 'latin'], hue: 20 },
  { id: 'Pkh8UtuejGw', title: 'Se\u00f1orita', artist: 'Shawn Mendes, Camila Cabello', album: 'Se\u00f1orita', duration: 191, tags: ['pop', 'latin'], hue: 320 },
  { id: '0KSOMA3QBU0', title: 'Dark Horse', artist: 'Katy Perry, Juicy J', album: 'Prism', duration: 265, tags: ['pop'], hue: 270 },
  { id: 'M11SvDtPBhA', title: 'Party in the U.S.A.', artist: 'Miley Cyrus', album: 'The Time of Our Lives', duration: 234, tags: ['pop'], hue: 210 },
  { id: 'QJO3ROT-A4E', title: 'What Makes You Beautiful', artist: 'One Direction', album: 'Up All Night', duration: 199, tags: ['pop'], hue: 25 },
  { id: '8xg3vE8Ie_E', title: 'Love Story', artist: 'Taylor Swift', album: 'Fearless', duration: 235, tags: ['pop', 'ballad'], hue: 155 },
  { id: 'kXYiU_JCYtU', title: 'Numb', artist: 'Linkin Park', album: 'Meteora', duration: 187, tags: ['rock'], hue: 190 },
  { id: 'Soa3gO7tL-c', title: 'Boulevard of Broken Dreams', artist: 'Green Day', album: 'American Idiot', duration: 262, tags: ['rock'], hue: 130 },
  { id: 'Tj75Arhq544', title: 'Nothing Else Matters', artist: 'Metallica', album: 'Metallica', duration: 388, tags: ['rock', 'ballad'], hue: 225 },
  { id: 'papuvlVeZg8', title: 'Rockabye', artist: 'Clean Bandit, Sean Paul', album: 'Rockabye', duration: 254, tags: ['pop', 'dance'], hue: 300 },
]

function toTrack(f: Fixture): Track {
  return {
    id: `yt:${f.id}`,
    sourceId: f.id,
    source: 'youtube',
    url: `https://www.youtube.com/watch?v=${f.id}`,
    title: f.title,
    artist: f.artist,
    album: f.album,
    artwork: art(f.artist.split(',')[0], f.hue),
    duration: f.duration,
    explicit: false,
    tags: f.tags,
  }
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
    const saved = JSON.parse(raw) as Partial<AppState>
    return {
      ...base,
      settings: { ...base.settings, ...(saved.settings ?? {}) },
      liked: saved.liked ?? [],
      playlists: saved.playlists ?? [],
      history: (saved.history ?? []).map((h) => ({
        track: h.track,
        playedAt: h.playedAt,
        listenedSec: h.listenedSec ?? 0,
        trackDuration: h.trackDuration ?? h.track?.duration ?? 0,
        completed: !!h.completed,
        skipped: !!h.skipped,
      })),
      searchHistory: saved.searchHistory ?? [],
      session: null,
    }
  } catch {
    return base
  }
}

/**
 * JSON deep clone, not structuredClone: the fixture state is JSON by design
 * (it round-trips localStorage as JSON), and structuredClone would exclude
 * every browser older than Chrome 98 / Safari 15.4 from the web deployment.
 */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function createMockBackend(): Backend {
  const state = loadState()
  const persist = () => {
    try {
      // Sessions are not persisted: a restored clock/YouTube session makes no
      // sense across dev reloads; queue state can be rebuilt in a click.
      const { session: _session, ...rest } = state
      localStorage.setItem(STORAGE_KEY, JSON.stringify(rest))
    } catch {
      /* storage may be unavailable */
    }
  }
  const delay = <T>(value: T, ms = 160): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms))

  return {
    isNative: false,
    getState: () => delay(clone(state), 40),
    getDiagnostics: () =>
      delay<Diagnostics>({
        appVersion: '3.0.0-dev',
        goVersion: 'n/a (browser fixture)',
        platform: 'browser',
        dataDir: 'localStorage',
        player: 'fixture (dev)',
        mediaKeys: 'unsupported',
        tray: 'unsupported',
      }),
    search: (query: string): Promise<SearchResponse> => {
      const q = query.trim().toLowerCase()
      if (q === 'error') return Promise.reject(new Error('Couldn\u2019t reach YouTube.'))
      const tokens = q.split(/\s+/).filter(Boolean)
      const direct = FIXTURES.map((f) => {
        const artist = f.artist.toLowerCase()
        const title = f.title.toLowerCase()
        const album = f.album.toLowerCase()
        let score = 0
        for (const token of tokens) {
          if (artist.includes(token)) score += 3
          else if (title.includes(token)) score += 2
          else if (album.includes(token)) score += 1
          else if (f.tags.some((t) => t.includes(token))) score += 1
        }
        return { f, score }
      })
      // Real search engines return related music, not only exact matches: a
      // query that matches an artist also surfaces the genres/styles that
      // artist belongs to, at a lower rank.
      const matchedTags = new Set(direct.filter((s) => s.score > 0).flatMap((s) => s.f.tags))
      const scored = direct
        .map((s) => ({
          ...s,
          score: s.score > 0 ? s.score : s.f.tags.some((t) => matchedTags.has(t)) ? 0.5 : 0,
        }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score || a.f.title.localeCompare(b.f.title))
        .slice(0, 24)
      const songs = scored.map((s) => toTrack(s.f))
      const albums = [...new Set(songs.filter((s) => s.album).map((s) => s.album))].map((title) => {
        const first = songs.find((s) => s.album === title)!
        return {
          id: `${title.toLowerCase()}|${first.artist.toLowerCase()}`,
          title,
          artist: first.artist,
          artwork: first.artwork,
          year: '',
        }
      })
      const artists = [...new Set(songs.map((s) => s.artist))].map((name) => ({
        id: name.toLowerCase(),
        name,
        artwork: songs.find((s) => s.artist === name)!.artwork,
      }))
      return delay({ query, songs, videos: [], albums, artists, provider: 'fixture' })
    },
    getLyrics: (query: LyricsQuery): Promise<LyricsResult> => {
      const fixture = FIXTURES.find((f) => `yt:${f.id}` === query.trackId)
      if (!fixture || fixture.id === 'glass-city') return Promise.reject(new Error('No lyrics found.'))
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
      })
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
    recordPlayEvent: (track: Track, event: PlayEvent) => {
      const now = Date.now()
      if (event.phase === 'start') {
        const last = state.history[0]
        if (last && last.track.id === track.id && now - last.playedAt < 30_000) {
          last.playedAt = now
        } else {
          const record: PlayRecord = {
            track,
            playedAt: now,
            listenedSec: 0,
            trackDuration: track.duration || 0,
            completed: false,
            skipped: false,
          }
          state.history = [record, ...state.history].slice(0, MAX_HISTORY)
        }
      } else {
        const entry = state.history.find(
          (h) => h.track.id === track.id && now - h.playedAt < 3 * 3600_000,
        )
        if (entry) {
          entry.listenedSec = event.listenedSec ?? entry.listenedSec
          entry.completed = event.completed ?? entry.completed
          entry.skipped = event.skipped ?? entry.skipped
        }
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
      state.searchHistory = [
        term,
        ...state.searchHistory.filter((t) => t.toLowerCase() !== term.toLowerCase()),
      ].slice(0, 50)
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
    saveSession: () => delay(undefined, 10),
    clearSession: () => delay(undefined, 10),
    createPlaylist: (name: string, tracks: Track[]) => {
      const pl: Playlist = {
        id: `pl_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        name: name.trim() || 'New Playlist',
        description: '',
        tracks,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      state.playlists = [...state.playlists, pl]
      persist()
      return delay(pl, 20)
    },
    renamePlaylist: (id: string, name: string) => {
      const pl = state.playlists.find((p) => p.id === id)
      if (pl) {
        pl.name = name.trim() || pl.name
        pl.updatedAt = Date.now()
        persist()
      }
      return delay(pl ?? ({ id, name, description: '', tracks: [], createdAt: 0, updatedAt: 0 } as Playlist), 20)
    },
    deletePlaylist: (id: string) => {
      state.playlists = state.playlists.filter((p) => p.id !== id)
      persist()
      return delay(undefined, 10)
    },
    addTracksToPlaylist: (id: string, tracks: Track[]) => {
      const pl = state.playlists.find((p) => p.id === id)
      if (pl) {
        for (const t of tracks) {
          if (!pl.tracks.some((x) => x.id === t.id)) pl.tracks.push(t)
        }
        pl.updatedAt = Date.now()
        persist()
      }
      return delay(pl ?? ({ id, name: '', description: '', tracks: [], createdAt: 0, updatedAt: 0 } as Playlist), 20)
    },
    removeTrackFromPlaylist: (id: string, index: number) => {
      const pl = state.playlists.find((p) => p.id === id)
      if (pl && index >= 0 && index < pl.tracks.length) {
        pl.tracks.splice(index, 1)
        pl.updatedAt = Date.now()
        persist()
      }
      return delay(pl ?? ({ id, name: '', description: '', tracks: [], createdAt: 0, updatedAt: 0 } as Playlist), 20)
    },
    reorderPlaylist: (id: string, from: number, to: number) => {
      const pl = state.playlists.find((p) => p.id === id)
      if (pl && from >= 0 && from < pl.tracks.length && to >= 0 && to < pl.tracks.length) {
        const [item] = pl.tracks.splice(from, 1)
        pl.tracks.splice(to, 0, item)
        pl.updatedAt = Date.now()
        persist()
      }
      return delay(pl ?? ({ id, name: '', description: '', tracks: [], createdAt: 0, updatedAt: 0 } as Playlist), 20)
    },
    duplicatePlaylist: (id: string) => {
      const pl = state.playlists.find((p) => p.id === id)
      let copy: Playlist | null = null
      if (pl) {
        copy = { ...structuredClone(pl), id: `pl_${Date.now()}`, name: `${pl.name} (copy)` }
        state.playlists = [...state.playlists, copy]
        persist()
      }
      return delay(copy ?? ({ id, name: '', description: '', tracks: [], createdAt: 0, updatedAt: 0 } as Playlist), 20)
    },
    setNowPlaying: async () => {},
    on: () => () => {},
  }
}
