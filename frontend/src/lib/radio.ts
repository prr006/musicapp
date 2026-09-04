/**
 * MELO's radio engine: turn one seed track plus the local taste profile into
 * a ranked, de-duplicated, artist-diverse autoplay batch.
 *
 * The engine is deliberately small and readable — weighted signals with names,
 * no ML. Everything here is a pure function so the behaviour is testable.
 *
 * Model (see PlaybackController.doDiscoveryFetch for the sourcing side):
 *
 *   CURRENT SONG + CURRENT SESSION + USER TASTE + FEEDBACK
 *     ↓ candidate generation   — several real provider recommendation feeds:
 *       the current track\u2019s "Up next" feed (primary anchor), the feeds of
 *       recent *session* tracks (drift: where the listener is heading right
 *       now) and the feeds of liked tracks (taste anchors). All of them are
 *       actual YouTube/YouTube Music related/automix data — never text search.
 *     ↓ filter        — blocked/disliked/very-recent/non-music; identity
 *       verification for the last-resort text-search fallback only.
 *     ↓ rank          — the provider recommendation relationship is the
 *       strongest signal: each pool\u2019s own ordering dominates, weighted by
 *       how close its anchor is to the current listening context. Local taste
 *       (completion-weighted artist affinity, likes, skip rates, session
 *       familiarity) personalizes without reordering the graph.
 *     ↓ diversify     — a property of the *final queue*: window-based
 *       identity spacing plus a pool-concentration trigger that asks for
 *       broader candidate generation instead of accepting a one-artist queue.
 *     ↓ autoplay      → observe play/skip/like → update session context →
 *       generate the next batch (bounded, generation-guarded).
 *
 *   A shared title, an uploader or a channel name is NEVER musical
 *   similarity ("Fearless" by three unrelated artists stays unrelated), and
 *   no genre-transition table exists: adjacent-context moves emerge from the
 *   drift anchors + the provider\u2019s own recommendation graph.
 *
 * Pipeline:
 *
 *   candidate pools
 *     → hard filters   (never the current track, duplicates, dislikes,
 *                       very recently played, non-music durations; identity
 *                       verification for text-search batches)
 *     → scoring        (provider order dominant, weighted per pool; taste,
 *                       session and feedback signals nudge; title collisions
 *                       demoted)
 *     → sorting        (score desc, source order as the tiebreak)
 *     → diversity      (no artist-or-channel runs longer than the radio kind\u2019s
 *                       window allows, unless the whole pool is one identity)
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
  /** The seed's own diversity identity (normalized artist-or-uploader key). */
  identity: string
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
    identity: identityKeyOf(track),
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

/** Starvation floor: a homogeneous last-resort batch is filled at least this far. */
export const MIN_BATCH_FLOOR = 4

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
  /** Completion-weighted artist affinity from listening history. */
  artistAffinity?: Map<string, number>
  /** Skip rate per artist (skips/plays); frequently abandoned artists sink. */
  artistSkipRates?: Map<string, number>
  /** How often each artist was played in the CURRENT session. */
  sessionArtistCounts?: Map<string, number>
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
/**
 * Provider-order weight for candidates whose anchor is a recent *session*
 * track rather than the current one: still a real recommendation graph, just
 * one step away from "right now".
 */
export const W_DRIFT_SOURCE = 0.8
/** Provider-order weight for candidates anchored on liked tracks. */
export const W_TASTE_SOURCE = 0.55
/**
 * Familiarity balance: artists already played this session (but not just
 * now) get a small bonus — a radio should revisit familiar ground between
 * discoveries instead of oscillating wildly.
 */
export const W_SESSION_FAMILIAR_MAX = 0.8
/** Penalty for artists the listener repeatedly abandons (skip rate ≥ 0.5). */
export const W_ARTIST_SKIPPED = -0.8
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
 * The taste/session/feedback part of the score — everything that personalizes
 * a candidate once the provider relationship has spoken. Bounded by design:
 * all of it combined is far weaker than one step of provider relevance.
 */
