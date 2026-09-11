/**
 * Web recommendation engine — the brain behind autoplay on the web build.
 *
 * Conceptual pipeline (mirrors YouTube Music / Spotify autoplay, deterministic):
 *
 *   current track + listening profile + session context
 *     → candidate POOLS:
 *         1. the seed's real radio mix (RDAMVM, genuine provider recommendations)
 *         2. taste anchors: top artists of the learned profile (searched, capped)
 *         3. style anchors: top genre tokens of the learned profile (searched, capped)
 *     → hard filters      (music-shaped, not disliked, not just played)
 *     → personal scoring  (lib/profile.scoreCandidatePersonal + radio tasteScore)
 *     → diversity interleave (no artist runs, no style walls)
 *     → ROLLING buffer: append a bounded batch, never wipe the queue
 *
 * The engine is PURE: fetches are injected via the `Fetcher` interface, so
 * tests simulate whole listening sessions without any network.
 */
import type { Track } from '../bridge/types'
import { canonicalSongKey, identityKeyOf, splitArtists, MIN_RADIO_DURATION, MAX_RADIO_DURATION } from './radio'
import {
  canonicalArtistOf, canonicalTrackKey, genreTokensOf, scoreCandidatePersonal, type ListeningProfile,
} from './profile'
import { isSongCandidate } from './songCandidateFilter'

/** The candidate sources the engine may consult. */
export interface RecommendationFetcher {
  radioMix(sourceId: string): Promise<Track[]>
  artistTopSongs(artist: string): Promise<Track[]>
  styleTopSongs(style: string): Promise<Track[]>
}

/** Everything the engine knows about the listening context right now. */
export interface RecommendationContext {
  /** The track currently playing (the session anchor). */
  current: Track
  /** Tracks played recently this session, newest first. */
  sessionRecent: Track[]
  /** The learned listening profile. */
  profile: ListeningProfile
  /** Explicitly liked tracks. */
  liked: Track[]
  /** Explicit dislikes ("don't recommend"). */
  disliked: ReadonlySet<string>
  /** The explicit user queue + current autoplay buffer (never duplicated). */
  queued: Track[]
  /** Tracks actually played before (persistent history tail). */
  heardTrackKeys?: ReadonlySet<string>
}

export interface RecommendationOptions {
  /** How many tracks the buffer should ideally hold (target level). */
  target: number
  /** Hard cap of the rolling buffer. */
  max: number
  /** Candidates requested per generation (bounded, small). */
  batch: number
  /** Max per-artist appearances inside the FINAL buffer. */
  maxPerArtist: number
  /** How many anchor fetches (artist/style) one generation may spend. */
  maxAnchorFetches: number
}

export const DEFAULT_RECOMMENDATION_OPTIONS: RecommendationOptions = {
  target: 10,
  max: 30,
  batch: 8,
  maxPerArtist: 3,
  maxAnchorFetches: 2,
}

/** Hard filters shared by every pool. */
function isCandidate(track: Track, ctx: RecommendationContext, queuedKeys: Set<string>): boolean {
  if (!track?.sourceId) return false
  if (ctx.disliked.has(track.id)) return false
  if (queuedKeys.has(canonicalSongKey(track))) return false
  if (track.duration > 0) {
    if (track.duration < MIN_RADIO_DURATION || track.duration > MAX_RADIO_DURATION) return false
  }
  // Multi-signal non-song filter: rejects teasers, trailers, promos,
  // interviews, compilations, etc. while preserving legitimate songs.
  if (!isSongCandidate(track)) return false
  return true
}

/**
 * Generates one bounded batch of recommendations to APPEND to the rolling
 * buffer. Never returns tracks already queued, disliked or just played.
 *
 * Anchor priority:
 *   1. the current track's genuine radio mix (the provider's own graph)
 *   2. profile artist anchors (what the user listens to over time)
 *   3. profile style anchors (genre affinity, e.g. "tamil", "phonk")
 *
 * The mix anchors relevance to the CURRENT track; the anchors weave in the
 * user's broader taste, so a session drifts coherently instead of either
 * collapsing into the seed's artist or jumping randomly.
 */
