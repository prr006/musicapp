/**
 * Deterministic recommendation scoring and selection.
 *
 * A candidate's score combines everything the profile knows:
 *
 *   score =  current-track relevance
 *          + recent-history relevance
 *          + artist affinity        (what you usually play)
 *          + style/genre affinity
 *          + liked-artist bonus
 *          + provider rank          (the search engine's own relevance)
 *          - recently-played penalty
 *          - repeated-artist penalty (what's already in the buffer)
 *          - current-artist flood penalty
 *
 * Diversity is enforced structurally, never randomly: the selector below
 * greedily takes the best-scored candidates but caps consecutive runs and
 * per-artist share of the buffer, so a high-affinity artist can lead the mix
 * without turning the queue into a discography dump.
 *
 * Same inputs → same output. Always.
 */
import type { Track } from '../bridge/types'
import {
  allArtists, primaryArtist, artistAffinity, sharesTitleToken, styleTagsFor, tagAffinity,
  titleTokens, type ListeningProfile,
} from './profile'
import { normalizeTitle } from './discovery'

export const W_CURRENT_ARTIST = 1.0
export const W_CURRENT_TITLE = 0.45
export const W_CURRENT_ALBUM = 0.35
export const W_RECENT_ARTIST = 0.7;
export const W_RECENT_TITLE = 0.3
export const W_ARTIST_AFFINITY = 1.6
export const W_TAG_AFFINITY = 0.5
export const W_LIKED_ARTIST = 0.4
export const W_SEARCH_RANK = 0.45
/** Per same-artist track already queued ahead in the buffer. */
export const P_REPEATED_ARTIST = 0.4
/** When the buffer already leans heavily on the current artist. */
export const P_CURRENT_ARTIST_FLOOD = 0.8
/** Played before, but not recently — old favourites may return, gently. */
export const P_EVER_PLAYED = 0.2
/**
 * Played recently (but outside the hard session window) — deprioritised, but
 * never enough to outrank a strong affinity: a favourite the listener keeps
 * coming back to is worth more than a random fresh track.
 */
export const P_RECENTLY_PLAYED = 0.45

/** Never more than this many consecutive tracks from one artist. */
export const MAX_ARTIST_RUN = 2
/** Titles that indicate uploads the player should not autoplay. */
const UPLOAD_NOISE = /1 hour|2 hours|full album|complete collection|nonstop|medley|compilation/i
/** Hard duration ceiling for autoplay candidates. */
const MAX_CANDIDATE_DURATION = 60 * 60

export interface RecommendationContext {
  current: Track | null
  profile: ListeningProfile
  /** Track ids that may not be recommended right now. */
  blockedIds: Set<string>
  /** Normalized titles that may not repeat (session + recent). */
  blockedTitleKeys: Set<string>
  /** The current autoplay buffer, used for repeated-artist penalties. */
  buffer: Track[]
}

export interface ScoredCandidate {
  track: Track
  score: number
  /** Position in the provider's results — an external relevance signal. */
  searchRank: number
}

/** True when a candidate is structurally disqualified from autoplay. */
export function isDisqualified(track: Track, ctx: RecommendationContext): boolean {
  if (!track?.id) return true
  if (ctx.blockedIds.has(track.id)) return true
  if (ctx.profile.skipIds.has(track.id)) return true
  const key = normalizeTitle(track.title)
  if (key && ctx.blockedTitleKeys.has(key)) return true
  if (track.duration > MAX_CANDIDATE_DURATION) return true
  if (UPLOAD_NOISE.test(track.title ?? '')) return true
  return false
}

