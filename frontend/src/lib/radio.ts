/**
 * MELO's radio engine: turn one seed track plus the local taste profile into
 * a ranked, de-duplicated, artist-diverse autoplay batch.
 *
 * The engine is deliberately small and readable — weighted signals with names,
 * no ML. Everything here is a pure function so the behaviour is testable.
 *
 * Model (see PlaybackController.doDiscoveryFetch for the sourcing side):
 *
 *   PRIMARY signal   the provider's real recommendation feed ("Up next" /
 *                    autoplay continuation). Its ordering IS the relevance
 *                    graph: provider mode keeps it dominant and local taste
 *                    only nudges a few positions (likes lift, heard/skipped
 *                    sink). Text-search results are NEVER candidates while
 *                    the feed answers.
 *
 *   SECONDARY signal local taste (history, likes, dislikes, recent skips,
 *                    artist familiarity) — used to personalize and filter the
 *                    provider's candidates, not to replace the graph.
 *
 *   LAST RESORT      when the feed is unavailable, only songs *verified* as
 *                    belonging to the seed's context (same identified
 *                    performing artist, or same album for album seeds) may
 *                    come from text search. Uploader/channel names never
 *                    generate queries and a shared title is never evidence of
 *                    relatedness ("Fearless" by three unrelated artists).
 *
 * Pipeline:
 *
 *   candidates
 *     → hard filters   (never the current track, duplicates, dislikes,
 *                       very recently played, non-music durations; identity
 *                       verification for text-search batches)
 *     → scoring        (provider order dominant in provider mode; taste and
 *                       seed-context signals nudge; title collisions demoted)
 *     → sorting        (score desc, source order as the tiebreak)
 *     → diversity      (no artist-or-channel runs longer than the window
 *                       allows, unless the whole pool is one identity)
 *     → bounded output (canonical-song dedupe along the way)
 */
import type { PlayStats, Track } from '../bridge/types'
import { normalizeTitle } from './discovery'

// ---------- seeds ----------

export type RadioKind = 'track' | 'artist' | 'album'

/**
 * The anchor a radio is built around. Everything is optional metadata the
 * provider may or may not supply — the engine degrades gracefully.
 */
export interface RadioSeed {
  kind: RadioKind
  id: string
  title: string
  normalizedTitle: string
  /** Canonical (normalized) primary artist — used for comparisons. */
  primaryArtist: string
  /** The provider's own primary-artist string — used for queries. */
  rawArtist: string
  otherArtists: string[]
  /** Raw channel/uploader name; metadata only, never a query or an artist. */
  uploader: string
  album: string
  duration: number
  artwork: string
}

export function radioSeedFromTrack(track: Track, kind: RadioKind = 'track'): RadioSeed {
  const artists = splitArtists(track.artist)
  return {
    kind,
    id: track.id,
    title: track.title,
    normalizedTitle: normalizeTitle(track.title),
    primaryArtist: artists[0] ?? '',
    rawArtist: firstRawArtist(track.artist),
    otherArtists: artists.slice(1),
    uploader: track.uploader ?? '',
    album: track.album ?? '',
    duration: track.duration || 0,
    artwork: track.artwork ?? '',
  }
}

/** The primary artist as the provider spelled it (before normalisation). */
function firstRawArtist(artist: string): string {
  return (artist || '').split(/,| & | feat\.? | ft\.? /i)[0]?.trim() ?? ''
}

/**
 * Identity used for diversity: the performing artist when known, otherwise the
 * canonical uploader/channel. This is what keeps a radio from becoming five
 * consecutive uploads of the same channel — including slowed/remix channels
 * whose tracks carry no artist metadata at all.
 */
export function identityKeyOf(track: Pick<Track, 'artist' | 'uploader'>): string {
  return splitArtists(track.artist ?? '')[0] ?? normalizeArtistKey(track.uploader ?? '')
}

/** "A, B & C" → ['a-ish', 'b', 'c'] with upload-noise ("- Topic") removed. */
export function splitArtists(artist: string): string[] {
  return (artist || '')
    .split(/,| & | feat\.? | ft\.? /i)
    .map(normalizeArtistKey)
    .filter(Boolean)
}

/**
 * Canonical artist identity: lowercase, upload noise ("- Topic", "VEVO")
 * stripped. Used for matching artists across differently-uploaded tracks.
 */
