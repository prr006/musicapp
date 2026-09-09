/**
 * The listening profile: a deterministic, lightweight model of what this
 * listener actually enjoys, derived from real playback events.
 *
 * This is deliberately *not* machine learning. It is a decayed frequency
 * model — the first version of exactly the scoring the product needs:
 *
 *   "What has this user been listening to?"
 *       +
 *   "What are they listening to right now?"
 *       +
 *   "What is commonly related to those patterns?"
 *
 * Everything here is a pure function of (history, likes, now), so it is
 * trivially testable and reproducible.
 */
import type { PlayRecord, Track } from '../bridge/types'

/** Weight half-life: ~36h. Recent sessions dominate; old favourites linger. */
export const HALF_LIFE_MS = 36 * 60 * 60 * 1000
/** How many recent play events count as "just heard" for hard-exclusion. */
export const RECENT_TRACK_WINDOW = 60
/** How many recent skips are remembered as "don't suggest this". */
export const RECENT_SKIP_WINDOW = 40
/** How many recent distinct artists are considered "the current session". */
export const RECENT_ARTIST_WINDOW = 24
/** Flat affinity boost a liked song gives its artist. */
export const LIKE_ARTIST_BOOST = 0.6
/** Flat affinity boost a liked song gives its style tags. */
export const LIKE_TAG_BOOST = 0.3
/** A skip is a mild negative vote for the track's artists and styles. */
export const SKIP_PENALTY = 0.35

export interface ListeningProfile {
  /** Decayed, completion-weighted artist weights. */
  artistWeights: Map<string, number>
  /** Decayed weights for style/genre tags. */
  tagWeights: Map<string, number>
  /** Track ids newest-first (bounded). */
  recentTrackIds: string[]
  /** Primary artists newest-first, deduplicated (bounded). */
  recentArtists: string[]
  /** Normalized titles newest-first (bounded). */
  recentTitleKeys: string[]
  /** Recently skipped track ids — do not suggest these again soon. */
  skipIds: Set<string>
  /** All-time play counts per track id. */
  playCounts: Map<string, number>
  likedTrackIds: Set<string>
  likedArtists: Set<string>
  totalPlays: number
  maxArtistWeight: number
  maxTagWeight: number
}

const EMPTY_PROFILE: ListeningProfile = {
  artistWeights: new Map(),
  tagWeights: new Map(),
  recentTrackIds: [],
  recentArtists: [],
  recentTitleKeys: [],
  skipIds: new Set(),
  playCounts: new Map(),
  likedTrackIds: new Set(),
  likedArtists: new Set(),
  totalPlays: 0,
  maxArtistWeight: 0,
  maxTagWeight: 0,
}

export function emptyProfile(): ListeningProfile {
  return {
    artistWeights: new Map(),
    tagWeights: new Map(),
    recentTrackIds: [],
    recentArtists: [],
    recentTitleKeys: [],
    skipIds: new Set(),
    playCounts: new Map(),
    likedTrackIds: new Set(),
    likedArtists: new Set(),
    totalPlays: 0,
    maxArtistWeight: 0,
    maxTagWeight: 0,
  }
}

/** Style hints that can be derived deterministically from a title. */
const STYLE_PATTERNS: [RegExp, string][] = [
  [/\bremix\b|\bre-?mix\b/i, 'remix'],
  [/\bcover\b|\bversion\b/i, 'cover'],
  [/\blive\b/i, 'live'],
  [/\bacoustic\b|\bunplugged\b/i, 'acoustic'],
  [/\bslowed\b|\breverb\b/i, 'slowed'],
  [/\bsped up\b|\bnightcore\b/i, 'sped'],
  [/\binstrumental\b|\bkaraoke\b/i, 'instrumental'],
  [/\bmashup\b|\bmash-?up\b/i, 'mashup'],
  [/\blofi\b|\blo-?fi\b/i, 'lofi'],
  [/\bedm\b|\bclub\b|\bdance\b/i, 'dance'],
  [/\brap\b|\bhip[- ]hop\b/i, 'hiphop'],
  [/\bballad\b|\bmelody\b/i, 'melody'],
  [/\bkuthu\b|\bkuthu\b|\bfolk\b/i, 'folk'],
  [/\bduet\b/i, 'duet'],
]

/** All style tags that apply to a track: provider tags + title-derived ones. */
export function styleTagsFor(track: Pick<Track, 'tags' | 'title'>): string[] {
  const tags = new Set<string>()
  for (const t of track.tags ?? []) {
    const key = String(t).toLowerCase().trim()
    if (key) tags.add(key)
  }
  const title = track.title ?? ''
  for (const [pattern, tag] of STYLE_PATTERNS) {
    if (pattern.test(title)) tags.add(tag)
  }
  return [...tags]
}

/** The primary (first-listed) artist, normalized. */
export function primaryArtist(artist: string | undefined): string {
  return (artist ?? '').split(',')[0].trim().toLowerCase()
}

/** Every artist credited on a track, normalized. */
export function allArtists(artist: string | undefined): string[] {
  return (artist ?? '')
    .split(',')
    .map((a) => a.trim().toLowerCase())
    .filter(Boolean)
}