export function scoreCandidate(
  track: Track,
  ctx: RecommendationContext,
  searchRank = 0,
): number {
  const { current, profile } = ctx
  let score = 0

  if (current) {
    const currentPrimary = primaryArtist(current.artist)
    const trackPrimary = primaryArtist(track.artist)
    if (currentPrimary && trackPrimary === currentPrimary) score += W_CURRENT_ARTIST
    if (sharesTitleToken(track, current)) score += W_CURRENT_TITLE
    if (current.album && track.album && current.album.toLowerCase() === track.album.toLowerCase()) {
      score += W_CURRENT_ALBUM
    }
  }

  // Recent history: which artists define the current listening streak.
  const artistRank = profile.recentArtists.indexOf(primaryArtist(track.artist))
  if (artistRank >= 0) {
    const recency = 1 - artistRank / Math.max(1, profile.recentArtists.length)
    score += W_RECENT_ARTIST * recency
  }
  const trackTitleTokens = titleTokens(track.title)
  if (trackTitleTokens.length > 0) {
    for (const recentKey of profile.recentTitleKeys.slice(0, 15)) {
      const recentTokens = new Set(recentKey.split(' '))
      if (trackTitleTokens.some((t) => recentTokens.has(t))) {
        score += W_RECENT_TITLE
        break
      }
    }
  }

  // Long-term affinities: what this listener keeps coming back to.
  score += W_ARTIST_AFFINITY * artistAffinity(profile, track.artist)
  score += W_TAG_AFFINITY * tagAffinity(profile, track)

  for (const a of allArtists(track.artist)) {
    if (profile.likedArtists.has(a)) {
      score += W_LIKED_ARTIST
      break
    }
  }

  // The provider's own ranking is a real relevance/popularity signal.
  score += W_SEARCH_RANK / (1 + searchRank * 0.2)

  // Penalties.
  const playCount = profile.playCounts.get(track.id) ?? 0
  if (playCount > 0) score -= P_EVER_PLAYED
  // Recently heard but outside the hard exclusion window: strongly
  // deprioritised, not banned — the listener's favourites may return.
  if (profile.recentTrackIds.indexOf(track.id) >= 0) score -= P_RECENTLY_PLAYED
  const bufferArtistCount = ctx.buffer.filter(
    (t) => primaryArtist(t.artist) === primaryArtist(track.artist),
  ).length
  score -= P_REPEATED_ARTIST * bufferArtistCount

  if (current) {
    const currentPrimary = primaryArtist(current.artist)
    const currentArtistInBuffer = ctx.buffer.filter(
      (t) => primaryArtist(t.artist) === currentPrimary,
    ).length
    if (currentArtistInBuffer >= 3 && primaryArtist(track.artist) === currentPrimary) {
      score -= P_CURRENT_ARTIST_FLOOD
    }
  }

  return score
}

function maxArtistShare(bufferLength: number, adding: number): number {
  // An artist may take at most ~40% of the (existing + new) buffer, min 2.
  return Math.max(2, Math.ceil((bufferLength + adding) * 0.4))
}

/**
 * Picks up to `limit` diverse, relevant candidates in score order.
 * Deterministic: ties break by search rank, then stable input order.
 */
export function selectRecommendations(
  candidates: Track[],
  ctx: RecommendationContext,
  limit: number,
): Track[] {
  const seenIds = new Set<string>()
  const seenTitles = new Set<string>()
  const scored: ScoredCandidate[] = []
  for (let i = 0; i < candidates.length; i += 1) {
    const track = candidates[i]
    if (!track || isDisqualified(track, ctx)) continue
    const idKey = track.id
    const titleKey = normalizeTitle(track.title)
    if (seenIds.has(idKey)) continue
    if (titleKey && seenTitles.has(titleKey)) continue
    seenIds.add(idKey)
    if (titleKey) seenTitles.add(titleKey)
    scored.push({ track, score: scoreCandidate(track, ctx, i), searchRank: i })
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.searchRank !== b.searchRank) return a.searchRank - b.searchRank
    return a.track.id < b.track.id ? -1 : 1
  })

  const artistCounts = new Map<string, number>()
  for (const t of ctx.buffer) {
    const key = primaryArtist(t.artist)
    artistCounts.set(key, (artistCounts.get(key) ?? 0) + 1)
  }
  const cap = maxArtistShare(ctx.buffer.length, limit)

  const picked: Track[] = []
  const deferred: ScoredCandidate[] = []
  const runArtist = () => primaryArtist(picked[picked.length - 1]?.artist)
  const runLength = () => {
    let n = 0
    const artist = runArtist()
    for (let i = picked.length - 1; i >= 0; i -= 1) {
      if (primaryArtist(picked[i].artist) === artist) n += 1
      else break
    }
    return n
  }

  for (const cand of scored) {
    if (picked.length >= limit) break
    const artist = primaryArtist(cand.track.artist)
    const count = artistCounts.get(artist) ?? 0
    if (count >= cap) continue
    if (artist && artist === runArtist() && runLength() >= MAX_ARTIST_RUN) {
      deferred.push(cand)
      continue
    }
    picked.push(cand.track)
    artistCounts.set(artist, count + 1)
  }
  // Second pass for deferred candidates once the run has been broken — keeps
  // relevance ahead of diversity, without ever allowing long same-artist runs.
  for (const cand of deferred) {
    if (picked.length >= limit) break
    const artist = primaryArtist(cand.track.artist)
    const count = artistCounts.get(artist) ?? 0
    if (count >= cap) continue
    if (artist && artist === runArtist() && runLength() >= MAX_ARTIST_RUN) continue
    picked.push(cand.track)
    artistCounts.set(artist, count + 1)
  }
  return picked
}

