/**
 * Pure selectors over the local listening history + play stats: the "taste"
 * layer the radio engine and the Library/Home views share.
 *
 * Everything is derived from the bounded persisted state — no extra storage,
 * no background computation.
 */
import type { PlayRecord, PlayStats, Track } from '../bridge/types'
import { splitArtists } from './radio'

export interface TasteSnapshot {
  /** Track ids from the innermost window — excluded from radio outright. */
  recentIds: Set<string>
  /** Track ids from the wider recency window — down-ranked, not excluded. */
  heardIds: Set<string>
  /** Primary artist keys heard recently. */
  recentArtistKeys: Set<string>
  /** Raw play counts per canonical primary artist. */
  artistPlays: Map<string, number>
  /**
   * Completion-weighted artist affinity: a completed listen counts far more
   * than a bare start (which may have been a skip). This is the number the
   * ranker personalizes with — feedback quality matters, not just clicks.
   */
  artistAffinity: Map<string, number>
  /** Skip rate per canonical primary artist (skips / plays), plays ≥ 2. */
  artistSkipRates: Map<string, number>
  /** Track id → net recent skips (skip − complete). */
  netSkips: Map<string, number>
}

/** How strongly each listening event feeds artist affinity. */
export const AFFINITY_PER_PLAY = 0.5
export const AFFINITY_PER_SIGNIFICANT = 0.25
export const AFFINITY_PER_COMPLETION = 1.0

/** Completion-weighted affinity for one track's stats. */
export function trackAffinity(stats: PlayStats | undefined, playedWithoutStats = false): number {
  if (!stats) return playedWithoutStats ? AFFINITY_PER_PLAY : 0
  return (
    stats.playCount * AFFINITY_PER_PLAY +
    stats.significantCount * AFFINITY_PER_SIGNIFICANT +
    stats.completeCount * AFFINITY_PER_COMPLETION
  )
}

/**
 * Condenses history + stats into the small snapshot the ranker needs.
 * `recentWindow` is how many plays count as "heard recently" (down-ranked);
 * the innermost `freshWindow` counts as "just played" (excluded outright).
 */
export function tasteSnapshot(
  history: PlayRecord[],
  stats: Record<string, PlayStats>,
  recentWindow = 40,
  freshWindow = 6,
): TasteSnapshot {
  const recentIds = new Set<string>()
  const heardIds = new Set<string>()
  const recentArtistKeys = new Set<string>()
  const artistPlays = new Map<string, number>()
  const artistAffinity = new Map<string, number>()
  const artistSkipRates = new Map<string, number>()
  const netSkips = new Map<string, number>()

  history.slice(0, recentWindow).forEach((record, i) => {
    heardIds.add(record.track.id)
    if (i < freshWindow) recentIds.add(record.track.id)
    const primary = splitArtists(record.track.artist)[0] ?? ''
    if (primary) recentArtistKeys.add(primary)
  })

  for (const [id, s] of Object.entries(stats ?? {})) {
    netSkips.set(id, Math.max(0, s.skipCount - s.completeCount))
  }

  // Artist play counts and completion-weighted affinity come from stats when
  // available (they survive history trimming), otherwise from history records.
  // Skip rates accumulate per artist so frequently-abandoned artists can be
  // gently down-weighted without ever blacklisting them.
  const artistSkips = new Map<string, number>()
  const artistPlayTotals = new Map<string, number>()
  const bump = (m: Map<string, number>, key: string, n: number) => m.set(key, (m.get(key) ?? 0) + n)
  for (const record of history) {
    const primary = splitArtists(record.track.artist)[0] ?? ''
    if (!primary) continue
    const id = record.track.id
    const s = stats?.[id]
    const plays = s ? s.playCount : 1
    bump(artistPlays, primary, plays)
    bump(artistAffinity, primary, trackAffinity(s, !s))
    bump(artistPlayTotals, primary, s ? s.playCount : 1)
    if (s) bump(artistSkips, primary, s.skipCount)
  }
  for (const [artist, plays] of artistPlayTotals) {
    if (plays >= 2) artistSkipRates.set(artist, (artistSkips.get(artist) ?? 0) / plays)
  }

  return { recentIds, heardIds, recentArtistKeys, artistPlays, artistAffinity, artistSkipRates, netSkips }
}

export interface PlayedTrack {
  track: Track
  playCount: number
  completeCount: number
  lastPlayedAt: number
}

/**
 * Most played tracks — the reusable "Most played" list. Only tracks whose
 * metadata is still known (history, likes or dislikes keep the Track object)
 * are returned; the UI never renders a fabricated row.
 */
export function mostPlayed(
  history: PlayRecord[],
  stats: Record<string, PlayStats>,
  limit = 10,
): PlayedTrack[] {
  const known = new Map<string, Track>()
  for (const record of history) known.set(record.track.id, record.track)
  const out: PlayedTrack[] = []
  for (const [id, s] of Object.entries(stats ?? {})) {
    const track = known.get(id)
    if (!track || s.playCount <= 0) continue
    out.push({ track, playCount: s.playCount, completeCount: s.completeCount, lastPlayedAt: s.lastPlayedAt })
  }
  out.sort((a, b) => b.playCount - a.playCount || b.lastPlayedAt - a.lastPlayedAt)
  return out.slice(0, limit)
}

/** Recently played, de-duplicated by track id, newest first. */
export function recentTracks(history: PlayRecord[], limit = 20): Track[] {
  const seen = new Set<string>()
  const out: Track[] = []
  for (const record of history) {
    if (seen.has(record.track.id)) continue
    seen.add(record.track.id)
    out.push(record.track)
    if (out.length >= limit) break
  }
  return out
}

export interface RecentArtist {
  name: string
  track: Track
  playCount: number
}

/** Recently played artists (primary artist of recent history records). */
export function recentArtists(history: PlayRecord[], limit = 12): RecentArtist[] {
  const byArtist = new Map<string, RecentArtist>()
  for (const record of history) {
    const raw = splitArtists(record.track.artist)
    const name = record.track.artist.split(',')[0]?.trim() || ''
    const key = raw[0] ?? name.toLowerCase()
    if (!key) continue
    const existing = byArtist.get(key)
    if (existing) {
      existing.playCount += 1
      continue
    }
    byArtist.set(key, { name: name || key, track: record.track, playCount: 1 })
    if (byArtist.size > limit * 2) break
  }
  return [...byArtist.values()].slice(0, limit)
}