const TITLE_NOISE = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'to', 'in', 'on', 'for', 'feat', 'ft',
  'featuring', 'official', 'video', 'audio', 'lyrics', 'lyric', 'hd', 'hq',
  'music', 'song', 'from', 'with', 'new', 'full', 'version', 'remastered',
])

/** Meaningful title tokens, lowercased — used for title-similarity signals. */
export function titleTokens(title: string | undefined): string[] {
  return (title ?? '')
    .toLowerCase()
    .replace(/[([(][^)]]*[)]]/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !TITLE_NOISE.has(w))
}

/**
 * Builds the profile from persisted history and likes.
 * `history` is expected newest-first (the store's order); entries without
 * completion data still count, but with reduced weight.
 */
export function buildProfile(history: PlayRecord[], liked: Track[], nowMs = Date.now()): ListeningProfile {
  const profile = emptyProfile()
  profile.likedTrackIds = new Set(liked.map((t) => t.id))
  for (const t of liked) {
    for (const a of allArtists(t.artist)) profile.likedArtists.add(a)
  }

  let recentTracks = 0
  let recentArtistsSeen = 0
  let recentTitles = 0
  let skipsSeen = 0

  for (const record of history) {
    const { track } = record
    if (!track?.id) continue
    const age = Math.max(0, nowMs - (record.playedAt || 0))
    const decay = Math.pow(0.5, age / HALF_LIFE_MS)

    const ratio = record.trackDuration > 0
      ? Math.max(0, Math.min(1, (record.listenedSec ?? 0) / record.trackDuration))
      : record.completed
        ? 1
        : 0.2
    // A completed listen gives full weight; a skip is a mild negative vote;
    // anything in between scales by how much was actually heard.
    const weight = record.skipped
      ? -SKIP_PENALTY * decay
      : decay * (0.25 + 0.75 * ratio)

    const artists = allArtists(track.artist)
    for (const a of artists) {
      if (!a) continue
      profile.artistWeights.set(a, (profile.artistWeights.get(a) ?? 0) + weight / artists.length)
    }
    for (const tag of styleTagsFor(track)) {
      profile.tagWeights.set(tag, (profile.tagWeights.get(tag) ?? 0) + weight)
    }

    profile.playCounts.set(track.id, (profile.playCounts.get(track.id) ?? 0) + 1)
    profile.totalPlays += 1

    if (recentTracks < RECENT_TRACK_WINDOW) {
      profile.recentTrackIds.push(track.id)
      recentTracks += 1
    }
    if (recentArtistsSeen < RECENT_ARTIST_WINDOW) {
      const primary = primaryArtist(track.artist)
      if (primary && !profile.recentArtists.includes(primary)) {
        profile.recentArtists.push(primary)
        recentArtistsSeen += 1
      }
    }
    if (recentTitles < RECENT_TRACK_WINDOW) {
      const key = titleTokens(track.title).join(' ')
      if (key) profile.recentTitleKeys.push(key)
      recentTitles += 1
    }
    if (record.skipped && skipsSeen < RECENT_SKIP_WINDOW) {
      profile.skipIds.add(track.id)
      skipsSeen += 1
    }
  }

  // Likes are a strong, non-decaying signal — but a bounded one.
  for (const t of liked) {
    const artists = allArtists(t.artist)
    for (const a of artists) {
      if (!a) continue
      profile.artistWeights.set(a, (profile.artistWeights.get(a) ?? 0) + LIKE_ARTIST_BOOST / Math.max(1, artists.length))
    }
    for (const tag of styleTagsFor(t)) {
      profile.tagWeights.set(tag, (profile.tagWeights.get(tag) ?? 0) + LIKE_TAG_BOOST)
    }
  }

  for (const w of profile.artistWeights.values()) profile.maxArtistWeight = Math.max(profile.maxArtistWeight, w)
  for (const w of profile.tagWeights.values()) profile.maxTagWeight = Math.max(profile.maxTagWeight, w)
  return profile
}

/** Normalized 0..1 affinity for one artist. */
export function artistAffinity(profile: ListeningProfile, artist: string | undefined): number {
  const key = primaryArtist(artist)
  if (!key || profile.maxArtistWeight <= 0) return 0
  return (profile.artistWeights.get(key) ?? 0) / profile.maxArtistWeight
}

/** Mean normalized affinity across a track's style tags (0 when none known). */
export function tagAffinity(profile: ListeningProfile, track: Pick<Track, 'tags' | 'title'>): number {
  const tags = styleTagsFor(track)
  if (tags.length === 0 || profile.maxTagWeight <= 0) return 0
  let sum = 0
  for (const tag of tags) sum += profile.tagWeights.get(tag) ?? 0
  return Math.min(1, sum / tags.length / profile.maxTagWeight)
}

/** 1 when the candidate shares a meaningful title token with `other`. */
export function sharesTitleToken(candidate: Pick<Track, 'title'>, other: Pick<Track, 'title'>): boolean {
  const a = titleTokens(candidate.title)
  if (a.length === 0) return false
  const b = new Set(titleTokens(other.title))
  return a.some((token) => b.has(token))
}

export { EMPTY_PROFILE }
