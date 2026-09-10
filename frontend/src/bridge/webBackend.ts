/**
 * WebBackend — the browser implementation of MELO's backend boundary.
 *
 * Architecture mapping (web build):
 *
 *     UI
 *      ↓
 *     Data / Search       ← THIS file (metadata only, from Piped mirrors)
 *      ↓
 *     Queue Domain        ← state/playback.ts (provider-independent, shared)
 *      ↓
 *     Playback Controller ← state/playback.ts (provider-independent, shared)
 *      ↓
 *     Playback Adapter    ← audio/ytPlayer.ts (YouTube IFrame, provider-specific)
 *      ↓
 *     Provider            ← YouTube's own player, no extraction anywhere
 *
 * Everything here is METADATA + PERSISTENCE + LYRICS. Audio never flows
 * through this backend: there is no getPlayable, no /resolve, no /stream, no
 * yt-dlp and no extracted media URLs in the web build.
 */
import type { Backend } from './backend'
import type {
  Diagnostics, LyricsQuery, LyricsResult, PlayEvent, PlayRecord,
  RadioResponse, ResolverStatus, SearchResponse, Session, Settings, Taste, Track,
} from './types'
import {
  pipedSearch, pipedRadioMix, ProviderError,
} from '../lib/webProvider'
import { fetchWebLyrics, LyricsNotFoundError } from '../lib/webLyrics'
import {
  loadWebState, scheduleWebStateSave, flushWebStateSave, applyPlayEvent, setLikedInState,
  setDislikedInState, saveSettingsInState, addSearchTermInState, removeSearchTermInState,
  createPlaylistInState, renamePlaylistInState, deletePlaylistInState, addTracksToPlaylistInState,
  removeTrackFromPlaylistInState, reorderPlaylistInState, duplicatePlaylistInState, findPlaylist,
  type WebState,
} from '../lib/webStore'

function now(): number {
  return Date.now()
}

