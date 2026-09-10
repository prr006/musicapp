/**
 * The listening profile — MELO's lightweight, login-free user model.
 *
 * Everything the recommender learns lives here as plain numbers with decay:
 *
 *   - artistAffinity     completion-weighted, time-decayed artist weights
 *   - genreAffinity      style/keyword weights learned from titles + queries
 *   - trackPenalties     per-track skip pressure (never a hard blacklist)
 *   - artistPenalties    per-artist skip pressure
 *   - recentTrackIds     the last few tracks, to avoid immediate repeats
 *
 * The profile is PURE STATE + PURE FUNCTIONS: no network, no store, no UI.
 * It is persisted with the rest of the library state and therefore works the
 * same for a guest user on the web as for a desktop install.
 */
import type { PlayEvent, PlayRecord, PlayStats, Track } from '../bridge/types'
import { splitArtists } from './radio'

export interface ListeningProfile {
  version: 1
  /** Canonical artist key -> decaying affinity (completion-weighted). */
  artistAffinity: Record<string, number>
  /** Genre/style token -> decaying affinity. */
  genreAffinity: Record<string, number>
  /** Canonical track key -> skip pressure 0..1 (decays upward toward 0). */
  trackPenalties: Record<string, number>
  /** Canonical artist key -> skip pressure. */
  artistPenalties: Record<string, number>
  /** The last listened track keys, newest first (bounded). */
  recentTrackIds: string[]
  /** The last listened canonical artist keys, newest first (bounded). */
  recentArtistKeys: string[]
  updatedAt: number
}

export function emptyProfile(): ListeningProfile {
  return {
    version: 1,
    artistAffinity: {},
    genreAffinity: {},
    trackPenalties: {},
    artistPenalties: {},
    recentTrackIds: [],
    recentArtistKeys: [],
    updatedAt: 0,
  }
}

/**
 * Affinity weight per listening event. A completion counts far more than a
 * start (which might have been an instant skip); a significant listen is
 * worth a real fraction; a skip is negative pressure, not negative affinity.
 */
export const AFFINITY = {
  started: 0.35,
  significant: 0.6,
  completed: 1.0,
} as const

/** How much skip pressure one early skip adds (0..1 scale). */
export const SKIP_PENALTY_STEP = 0.34
/** Decay half-life in days: old listening fades, taste stays current. */
export const DECAY_HALF_LIFE_DAYS = 45
/** Bound on the maps so the profile cannot grow forever. */
const MAX_ARTISTS = 300
const MAX_GENRES = 120
const MAX_TRACK_PENALTIES = 400
const MAX_RECENT = 12

/** Common style tokens in music metadata worth learning as "genres". */
const GENRE_TOKENS = [
  'tamil', 'telugu', 'malayalam', 'kannada', 'hindi', 'punjabi', 'bollywood', 'kollywood',
  'carnatic', 'classical', 'folk', 'ghazal', 'sufi', 'bhangra',
  'phonk', 'lofi', 'lo-fi', 'hip hop', 'hip-hop', 'rap', 'trap', 'drill', 'r&b', 'rnb', 'soul',
  'jazz', 'blues', 'rock', 'metal', 'punk', 'indie', 'alternative', 'grunge',
  'pop', 'synthpop', 'synthwave', 'edm', 'house', 'techno', 'trance', 'dubstep', 'drum and bass',
  'ambient', 'chillout', 'dance', 'disco', 'funk', 'reggae', 'reggaeton', 'afrobeat', 'amapiano',
  'k-pop', 'kpop', 'j-pop', 'jpop', 'cantopop', 'mandopop', 'city pop', 'bossa nova', 'latin',
  'soundtrack', 'ost', 'ballad', 'acoustic', 'country', 'gospel', 'worship', 'anime',
]

/** Canonical (normalized) primary artist of a track — shared with the radio. */
export function canonicalArtistOf(track: Track): string {
  return splitArtists(track.artist ?? '')[0] ?? ''
}

export function canonicalTrackKey(track: Track): string {
  return `${(track.title ?? '').toLowerCase().trim()}|${canonicalArtistOf(track)}`
}

/** Genre/style tokens present in a track's metadata (title, artist, album). */
export function genreTokensOf(track: Track): string[] {
  const haystack = `${track.title ?? ''} ${track.artist ?? ''} ${track.album ?? ''}`.toLowerCase()
  const found: string[] = []
  for (const token of GENRE_TOKENS) {
    if (haystack.includes(token)) found.push(token)
  }
  return found
}

/** Time-decay factor: 1 now, →0.5 after one half-life, →0 after many. */
export function decayFactor(updatedAtMs: number, nowMs = Date.now()): number {
  const days = Math.max(0, (nowMs - updatedAtMs) / 86_400_000)
  return Math.pow(0.5, days / DECAY_HALF_LIFE_DAYS)
}