export function normalizeArtistKey(artist: string): string {
  return (artist || '')
    .trim()
    .toLowerCase()
    .replace(/[-–]\s*topic$/, '')
    .replace(/vevo$/, '')
    .replace(/-?\s*official.*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Canonical song identity: the normalized title from the discovery work plus
 * the canonical artist. Keying on both means "Believer (Official Video)" by
 * Imagine Dragons collapses onto "Believer", while two genuinely different
 * songs that merely share a title stay distinct.
 */
export function canonicalSongKey(track: Pick<Track, 'title' | 'artist'>): string {
  const title = normalizeTitle(track.title)
  const artist = normalizeArtistKey(splitArtists(track.artist || '')[0] ?? '')
  return artist ? `${title}|${artist}` : title
}

// ---------- ranking context ----------

export interface RadioContext {
  seed: RadioSeed
  /** Track ids that may never appear (current, user queue, existing autoplay). */
  blockedIds: Set<string>
  /** Canonical song keys that may never appear (current + both queues). */
  blockedKeys: Set<string>
  /** Disliked ("don't recommend") track ids — always excluded. */
  dislikedIds: Set<string>
  /** Played within the last few songs — excluded outright. */
  veryRecentIds: Set<string>
  /** Played within the recent window — merely down-ranked. */
  heardIds: Set<string>
  /** Primary artists heard in the recent window — mild variety penalty. */
  recentArtistKeys: Set<string>
  likedIds: Set<string>
  likedArtistKeys: Set<string>
  /** Play counts per canonical artist from local listening history. */
  artistPlays: Map<string, number>
  /** Net recent skips per track id (skipCount − completeCount), floored at 0. */
  netSkips: Map<string, number>
}

// ---------- scoring ----------

/** Positive: same artist as the seed is the backbone of a good radio. */
export const W_SAME_ARTIST = 2.2
/** A featured/collaborating artist of the seed is a softer match. */
export const W_SEED_FEATURE_ARTIST = 0.8
/** Same album as the seed: strong album-context relevance. */
export const W_ALBUM = 1.4
/** The user liked this exact song. */
export const W_LIKED_TRACK = 1.6
/** The user liked other songs by this artist. */
export const W_LIKED_ARTIST = 1.2
/** Frequently played artists (local taste) — capped, smooth growth. */
export const W_TASTE_ARTIST_MAX = 1.5
/** Relevance of the provider's own ordering of a text-search result list. */
export const W_PROVIDER_RANK_MAX = 1.8
/**
 * When candidates come from the provider's real recommendation feed, its order
 * IS the relevance signal — the engine must not destroy it with its own
 * sorting. This scale dominates every taste signal combined so personalization
 * only nudges songs a few positions rather than reordering the radio.
 */
export const W_PROVIDER_ORDER = 10
/** Well-formed music metadata (album known). */
export const W_HAS_ALBUM = 0.3
/** Music-shaped duration. */
export const W_DURATION_FIT = 0.2

/** Negative: heard in the recent (but not the very last) window. */
export const W_HEARD_RECENTLY = -2.4
/** Negative per net recent skip — deliberately weaker than a dislike. */
export const W_SKIP = -1.1
/** Negative: artist already dominated the recent window. */
export const W_RECENT_ARTIST = -0.5
/** Penalty when the duration is outside a plausible song shape. */
export const W_ODD_DURATION = -1.2
/**
 * A shared title is NOT evidence of relatedness: "Fearless" by Taylor Swift,
 * Pink Floyd and LE SSERAFIM are unrelated songs. When a candidate carries the
 * seed's normalized title but a different artist, demote it — title
 * normalization exists for deduplication, never for recommendation relevance.
 */
export const W_TITLE_COLLISION = -0.8

/** A "real listen" threshold used when stats are interpreted. */
export const SIGNIFICANT_SECONDS = 30

/** Durations outside this range are treated as non-music (mixes, intros…). */
export const MIN_RADIO_DURATION = 45
export const MAX_RADIO_DURATION = 3600

export interface ScoredCandidate {
  track: Track
  score: number
}

/** Where the candidates came from — decides how strongly to trust their order. */
export type RadioSourceKind = 'provider' | 'search'

/**
 * Scores one candidate. All signals are additive and named above; the function
 * is exported so tests can assert individual weights end-to-end.
 *
 * `source` matters: for 'provider' batches (a real recommendation feed) the
 * provider's own ordering dominates — taste only nudges within it. For
 * 'search' batches (the last-resort same-artist fallback) the smaller search
 * weights apply.
 */
export function scoreCandidate(
  track: Track,
  ctx: RadioContext,
  /** 0-based position of the candidate in its source list, and the list size. */
  providerRank: number,
  providerTotal: number,
  source: RadioSourceKind = 'search',
): number {
  const artists = splitArtists(track.artist)
  const primary = artists[0] ?? ''
  let score = 0

  // --- positive signals ---
  if (ctx.seed.primaryArtist && primary === ctx.seed.primaryArtist) {
    score += W_SAME_ARTIST
  } else if (artists.some((a) => ctx.seed.otherArtists.includes(a))) {
    score += W_SEED_FEATURE_ARTIST
  }
  if (ctx.seed.album && (track.album || '').toLowerCase() === ctx.seed.album.toLowerCase()) {
    score += W_ALBUM
  }
  if (ctx.likedIds.has(track.id)) score += W_LIKED_TRACK
  if (primary && ctx.likedArtistKeys.has(primary)) score += W_LIKED_ARTIST
  if (primary) {
    const plays = ctx.artistPlays.get(primary) ?? 0
    if (plays > 0) score += W_TASTE_ARTIST_MAX * (plays / (plays + 6))
  }
  if (providerTotal > 1) {
    const scale = source === 'provider' ? W_PROVIDER_ORDER : W_PROVIDER_RANK_MAX
    score += scale * (1 - providerRank / providerTotal)
  }
  if (track.album) score += W_HAS_ALBUM

  // --- duration shape (unknown durations are merely not rewarded) ---
  if (track.duration > 0) {
    if (track.duration >= 60 && track.duration <= 600) score += W_DURATION_FIT
    else if (track.duration < MIN_RADIO_DURATION || track.duration > MAX_RADIO_DURATION) score += W_ODD_DURATION
  }

  // --- negative signals ---
  if (ctx.heardIds.has(track.id)) score += W_HEARD_RECENTLY
  const skips = ctx.netSkips.get(track.id) ?? 0
  if (skips > 0) score += W_SKIP * Math.min(skips, 2)
  if (primary && ctx.recentArtistKeys.has(primary)) score += W_RECENT_ARTIST
  // A matching title with a *different* artist is the classic false-positive
  // shape (three unrelated songs called "Fearless") — demoted, never boosted.
  if (
    ctx.seed.normalizedTitle &&
    primary !== ctx.seed.primaryArtist &&
    normalizeTitle(track.title) === ctx.seed.normalizedTitle
  ) {
    score += W_TITLE_COLLISION
  }

  return score
}

/**
 * Verifies that a text-search candidate genuinely belongs to the seed's
 * listening context: it must share the seed's *identified* performing artist
 * (or, for album seeds, the album). Title similarity is never accepted as
 * evidence — this is the gate that keeps ordinary search out of autoplay.
 */
export function verifiedSeedContext(candidate: Track, seed: RadioSeed): boolean {
  if (!seed.primaryArtist) return false // uploader-only seeds never text-search
  const candArtist = splitArtists(candidate.artist ?? '')[0] ?? ''
  if (candArtist && candArtist === seed.primaryArtist) return true
  if (
    seed.kind === 'album' &&
    seed.album &&
    candidate.album &&
    candidate.album.toLowerCase() === seed.album.toLowerCase()
  ) {
    return true
  }
  return false
}

// ---------- batch assembly ----------

export interface RadioBuildOptions {
  limit?: number
  /** Max occurrences of one artist inside any window of tracks. */
  maxPerArtistInWindow?: number
  windowSize?: number
  /** Identities already queued at the tail of the autoplay list. */
  queueTailArtists?: string[]
  /** Where the candidates came from; 'provider' preserves recommendation order. */
  source?: RadioSourceKind
  /**
   * Hard identity gate for text-search batches: every candidate must be
   * verified as belonging to the seed's context (same performing artist, or
   * the same album for album seeds). The engine sets this for the
   * last-resort fallback — never for the provider's recommendation feed.
   */
  verifiedOnly?: boolean
}

/**
 * Builds the autoplay batch: filter → score → sort → diversity → bound.
 * Candidates keep their source order as the stable tiebreak, so the output is
 * deterministic for a given input (no randomness in the radio).
 */
export function buildRadioBatch(
  candidates: Track[],
  ctx: RadioContext,
  opts: RadioBuildOptions = {},
): Track[] {
  const limit = Math.max(1, opts.limit ?? 20)
  const windowSize = Math.max(2, opts.windowSize ?? 5)
  const maxInWindow = Math.max(1, opts.maxPerArtistInWindow ?? 2)
  const source: RadioSourceKind = opts.source ?? 'search'

  // 1) hard filters
  const seenIds = new Set<string>(ctx.blockedIds)
  const seenKeys = new Set<string>(ctx.blockedKeys)
  const eligible: ScoredCandidate[] = []
  for (const track of candidates) {
    if (!track?.id || seenIds.has(track.id)) continue
    if (ctx.dislikedIds.has(track.id)) continue
    if (ctx.veryRecentIds.has(track.id)) continue
    if (track.duration > MAX_RADIO_DURATION || (track.duration > 0 && track.duration < MIN_RADIO_DURATION)) {
      continue
    }
    // Text-search results must prove they belong to the seed's context.
    if (opts.verifiedOnly && !verifiedSeedContext(track, ctx.seed)) continue
    const key = canonicalSongKey(track)
    if (!key || seenKeys.has(key)) continue
    seenIds.add(track.id) // collapse duplicate ids inside the batch too
    seenKeys.add(key)
    eligible.push({ track, score: 0 })
  }

  // 2) scoring (ranked against the eligible pool, preserving source order)
  eligible.forEach((entry, i) => {
    entry.score = scoreCandidate(entry.track, ctx, i, eligible.length, source)
  })

  // 3) sort by score, source order as tiebreak. In provider mode the
  //    recommendation feed's own order dominates every other signal.
  const ranked = eligible
    .map((entry, order) => ({ entry, order }))
    .sort((a, b) => b.entry.score - a.entry.score || a.order - b.order)
    .map((e) => e.entry.track)

  // 4) diversity-aware assembly, keyed on artist-or-uploader identity. The
  // window starts on the tail of the existing autoplay list so a new batch
  // never continues an artist/channel run. Candidates that would create a run
  // are deferred and retried in further passes as the window refreshes —
  // deferral, not rejection.
  const window: string[] = [...(opts.queueTailArtists ?? [])].slice(-(windowSize - 1))
  const perIdentity = new Map<string, number>()
  const identityCap = Math.max(2, Math.ceil(limit / 2))
  const picked: Track[] = []

  const violatesWindow = (identity: string): boolean => {
    const inWindow = window.filter((a) => a === identity).length
    return inWindow >= maxInWindow
  }

  const tryPick = (track: Track): boolean => {
    if (picked.length >= limit) return false
    const identity = identityKeyOf(track)
    if (identity && (violatesWindow(identity) || (perIdentity.get(identity) ?? 0) >= identityCap)) {
      return false
    }
    picked.push(track)
    window.push(identity)
    if (window.length > windowSize - 1) window.shift()
    perIdentity.set(identity, (perIdentity.get(identity) ?? 0) + 1)
    return true
  }

  // Passes over the ranked list: each pass picks what fits the diversity rules;
  // deferred candidates are retried while the window keeps refreshing.
  let pending = ranked
  while (picked.length < limit && pending.length > 0) {
    const deferred: Track[] = []
    let progressed = false
    for (const track of pending) {
      if (tryPick(track)) {
        progressed = true
      } else {
        deferred.push(track)
      }
    }
    if (!progressed) break
    pending = deferred
  }

  // Final relaxation: a homogeneous pool (a legitimate artist radio) still
  // fills the batch with deferred tracks once no diverse option is left.
  for (const track of pending) {
    if (picked.length >= limit) break
    picked.push(track)
  }

  return picked
}

// ---------- taste helpers ----------

/** Net skips: how often the user moved on early, minus real listens. */
export function netSkipsFor(stats: PlayStats | undefined): number {
  if (!stats) return 0
  return Math.max(0, stats.skipCount - stats.completeCount)
}
