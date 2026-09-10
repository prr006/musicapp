/**
 * Web persistence — the browser twin of the Go store (internal/store).
 *
 * One JSON document under `melo.web.state.v1`, saved atomically (single key
 * write) and debounced by callers. Same shape as the desktop AppState, so
 * hydration code is shared and the listening profile travels with it.
 *
 * Persistence is independent from playback: nothing here knows about the
 * engine, the queue controller or YouTube.
 */
import type { AppState, PlayEvent, PlayStats, Settings, Track } from '../bridge/types'
import { canonicalSongKey } from './radio'
import { defaultSettings } from './defaults'
import { emptyProfile, type ListeningProfile, applyListeningEvent, decayProfile } from './profile'

const STORAGE_KEY = 'melo.web.state.v1'

const HISTORY_CAP = 500
const STATS_CAP = 400
const SEARCH_CAP = 50

export interface WebState extends AppState {
  profile: ListeningProfile
}

function emptyState(): WebState {
  return {
    settings: defaultSettings(),
    liked: [],
    disliked: [],
    playlists: [],
    history: [],
    stats: {},
    searchHistory: [],
    session: null,
    profile: emptyProfile(),
    version: 1,
  }
}

export function loadWebState(): WebState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    const parsed = JSON.parse(raw) as Partial<WebState>
    const base = emptyState()
    return {
      settings: { ...base.settings, ...(parsed.settings ?? {}) },
      liked: parsed.liked ?? [],
      disliked: parsed.disliked ?? [],
      playlists: parsed.playlists ?? [],
      history: parsed.history ?? [],
      stats: parsed.stats ?? {},
      searchHistory: parsed.searchHistory ?? [],
      session: parsed.session ?? null,
      profile: parsed.profile ?? emptyProfile(),
      version: 1,
    }
  } catch {
    return emptyState()
  }
}

export function saveWebState(state: WebState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    /* storage full or unavailable: persistence is best-effort */
  }
}

/** A tiny mutation queue so bursts of events coalesce into one write. */
let saveTimer: ReturnType<typeof setTimeout> | null = null
export function scheduleWebStateSave(state: () => WebState, delayMs = 250): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    saveWebState(state())
  }, delayMs)
}

/** Flushes any pending debounced write (used on beforeunload). */
export function flushWebStateSave(state: () => WebState): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  saveWebState(state())
}

/* ---------------- domain operations (mirror the Go store) ---------------- */

export function applyPlayEvent(
  state: WebState,
  track: Track,
  event: PlayEvent,
  nowMs = Date.now(),
): WebState {
  const next: WebState = {
    ...state,
    history: [...state.history],
    stats: { ...state.stats },
    profile: applyListeningEvent(decayProfile(state.profile, nowMs), track, event, nowMs),
  }

  const stats: PlayStats = next.stats[track.id] ?? {
    playCount: 0,
    significantCount: 0,
    completeCount: 0,
    skipCount: 0,
    lastPlayedAt: 0,
  }
  switch (event) {
    case 'play_started':
      stats.playCount += 1
      stats.lastPlayedAt = nowMs
      break
    case 'played_significantly':
      stats.significantCount += 1
      break
    case 'completed':
      stats.completeCount += 1
      break
    case 'skipped':
      stats.skipCount += 1
      break
  }
  next.stats[track.id] = stats

  if (event === 'play_started') {
    const last = next.history[0]
    if (last && last.track.id === track.id && nowMs - last.playedAt < 30_000) {
      next.history[0] = { track, playedAt: nowMs }
    } else {
      next.history = [{ track, playedAt: nowMs }, ...next.history].slice(0, HISTORY_CAP)
    }
  }

  // Bounded stats map: least-recently-played evicted first.
  const ids = Object.keys(next.stats)
  if (ids.length > STATS_CAP) {
    const sorted = ids.sort((a, b) => next.stats[b].lastPlayedAt - next.stats[a].lastPlayedAt)
    for (const id of sorted.slice(STATS_CAP)) delete next.stats[id]
  }
  return next
}