function bump(map: Record<string, number>, key: string, amount: number): void {
  map[key] = (map[key] ?? 0) + amount
}

/** Applies one listening event to the profile and returns the NEW profile. */
export function applyListeningEvent(
  profile: ListeningProfile,
  track: Track,
  event: PlayEvent,
  nowMs = Date.now(),
): ListeningProfile {
  const next: ListeningProfile = {
    ...profile,
    artistAffinity: { ...profile.artistAffinity },
    genreAffinity: { ...profile.genreAffinity },
    trackPenalties: { ...profile.trackPenalties },
    artistPenalties: { ...profile.artistPenalties },
    recentTrackIds: [...profile.recentTrackIds],
    recentArtistKeys: [...profile.recentArtistKeys],
    updatedAt: nowMs,
  }

  const artist = canonicalArtistOf(track)
  const trackKey = canonicalTrackKey(track)

  // Weight from the event itself (completion > significant > started).
  let weight = 0
  if (event === 'completed') weight = AFFINITY.completed
  else if (event === 'played_significantly') weight = AFFINITY.significant
  else if (event === 'play_started') weight = AFFINITY.started

  if (artist) {
    if (weight > 0) bump(next.artistAffinity, artist, weight)
    else if (event === 'skipped') {
      // Skips never subtract affinity (an accidental skip must not erase a
      // year of taste) — they accumulate separate, decaying penalty pressure.
      bump(next.artistPenalties, artist, Math.min(1 - (next.artistPenalties[artist] ?? 0), SKIP_PENALTY_STEP))
      bump(next.trackPenalties, trackKey, Math.min(1 - (next.trackPenalties[trackKey] ?? 0), SKIP_PENALTY_STEP))
    }
  }
  for (const genre of genreTokensOf(track)) {
    if (weight > 0) bump(next.genreAffinity, genre, weight)
  }

  // Recency rings: the track itself and its artist move to the front.
  if (event === 'play_started') {
    next.recentTrackIds = [trackKey, ...next.recentTrackIds.filter((k) => k !== trackKey)].slice(0, MAX_RECENT)
    if (artist) {
      next.recentArtistKeys = [artist, ...next.recentArtistKeys.filter((k) => k !== artist)].slice(0, MAX_RECENT)
    }
  }

  // Bounded maps: evict the least-affinity entries first.
  trim(next.artistAffinity, MAX_ARTISTS)
  trim(next.genreAffinity, MAX_GENRES)
  trim(next.trackPenalties, MAX_TRACK_PENALTIES)
  trim(next.artistPenalties, MAX_TRACK_PENALTIES)
  return next
}

function trim(map: Record<string, number>, max: number): void {
  const keys = Object.keys(map)
  if (keys.length <= max) return
  keys
    .sort((a, b) => map[a] - map[b])
    .slice(0, keys.length - max)
    .forEach((k) => delete map[k])
}

/** Scales a profile's weights by the time since it was last touched. */
export function decayProfile(profile: ListeningProfile, nowMs = Date.now()): ListeningProfile {
  if (!profile.updatedAt) return profile
  const factor = decayFactor(profile.updatedAt, nowMs)
  if (factor > 0.995) return profile
  const scale = (m: Record<string, number>) =>
    Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v * factor]))
  return {
    ...profile,
    artistAffinity: scale(profile.artistAffinity),
    genreAffinity: scale(profile.genreAffinity),
    trackPenalties: scale(profile.trackPenalties),
    artistPenalties: scale(profile.artistPenalties),
    updatedAt: nowMs,
  }
}

/** Normalised artist affinity (max = 1). */
export function normalizedArtistWeights(profile: ListeningProfile): Map<string, number> {
  const entries = Object.entries(profile.artistAffinity).filter(([, v]) => v > 0)
  if (entries.length === 0) return new Map()
  const max = Math.max(...entries.map(([, v]) => v))
  return new Map(entries.map(([k, v]) => [k, v / max]))
}

/** Normalised genre weights (max = 1) for ranking. */
export function normalizedGenreWeights(profile: ListeningProfile): Map<string, number> {
  const entries = Object.entries(profile.genreAffinity).filter(([, v]) => v > 0)
  if (entries.length === 0) return new Map()
  const max = Math.max(...entries.map(([, v]) => v))
  return new Map(entries.map(([k, v]) => [k, v / max]))
}

/**
 * The top style anchors of the profile: genre tokens above a share of the
 * strongest one — the "the user listens to Tamil film music" summary.
 */
export function topGenreAnchors(profile: ListeningProfile, minShare = 0.35, limit = 3): string[] {
  const weights = normalizedGenreWeights(profile)
  return [...weights.entries()]
    .filter(([, w]) => w >= minShare)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([genre]) => genre)
}