export async function generateRecommendations(
  fetcher: RecommendationFetcher,
  ctx: RecommendationContext,
  opts: RecommendationOptions = DEFAULT_RECOMMENDATION_OPTIONS,
): Promise<Track[]> {
  const queuedKeys = new Set<string>([
    ...ctx.queued.map(canonicalSongKey),
    ...ctx.sessionRecent.map((t) => canonicalTrackKey(t)),
  ])
  const queuedIds = new Set(ctx.queued.map((t) => t.id))
  void queuedIds

  const pools: { weight: number; tracks: Track[] }[] = []

  // ---- pool 1: the seed's genuine radio mix ----
  let mix: Track[] = []
  try {
    mix = await fetcher.radioMix(ctx.current.sourceId)
  } catch {
    mix = []
  }
  mix = mix.filter((t) => isCandidate(t, ctx, queuedKeys))
  if (mix.length > 0) pools.push({ weight: 1, tracks: mix })

  // ---- pool 2+3: taste anchors from the profile ----
  const currentArtist = canonicalArtistOf(ctx.current)
  const currentGenres = genreTokensOf(ctx.current)
  const anchorArtists = pickAnchorArtists(ctx, currentArtist)
  const anchorStyles = pickAnchorStyles(ctx, currentGenres)

  let anchorFetches = 0
  const artistPool: Track[] = []
  for (const artist of anchorArtists) {
    if (anchorFetches >= opts.maxAnchorFetches) break
    anchorFetches += 1
    try {
      const songs = (await fetcher.artistTopSongs(artist)).filter((t) => isCandidate(t, ctx, queuedKeys))
      artistPool.push(...songs)
    } catch {
      /* an anchor that fails is skipped, never fatal */
    }
  }
  const stylePool: Track[] = []
  for (const style of anchorStyles) {
    if (anchorFetches >= opts.maxAnchorFetches) break
    anchorFetches += 1
    try {
      const songs = (await fetcher.styleTopSongs(style)).filter((t) => isCandidate(t, ctx, queuedKeys))
      stylePool.push(...songs)
    } catch {
      /* best-effort */
    }
  }
  if (artistPool.length > 0) pools.push({ weight: 0.75, tracks: artistPool })
  if (stylePool.length > 0) pools.push({ weight: 0.6, tracks: stylePool })

  if (pools.length === 0) return []

  // ---- score every candidate once ----
  const likedArtistKeys = new Set(ctx.liked.map((t) => splitArtists(t.artist)[0]).filter(Boolean))
  const queuedArtistCounts = new Map<string, number>()
  for (const t of ctx.queued) {
    const artist = splitArtists(t.artist)[0]
    if (artist) queuedArtistCounts.set(artist, (queuedArtistCounts.get(artist) ?? 0) + 1)
  }
  const heardKeys = ctx.heardTrackKeys ?? new Set<string>()

  const scored = new Map<string, { track: Track; score: number; order: number; fromMix: boolean }>()
  pools.forEach((pool, poolIndex) => {
    pool.tracks.forEach((track, rank) => {
      if (scored.has(track.id)) return
      const personal = scoreCandidatePersonal({
        track,
        currentArtist,
        currentGenres,
        profile: ctx.profile,
        queuedTrackKeys: queuedKeys,
        queuedArtistCounts,
        likedArtistKeys,
      })
      const poolRankBonus = pool.weight * Math.max(0, 1 - rank / Math.max(1, pool.tracks.length)) * 1.2
      const fromMix = poolIndex === 0
      let score = personal + poolRankBonus
      if (heardKeys.has(canonicalTrackKey(track))) score -= 1.6
      scored.set(track.id, { track, score, order: poolIndex * 1000 + rank, fromMix })
    })
  })

  // ---- diversity-aware assembly over the combined, ranked list ----
  const ranked = [...scored.values()].sort(
    (a, b) => b.score - a.score || a.order - b.order,
  )
  return interleave(ranked, opts, ctx, queuedArtistCounts)
}