export function createWebBackend(): Backend {
  let state: WebState = loadWebState()
  state_ref = state

  const persist = () => scheduleWebStateSave(() => state_ref ?? state)
  const persistNow = () => flushWebStateSave(() => state_ref ?? state)
  // The app shell flushes on beforeunload through this module-level hook.
  webBackendFlush = persistNow

  const taste = (): Taste => ({
    history: state.history,
    stats: state.stats ?? {},
    disliked: state.disliked ?? [],
  })

  const delay = <T,>(value: T, ms = 0): Promise<T> =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms))

  // Out-of-order protection for play events (two play_started within the
  // dedupe window are the same listen).
  let lastEventAt = 0

  return {
    isNative: false,

    getState: () => delay(structuredClone(state), 20),

    getDiagnostics: () =>
      delay<Diagnostics>({
        appVersion: '3.0.0-web',
        goVersion: 'n/a (web)',
        platform: `web/${navigator.language || 'en'}`,
        dataDir: 'localStorage',
        streamProxy: 'none (YouTube IFrame player)',
        resolver: { installed: false, path: '', version: '', message: 'Not needed on the web — playback uses the YouTube IFrame player.' },
        resolverBinary: '',
        mediaKeys: 'unsupported',
        tray: 'unsupported',
        notifications: 'browser',
      }),

    search: (query: string, filter: string): Promise<SearchResponse> =>
      pipedSearch(query, filter).catch((err) => {
        if (err instanceof ProviderError) {
          throw new Error('Couldn’t reach the search provider — check your connection and try again.')
        }
        throw err
      }),

    /**
     * The web radio source: the provider's genuine song mix (RDAMVM) around
     * the seed, ranked by the caller's engine. Distinct source label so the
     * queue UI can attribute suggestions correctly.
     */
    relatedTracks: async (track: Track): Promise<RadioResponse> => {
      try {
        const tracks = await pipedRadioMix(track.sourceId)
        return { tracks, source: tracks.length > 0 ? 'web-radio-mix' : '' }
      } catch {
        return { tracks: [], source: '' }
      }
    },

    // Playback provider boundary: the web build has no resolver. These throw
    // deliberately — the web engine never calls them.
    getPlayable: () =>
      Promise.reject(new Error('getPlayable is not used by the web build (YouTube IFrame playback).')),

    getLyrics: async (query: LyricsQuery): Promise<LyricsResult> => {
      try {
        return await fetchWebLyrics(query)
      } catch (err) {
        if (err instanceof LyricsNotFoundError) throw err
        throw new Error('The lyrics service could not be reached.')
      }
    },

    saveSettings: (settings: Settings) => {
      state = saveSettingsInState(state, settings)
      persist()
      return delay(settings, 10)
    },

    setLiked: (track: Track, liked: boolean) => {
      state = setLikedInState(state, track, liked)
      persist()
      return delay(state.liked, 10)
    },

    setDisliked: (track: Track, disliked: boolean) => {
      state = setDislikedInState(state, track, disliked)
      persist()
      return delay(taste(), 10)
    },

    recordPlay: (track: Track) => {
      state = applyPlayEvent(state, track, 'play_started', now())
      persist()
      return delay<PlayRecord[]>(state.history, 10)
    },

    recordPlayEvent: (track: Track, event: PlayEvent) => {
      const ts = now()
      // Duplicate guard: two play_started for one track inside 30s are the
      // same listen (rapid double play / fast retry).
      if (event === 'play_started' && ts - lastEventAt < 30_000 && state.history[0]?.track.id === track.id) {
        return delay(taste(), 10)
      }
      if (event === 'play_started') lastEventAt = ts
      state = applyPlayEvent(state, track, event, ts)
      state_ref = state
      persist()
      return delay(taste(), 10)
    },

    getTaste: () => delay(taste(), 10),

    clearHistory: () => {
      state = { ...state, history: [], stats: {} }
      persist()
      return delay(undefined, 10)
    },

    addSearchTerm: (term: string) => {
      state = addSearchTermInState(state, term)
      persist()
      return delay(state.searchHistory, 10)
    },

    removeSearchTerm: (term: string) => {
      state = removeSearchTermInState(state, term)
      persist()
      return delay(state.searchHistory, 10)
    },

    clearSearchHistory: () => {
      state = { ...state, searchHistory: [] }
      persist()
      return delay(undefined, 10)
    },

    libraryTracks: () => {
      // The library view derives from everything the user actually has:
      // liked, playlisted and played tracks. History supplies the metadata.
      const seen = new Set<string>()
      const out: Track[] = []
      for (const t of [
        ...state.liked,
        ...state.playlists.flatMap((p) => p.tracks),
        ...state.history.map((h) => h.track),
      ]) {
        if (seen.has(t.id)) continue
        seen.add(t.id)
        out.push(t)
      }
      return delay(out, 10)
    },

    saveSession: (session: Session) => {
      state = { ...state, session }
      persist()
      return delay(undefined, 10)
    },

    clearSession: () => {
      state = { ...state, session: null }
      persist()
      return delay(undefined, 10)
    },

    createPlaylist: (name: string, tracks: Track[]) => {
      state = createPlaylistInState(state, name, tracks)
      persist()
      return delay(structuredClone(findPlaylist(state, state.playlists[state.playlists.length - 1].id)!), 10)
    },

    renamePlaylist: (id: string, name: string) => {
      state = renamePlaylistInState(state, id, name)
      persist()
      const pl = findPlaylist(state, id)
      if (!pl) return Promise.reject(new Error('Playlist not found.'))
      return delay(structuredClone(pl), 10)
    },

    deletePlaylist: (id: string) => {
      state = deletePlaylistInState(state, id)
      persist()
      return delay(undefined, 10)
    },

    addTracksToPlaylist: (id: string, tracks: Track[]) => {
      state = addTracksToPlaylistInState(state, id, tracks)
      persist()
      const pl = findPlaylist(state, id)
      if (!pl) return Promise.reject(new Error('Playlist not found.'))
      return delay(structuredClone(pl), 10)
    },

    removeTrackFromPlaylist: (id: string, index: number) => {
      state = removeTrackFromPlaylistInState(state, id, index)
      persist()
      const pl = findPlaylist(state, id)
      if (!pl) return Promise.reject(new Error('Playlist not found.'))
      return delay(structuredClone(pl), 10)
    },

    reorderPlaylist: (id: string, from: number, to: number) => {
      state = reorderPlaylistInState(state, id, from, to)
      persist()
      const pl = findPlaylist(state, id)
      if (!pl) return Promise.reject(new Error('Playlist not found.'))
      return delay(structuredClone(pl), 10)
    },

    duplicatePlaylist: (id: string) => {
      state = duplicatePlaylistInState(state, id)
      persist()
      const copy = state.playlists[state.playlists.length - 1]
      return delay(structuredClone(copy), 10)
    },

    // No resolver to install on the web.
    installResolver: () =>
      delay<ResolverStatus>({ installed: false, path: '', version: '', message: 'Not needed on the web.' }, 10),

    setNowPlaying: async () => {
      /* no desktop surface on the web; the document title mirrors instead */
    },

    on: () => () => {},
  } satisfies Backend
}

// Shared reference so the unload hook can flush the same document the
// backend mutates (module-level, single backend instance per page).
let state_ref: WebState | null = null
let webBackendFlush: (() => void) | null = null

/** Flushes any pending persistence write (registered on beforeunload). */
export function flushWebBackend(): void {
  webBackendFlush?.()
}