export function setLikedInState(state: WebState, track: Track, liked: boolean): WebState {
  if (liked) {
    const canonicalKey = canonicalSongKey(track)
    // Canonical identity: another upload of the same song is the SAME like.
    const kept = state.liked.filter((t) => t.id !== track.id && canonicalSongKey(t) !== canonicalKey)
    const disliked = state.disliked.filter((t) => t.id !== track.id)
    return { ...state, liked: [{ ...track, addedAt: Date.now() }, ...kept], disliked }
  }
  return { ...state, liked: state.liked.filter((t) => t.id !== track.id) }
}

export function setDislikedInState(state: WebState, track: Track, disliked: boolean): WebState {
  if (disliked) {
    return {
      ...state,
      disliked: [{ ...track, addedAt: Date.now() }, ...state.disliked.filter((t) => t.id !== track.id)],
      liked: state.liked.filter((t) => t.id !== track.id),
    }
  }
  return { ...state, disliked: state.disliked.filter((t) => t.id !== track.id) }
}

export function saveSettingsInState(state: WebState, settings: Settings): WebState {
  return { ...state, settings }
}

export function addSearchTermInState(state: WebState, term: string): WebState {
  const trimmed = term.trim()
  if (!trimmed) return state
  const searchHistory = [trimmed, ...state.searchHistory.filter((t) => t.toLowerCase() !== trimmed.toLowerCase())].slice(0, SEARCH_CAP)
  return { ...state, searchHistory }
}

export function removeSearchTermInState(state: WebState, term: string): WebState {
  return { ...state, searchHistory: state.searchHistory.filter((t) => t !== term) }
}

/* ---------------- playlists ---------------- */

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function createPlaylistInState(state: WebState, name: string, tracks: Track[]): WebState {
  const pl = {
    id: newId('pl'),
    name: name.trim() || 'New Playlist',
    description: '',
    tracks,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  return { ...state, playlists: [...state.playlists, pl] }
}

export function findPlaylist(state: WebState, id: string) {
  return state.playlists.find((p) => p.id === id)
}

export function renamePlaylistInState(state: WebState, id: string, name: string): WebState {
  return {
    ...state,
    playlists: state.playlists.map((p) => (p.id === id ? { ...p, name, updatedAt: Date.now() } : p)),
  }
}

export function deletePlaylistInState(state: WebState, id: string): WebState {
  return { ...state, playlists: state.playlists.filter((p) => p.id !== id) }
}

export function addTracksToPlaylistInState(state: WebState, id: string, tracks: Track[]): WebState {
  return {
    ...state,
    playlists: state.playlists.map((p) => {
      if (p.id !== id) return p
      const known = new Set(p.tracks.map((t) => t.id))
      return {
        ...p,
        tracks: [...p.tracks, ...tracks.filter((t) => !known.has(t.id))],
        updatedAt: Date.now(),
      }
    }),
  }
}

export function removeTrackFromPlaylistInState(state: WebState, id: string, index: number): WebState {
  return {
    ...state,
    playlists: state.playlists.map((p) =>
      p.id === id ? { ...p, tracks: p.tracks.filter((_, i) => i !== index), updatedAt: Date.now() } : p,
    ),
  }
}

export function reorderPlaylistInState(state: WebState, id: string, from: number, to: number): WebState {
  return {
    ...state,
    playlists: state.playlists.map((p) => {
      if (p.id !== id) return p
      const tracks = p.tracks.slice()
      const [item] = tracks.splice(from, 1)
      tracks.splice(to, 0, item)
      return { ...p, tracks, updatedAt: Date.now() }
    }),
  }
}

export function duplicatePlaylistInState(state: WebState, id: string): WebState {
  const src = findPlaylist(state, id)
  if (!src) return state
  const copy = { ...src, id: newId('pl'), name: `${src.name} (copy)`, tracks: [...src.tracks], createdAt: Date.now(), updatedAt: Date.now() }
  return { ...state, playlists: [...state.playlists, copy] }
}