/** Chooses profile artists worth anchoring on (never the seed's own artist). */
function pickAnchorArtists(ctx: RecommendationContext, currentArtist: string): string[] {
  const artists: string[] = []
  // The profile's top artists, strongest first.
  for (const [artist, weight] of [...Object.entries(ctx.profile.artistAffinity)].sort((a, b) => b[1] - a[1])) {
    if (artist === currentArtist) continue
    artists.push(artist)
    if (artists.length >= 3) break
    void weight
  }
  return artists
}

/** Chooses style/genre anchors (shared tokens with the current track first). */
function pickAnchorStyles(ctx: RecommendationContext, currentGenres: string[]): string[] {
  const weights = Object.entries(ctx.profile.genreAffinity).sort((a, b) => b[1] - a[1])
  const styles: string[] = []
  // Genres shared with the current track are the most coherent anchors.
  for (const genre of currentGenres) {
    if ((ctx.profile.genreAffinity[genre] ?? 0) > 0 || styles.length === 0) styles.push(genre)
  }
  for (const [genre] of weights) {
    if (styles.includes(genre)) continue
    styles.push(genre)
    if (styles.length >= 3) break
  }
  return styles.slice(0, 2)
}

/**
 * Diversity interleave: pick by score, but never let one identity run or
 * saturate the batch. Deferred candidates are retried as the window moves —
 * deferral, not rejection, so a homogeneous pool still fills.
 */
function interleave(
  ranked: { track: Track; score: number; order: number; fromMix: boolean }[],
  opts: RecommendationOptions,
  ctx: RecommendationContext,
  queuedArtistCounts: Map<string, number>,
): Track[] {
  const windowSize = 6
  const maxInWindow = 2
  const window: string[] = ctx.queued.slice(-windowSize).map(identityKeyOf)
  const perArtist = new Map(queuedArtistCounts)
  const picked: Track[] = []
  const limit = Math.min(opts.batch, Math.max(0, opts.max - ctx.queued.length))
  if (limit <= 0) return []

  const canPick = (identity: string): boolean => {
    if (!identity) return true
    const inWindow = window.slice(-windowSize).filter((a) => a === identity).length
    if (inWindow >= maxInWindow) return false
    if ((perArtist.get(identity) ?? 0) >= opts.maxPerArtist) return false
    return true
  }
  const commit = (identity: string): void => {
    window.push(identity)
    if (window.length >= windowSize) window.shift()
    if (identity) perArtist.set(identity, (perArtist.get(identity) ?? 0) + 1)
  }

  let pending = ranked
  while (picked.length < limit && pending.length > 0) {
    const deferred: typeof ranked = []
    let progressed = false
    for (const entry of pending) {
      if (picked.length >= limit) break
      const identity = identityKeyOf(entry.track)
      if (identity && !canPick(identity)) {
        deferred.push(entry)
        continue
      }
      picked.push(entry.track)
      commit(identity)
      progressed = true
    }
    if (!progressed) {
      // Nothing fit the diversity rules; fill the remainder in score order —
      // a starved batch must not become empty just because every candidate
      // shares an identity the listener explicitly plays.
      for (const entry of deferred) {
        if (picked.length >= limit) break
        picked.push(entry.track)
      }
      break
    }
    pending = deferred
  }
  return picked
}

/**
 * Buffer management: decides whether a refill is due and how the fresh batch
 * merges. The buffer is a ROLLING window: new batches APPEND, the tail is
 * capped, and explicit entries are never touched (the controller owns them).
 */
export function mergeIntoBuffer(buffer: Track[], fresh: Track[], max: number): Track[] {
  const seen = new Set(buffer.map((t) => t.id))
  const additions = fresh.filter((t) => !seen.has(t.id))
  if (additions.length === 0) return buffer
  const merged = [...buffer, ...additions]
  return merged.length > max ? merged.slice(merged.length - max) : merged
}