/** The top artist anchors (normalized ≥ minShare). */
export function topArtistAnchors(profile: ListeningProfile, minShare = 0.25, limit = 4): string[] {
  const weights = normalizedArtistWeights(profile)
  return [...weights.entries()]
    .filter(([, w]) => w >= minShare)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([artist]) => artist)
}

/**
 * Builds a profile from raw persisted taste data (history + per-track stats).
 * Used on hydration so a returning user's recommendations are personalized
 * from the first track, and by tests to construct a learned profile.
 */
export function buildProfileFromTaste(
  history: PlayRecord[],
  stats: Record<string, PlayStats>,
  base: ListeningProfile = emptyProfile(),
): ListeningProfile {
  let profile = base
  // Events are replayed as they most plausibly happened: a track with
  // completions contributed completed listens, its plays without completions
  // contributed starts, its skips contributed skip pressure.
  const seen = new Set<string>()
  for (const record of history) {
    const track = record.track
    const key = canonicalTrackKey(track)
    if (seen.has(key)) continue
    seen.add(key)
    const s = stats[track.id]
    if (!s) {
      profile = applyListeningEvent(profile, track, 'play_started', record.playedAt)
      continue
    }
    const completions = s.completeCount ?? 0
    const significants = Math.max(0, (s.significantCount ?? 0) - completions)
    const plays = Math.max(0, (s.playCount ?? 0) - significants - completions)
    const skips = s.skipCount ?? 0
    for (let i = 0; i < completions; i += 1) profile = applyListeningEvent(profile, track, 'completed', record.playedAt)
    for (let i = 0; i < significants; i += 1) profile = applyListeningEvent(profile, track, 'played_significantly', record.playedAt)
    for (let i = 0; i < Math.min(plays, 4); i += 1) profile = applyListeningEvent(profile, track, 'play_started', record.playedAt)
    for (let i = 0; i < Math.min(skips, 3); i += 1) profile = applyListeningEvent(profile, track, 'skipped', record.playedAt)
  }
  return profile
}

/* ---------------- ranking ---------------- */

export interface ScoreInput {
  /** The candidate track. */
  track: Track
  /** The canonical artist of the CURRENT track (session relevance). */
  currentArtist: string
  /** Genre tokens of the CURRENT track. */
  currentGenres: string[]
  /** The learned profile. */
  profile: ListeningProfile
  /** Canonical track keys queued right now (explicit + autoplay tail). */
  queuedTrackKeys?: ReadonlySet<string>
  /** Artist counts already in the current queue tail. */
  queuedArtistCounts?: ReadonlyMap<string, number>
  /** Liked artist keys. */
  likedArtistKeys?: ReadonlySet<string>
}

/**
 * Personal score for one candidate. Deterministic. Composition:
 *
 *   + artist affinity (learned, decayed)          up to +1.6
 *   + same artist as current track (session)      up to +0.9
 *   + genre/style affinity overlap                up to +1.0
 *   + liked-artist bonus                          +0.6
 *   − artist skip pressure                        up to −1.2
 *   − track skip pressure                         up to −1.0
 *   − queue-tail artist saturation                up to −0.8
 *   − just-played penalty                         −2.0
 */
export function scoreCandidatePersonal(input: ScoreInput): number {
  const { track, currentArtist, currentGenres, profile } = input
  const artist = canonicalArtistOf(track)
  let score = 0

  if (artist) {
    const affinity = profile.artistAffinity[artist] ?? 0
    // Smooth saturation: more listens matter, but with diminishing returns.
    score += 1.6 * (affinity / (affinity + 2.5))
    if (currentArtist && artist === currentArtist) score += 0.9
    const skipPressure = profile.artistPenalties[artist] ?? 0
    score -= 1.2 * Math.min(1, skipPressure)
  }

  const genres = genreTokensOf(track)
  const genreWeights = normalizedGenreWeights(profile)
  for (const genre of genres) {
    score += 0.5 * (genreWeights.get(genre) ?? 0)
  }
  // Style relevance to the CURRENT track: shared tokens imply a coherent next
  // step, not a random jump.
  if (currentGenres.length > 0 && genres.length > 0) {
    const shared = genres.filter((g) => currentGenres.includes(g)).length
    if (shared > 0) score += Math.min(0.8, 0.4 * shared)
  }

  if (artist && input.likedArtistKeys?.has(artist)) score += 0.6

  const trackPenalty = profile.trackPenalties[canonicalTrackKey(track)] ?? 0
  score -= 1.0 * Math.min(1, trackPenalty)

  if (artist && input.queuedArtistCounts) {
    const inQueue = input.queuedArtistCounts.get(artist) ?? 0
    if (inQueue > 0) score -= 0.4 * Math.min(2, inQueue)
  }

  if (input.queuedTrackKeys?.has(canonicalTrackKey(track))) score -= 2.0

  return score
}