export function tasteScore(track: Track, ctx: RadioContext): number {
  const artists = splitArtists(track.artist)
  const primary = artists[0] ?? ''
  let score = 0

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
    const affinity = ctx.artistAffinity?.get(primary) ?? ctx.artistPlays.get(primary) ?? 0
    if (affinity > 0) score += W_TASTE_ARTIST_MAX * (affinity / (affinity + 6))
    const sessionCount = ctx.sessionArtistCounts?.get(primary) ?? 0
    if (sessionCount > 0 && !ctx.recentArtistKeys.has(primary)) {
      score += (W_SESSION_FAMILIAR_MAX * Math.min(sessionCount, 3)) / 3
    }
    const skipRate = ctx.artistSkipRates?.get(primary) ?? 0
    if (skipRate >= 0.5) score += W_ARTIST_SKIPPED
  }
  if (track.album) score += W_HAS_ALBUM

  if (track.duration > 0) {
    if (track.duration >= 60 && track.duration <= 600) score += W_DURATION_FIT
    else if (track.duration < MIN_RADIO_DURATION || track.duration > MAX_RADIO_DURATION) score += W_ODD_DURATION
  }

  if (ctx.heardIds.has(track.id)) score += W_HEARD_RECENTLY
  const skips = ctx.netSkips.get(track.id) ?? 0
  if (skips > 0) score += W_SKIP * Math.min(skips, 2)
  if (primary && ctx.recentArtistKeys.has(primary)) score += W_RECENT_ARTIST
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
 * Scores one candidate from a single source list. All signals are additive and
 * named above; the function is exported so tests can assert individual
 * weights end-to-end.
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
  // All taste/session/feedback signals live in tasteScore; this adds only the
  // provider-order term so single candidates stay scoreable in tests.
  let score = tasteScore(track, ctx)
  if (providerTotal > 1) {
    const scale = source === 'provider' ? W_PROVIDER_ORDER : W_PROVIDER_RANK_MAX
    score += scale * (1 - providerRank / providerTotal)
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

/**
 * One candidate source: a real provider recommendation feed plus how close
 * its anchor is to the current listening context. The pool's own ordering is
 * its relevance graph; `weight` scales how strongly that order counts
 * (1 = current-track feed, W_DRIFT_SOURCE = recent session track,
 * W_TASTE_SOURCE = liked track).
 */
export interface CandidatePool {
  weight: number
  tracks: Track[]
}

export interface RadioBuildOptions {
  limit?: number
  /** Max occurrences of one artist inside any window of tracks. */
  maxPerArtistInWindow?: number
  /**
   * Identity counts already present in the autoplay list, so per-identity caps
   * hold across successive refills instead of resetting every batch.
   */
  seededIdentityCounts?: ReadonlyMap<string, number>
  windowSize?: number
  /** Per-batch cap for a single identity; artist radio raises this. */
  identityCap?: number
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

/** Diversity profile per radio kind. Song radio mixes; artist radio leans in. */
export interface DiversityProfile {
  windowSize: number
  maxPerArtistInWindow: number
  identityCapFor: (limit: number) => number
}

export const DIVERSITY: Record<RadioKind, DiversityProfile> = {
  // Song radio: no identity may take more than half the batch, and never more
  // than 2 of any 5 consecutive tracks — a healthy mix around the anchor.
  track: {
    windowSize: 5,
    maxPerArtistInWindow: 2,
    identityCapFor: (limit) => Math.max(2, Math.ceil(limit / 2)),
  },
  // Artist radio is *legitimately* artist-heavy: allow up to 3 in a wider
  // window and 70% of the batch — related artists still get real room.
  artist: {
    windowSize: 7,
    maxPerArtistInWindow: 3,
    identityCapFor: (limit) => Math.max(3, Math.ceil(limit * 0.7)),
  },
  // Album radio behaves like song radio with an album-context bonus.
  album: {
    windowSize: 5,
    maxPerArtistInWindow: 2,
    identityCapFor: (limit) => Math.max(2, Math.ceil(limit / 2)),
  },
}

/**
 * Measures how dominated a candidate pool is by one artist-or-channel
 * identity. The controller uses this to decide when to generate *broader*
 * candidates (drift/taste anchors) instead of accepting a one-artist radio.
 */
export function poolConcentration(tracks: Track[]): { share: number; distinct: number; topIdentity: string } {
  if (tracks.length === 0) return { share: 0, distinct: 0, topIdentity: '' }
  const counts = new Map<string, number>()
  for (const t of tracks) {
    const identity = identityKeyOf(t)
    if (!identity) continue
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  let top = 0
  let topIdentity = ''
  for (const [identity, n] of counts) {
    if (n > top) {
      top = n
      topIdentity = identity
    }
  }
  return { share: total > 0 ? top / total : 0, distinct: counts.size, topIdentity }
}

interface PoolEntry {
  track: Track
  /** Best provider-relevance score across the pools that offered the track. */
  providerScore: number
  /** Stable tiebreak: (pool index, rank in pool), best first. */
  order: number
  score: number
}

/**
 * Builds the autoplay batch: filter → score → sort → diversity → bound.
 *
 * `candidates` is either a plain list (one source — the last-resort verified
 * search path, or a single feed) or several weighted candidate pools. Every
 * pool's own ordering is preserved as relevance; when a track appears in
 * several pools its best (closest anchor, highest rank) provider score wins.
 * The output is deterministic for a given input (no randomness in the radio).
 */
export function buildRadioBatch(
  candidates: Track[] | CandidatePool[],
  ctx: RadioContext,
  opts: RadioBuildOptions = {},
): Track[] {
  // A plain Track[] and a CandidatePool[] are both arrays — discriminate on
  // the elements (pools carry a numeric `weight` and a `tracks` array), never
  // on Array.isArray.
  const isPoolList = (c: Track[] | CandidatePool[]): c is CandidatePool[] =>
    c.length > 0 && typeof (c[0] as CandidatePool).weight === 'number' && Array.isArray((c[0] as CandidatePool).tracks)
  const pools: CandidatePool[] = (isPoolList(candidates) ? candidates : [{ weight: 1, tracks: candidates as Track[] }]).filter(
    (p) => p && p.tracks && p.tracks.length > 0,
  )
  const limit = Math.max(1, opts.limit ?? 20)
  const windowSize = Math.max(2, opts.windowSize ?? 5)
  const maxInWindow = Math.max(1, opts.maxPerArtistInWindow ?? 2)
  const source: RadioSourceKind = opts.source ?? 'search'

  // 1) hard filters + per-pool provider scoring (best pool wins per track)
  const seenIds = new Set<string>(ctx.blockedIds)
  const seenKeys = new Set<string>(ctx.blockedKeys)
  const byId = new Map<string, PoolEntry>()
  pools.forEach((pool, poolIndex) => {
    const size = pool.tracks.length
    const rankOf = new Map<string, number>()
    let order = 0
    for (const track of pool.tracks) {
      if (!track?.id) continue
      if (rankOf.has(track.id)) continue // same upload twice in one feed
      rankOf.set(track.id, rankOf.size)
      if (ctx.dislikedIds.has(track.id)) continue
      if (ctx.veryRecentIds.has(track.id)) continue
      if (track.duration > MAX_RADIO_DURATION || (track.duration > 0 && track.duration < MIN_RADIO_DURATION)) {
        continue
      }
      // Text-search results must prove they belong to the seed's context.
      if (opts.verifiedOnly && !verifiedSeedContext(track, ctx.seed)) continue
      const key = canonicalSongKey(track)
      if (!key || seenKeys.has(key)) continue
      const rank = rankOf.get(track.id) ?? 0
      const providerScore =
        source === 'provider' ? W_PROVIDER_ORDER * pool.weight * (1 - rank / size) : 0
      const tieOrder = poolIndex * 1000 + order
      order += 1
      const existing = byId.get(track.id)
      if (existing) {
        if (providerScore > existing.providerScore) {
          existing.providerScore = providerScore
          existing.order = Math.min(existing.order, tieOrder)
        }
        continue
      }
      seenIds.add(track.id)
      seenKeys.add(key)
      byId.set(track.id, { track, providerScore, order: tieOrder, score: 0 })
    }
  })
  const eligible: PoolEntry[] = [...byId.values()]

  // 2) scoring: the provider relationship dominates; taste/session/feedback
  //    signals only personalize around it.
  const searchScale = source === 'provider' ? 0 : W_PROVIDER_RANK_MAX
  eligible.forEach((entry, i) => {
    const searchRank = source === 'provider' ? 0 : i
    const searchTotal = source === 'provider' ? 1 : eligible.length
    const searchScore =
      source === 'provider' ? 0 : searchScale * (1 - searchRank / searchTotal)
    entry.score = entry.providerScore + searchScore + tasteScore(entry.track, ctx)
  })

  // 3) sort by score, best (pool, rank) as the stable tiebreak.
  const ranked = eligible
    .slice()
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((e) => e.track)

  // 4) diversity-aware assembly, keyed on artist-or-uploader identity. The
  // window starts on the tail of the existing autoplay list so a new batch
  // never continues an artist/channel run. Candidates that would create a run
  // are deferred and retried in further passes as the window refreshes —
  // deferral, not rejection.
  const window: string[] = [...(opts.queueTailArtists ?? [])].slice(-(windowSize - 1))
  const perIdentity = new Map<string, number>(opts.seededIdentityCounts ?? [])
  const identityCap = opts.identityCap ?? Math.max(2, Math.ceil(limit / 2))
  const picked: Track[] = []
  const seedIdentities = new Set([ctx.seed.identity, ctx.seed.primaryArtist].filter(Boolean))
  // Song radio: the seed's own artist may take up to the full cap (you chose
  // that song), but any OTHER identity is a guest. When the candidate set
  // genuinely offers alternatives (more than three distinct identities), a
  // provider feed 80% one foreign artist must not translate into 80% of the
  // queue — guests are capped at a fifth of the batch. A narrow pool (a
  // tight two-identity graph, a lone-artist feed) keeps the classic cap so
  // the batch still fills; broadening generation is the controller's job.
  // Artist/album radios keep the full cap for every identity by design.
  const distinctIdentities = new Set(
    eligible.map((e) => identityKeyOf(e.track)).filter((k) => k !== ''),
  ).size
  const foreignCap =
    ctx.seed.kind === 'track' && distinctIdentities > 3
      ? Math.max(2, Math.ceil(limit / 5))
      : identityCap
  const capFor = (identity: string): number =>
    !identity || seedIdentities.has(identity) ? identityCap : Math.min(identityCap, foreignCap)

  const violatesWindow = (identity: string): boolean => {
    const inWindow = window.filter((a) => a === identity).length
    return inWindow >= maxInWindow
  }

  const tryPick = (track: Track): boolean => {
    if (picked.length >= limit) return false
    const identity = identityKeyOf(track)
    if (identity && (violatesWindow(identity) || (perIdentity.get(identity) ?? 0) >= capFor(identity))) {
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

  // Relaxation 1: cap-blind but window-aware — keep interleaving while the
  // window allows, ignoring the per-identity cap. In a song radio this
  // latitude belongs to the seed's own identity only ("recommended again"
  // is meaningful for the artist you are listening to); foreign identities
  // keep their guest cap.
  const capBlind: Track[] = []
  for (const track of pending) {
    if (picked.length >= limit) break
    const identity = identityKeyOf(track)
    const exempt = ctx.seed.kind !== 'track' || (identity !== '' && seedIdentities.has(identity))
    if (violatesWindow(identity) || (!exempt && (perIdentity.get(identity) ?? 0) >= capFor(identity))) {
      capBlind.push(track)
      continue
    }
    picked.push(track)
    window.push(identity)
    if (window.length > windowSize - 1) window.shift()
  }

  // Relaxation 2: window-blind but cap-aware — fill each identity up to its
  // cap even if that means short runs. This is the legitimate heaviness of an
  // explicit artist/album radio; a song radio keeps its window discipline.
  const windowBlind: Track[] = []
  if (ctx.seed.kind !== 'track') {
    for (const track of capBlind) {
      if (picked.length >= limit) break
      const identity = identityKeyOf(track)
      if ((perIdentity.get(identity) ?? 0) >= identityCap) {
        windowBlind.push(track)
        continue
      }
      picked.push(track)
      perIdentity.set(identity, (perIdentity.get(identity) ?? 0) + 1)
    }
  } else {
    windowBlind.push(...capBlind)
  }

  // Relaxation 3: a genuinely homogeneous candidate set (a legitimate artist
  // feed with no alternative identity to interleave) still fills the batch —
  // but only for identities the radio is *about*: the seed's own identity, or
  // anything on an explicit artist/album radio. A foreign identity flooding
  // the feed (the one-artist-wall failure) must not fill past its cap; the
  // controller is responsible for broadening candidate generation instead.
  const isSeedIdentity = (identity: string) => ctx.seed.kind !== 'track' || seedIdentities.has(identity)
  if (new Set(eligible.map((e) => identityKeyOf(e.track))).size <= 2) {
    for (const track of windowBlind) {
      if (picked.length >= limit) break
      const identity = identityKeyOf(track)
      // Filling past the caps is a last resort for identities the radio is
      // *about* — or, for any identity, the minimum needed to keep a starved
      // batch playable (a 4-track feed must not be cut to two).
      if (!isSeedIdentity(identity) && picked.length >= MIN_BATCH_FLOOR) continue
      picked.push(track)
    }
  }

  return picked
}

// ---------- taste helpers ----------

/** Net skips: how often the user moved on early, minus real listens. */
export function netSkipsFor(stats: PlayStats | undefined): number {
  if (!stats) return 0
  return Math.max(0, stats.skipCount - stats.completeCount)
}