/**
 * Re-orders an existing buffer around a new anchor track (the user just
 * picked something else explicitly). Every item is preserved — nothing is
 * dropped or replaced — but the most relevant items surface first.
 */
export function reRankBuffer(buffer: Track[], ctx: RecommendationContext): Track[] {
  if (buffer.length <= 1) return buffer
  const remaining = buffer.map((track, i) => ({ track, i }))
  const artistCounts = new Map<string, number>()
  const out: Track[] = []
  while (remaining.length > 0) {
    let bestIndex = 0
    let bestScore = -Infinity
    for (let idx = 0; idx < remaining.length; idx += 1) {
      const { track, i } = remaining[idx]
      const score = scoreCandidate(track, { ...ctx, buffer: out }, i)
      const artist = primaryArtist(track.artist)
      const count = artistCounts.get(artist) ?? 0
      const penalized = score - P_REPEATED_ARTIST * count
      if (penalized > bestScore + 1e-9) {
        bestScore = penalized
        bestIndex = idx
      }
    }
    const [chosen] = remaining.splice(bestIndex, 1)
    out.push(chosen.track)
    const artist = primaryArtist(chosen.track.artist)
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1)
  }
  return out
}

/** Style tags of a track, for callers that need them (e.g. tests, panels). */
export function candidateTags(track: Track): string[] {
  return styleTagsFor(track)
}

/**
 * The anchor queries a recommendation fetch searches for, split into:
 *
 *   current — anchored on what is playing *right now* (its artist, then a
 *             song-radio style title query)
 *   profile — anchored on who the listener actually is: strongest artist
 *             affinities, liked artists, and the recent streak
 *
 * The recommender blends one from each side in every fetch, so each batch
 * combines "right now" with "what you keep coming back to" — never just the
 * current artist, and never just history.
 */
export interface AnchorSet {
  current: string[]
  profile: string[]
}

export function anchorQueries(
  current: Track | null,
  profile: ListeningProfile,
  liked: Track[],
): AnchorSet {
  const dedupe = (queries: string[]): string[] => {
    const seen = new Set<string>()
    const out: string[] = []
    for (const q of queries) {
      const key = q.trim().toLowerCase()
      if (!key || seen.has(key)) continue
      seen.add(key)
      out.push(q.trim())
    }
    return out
  }

  const currentArtist = current ? current.artist.split(',')[0].trim() : ''
  const currentAnchors: string[] = []
  if (current) {
    if (currentArtist) currentAnchors.push(currentArtist)
    const title = current.title.replace(/[((/][^)/]*[))/]/g, '').trim()
    if (title) currentAnchors.push(title && currentArtist ? `${title} ${currentArtist}` : title)
  }

  const profileAnchors: string[] = []
  // Long-term affinities: the artists this listener keeps returning to.
  const byWeight = [...profile.artistWeights.entries()]
    .filter(([artist]) => artist !== primaryArtist(currentArtist))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  for (const [artist] of byWeight.slice(0, 5)) profileAnchors.push(artist)

  // Liked artists that affinity alone hasn't already surfaced.
  for (const t of liked.slice(0, 3)) {
    const artist = t.artist.split(',')[0].trim()
    if (artist && artist.toLowerCase() !== primaryArtist(currentArtist)) profileAnchors.push(artist)
  }

  // The recent streak — what the last few hours of listening looked like.
  for (const artist of profile.recentArtists.slice(0, 6)) {
    if (artist !== primaryArtist(currentArtist)) profileAnchors.push(artist)
  }

  return { current: dedupe(currentAnchors), profile: dedupe(profileAnchors) }
}
