/**
 * Smart Shuffle — a taste-aware ordering of the user's own lists.
 *
 * It is still a shuffle: every track plays exactly once and the order is
 * random. Three properties are layered on top of the uniform shuffle using
 * only local listening data (no network, no provider calls):
 *
 *  1. Artist spacing — the same artist or channel identity does not play
 *     back-to-back whenever the list admits a spaced arrangement.
 *  2. Favourite spread — liked and repeatedly-completed tracks are
 *     distributed across the whole queue instead of clumping wherever the
 *     dice put them.
 *  3. Fresh openers — a track heard in the last few songs does not open the
 *     queue when alternatives exist.
 *
 * Everything here is a pure function; the caller decides where it applies
 * (play-all with shuffle, the shuffle toggle) and supplies the taste data.
 * `rng` is injectable so tests are deterministic.
 */
import type { PlayStats, Track } from '../bridge/types'
import { shuffled } from './queue'
import { identityKeyOf } from './radio'
import { trackAffinity } from './taste'

export interface SmartShuffleOptions {
  /** Per-track listening statistics (completion-weighted favourites). */
  stats?: Record<string, PlayStats>
  /** Liked track ids — the strongest explicit taste signal. */
  likedIds?: ReadonlySet<string>
  /** Track ids heard in the last few songs — kept away from the opener. */
  recentIds?: ReadonlySet<string>
  /** Items before this index keep their order (the current-track head). */
  keepFirst?: number
  /** Injectable randomness; tests pass a seeded generator. */
  rng?: () => number
}

/** A favourite: explicitly liked, or locally proven by real listens. */
function isFavorite(
  track: Track,
  stats: Record<string, PlayStats> | undefined,
  likedIds: ReadonlySet<string> | undefined,
): boolean {
  if (likedIds?.has(track.id)) return true
  // One completed listen or two plain plays — the same quality bar the radio
  // ranker's affinity uses.
  return trackAffinity(stats?.[track.id]) >= 1
}

/**
 * Places favourites at evenly spaced slots across the queue (both halves get
 * their share) while everything else keeps the shuffled order. Deterministic
 * given the base order: only *where* favourites sit is chosen, never the
 * random order inside each stratum.
 */
function spreadFavorites(order: Track[], opts: SmartShuffleOptions): Track[] {
  const favs: Track[] = []
  const rest: Track[] = []
  for (const t of order) {
    if (isFavorite(t, opts.stats, opts.likedIds)) favs.push(t)
    else rest.push(t)
  }
  if (favs.length === 0 || rest.length === 0) return order
  const total = order.length
  const out: Track[] = []
  let fi = 0
  let ri = 0
  while (out.length < total) {
    // The next favourite's ideal slot: k favourites spread over n slots,
    // offset by half a stride so a favourite does not always open the queue.
    const ideal = fi < favs.length ? Math.floor(((fi + 0.5) * total) / favs.length) : Infinity
    if (fi < favs.length && out.length >= ideal) {
      out.push(favs[fi])
      fi += 1
    } else if (ri < rest.length) {
      out.push(rest[ri])
      ri += 1
    } else {
      out.push(favs[fi])
      fi += 1
    }
  }
  return out
}

/** True while any two adjacent tracks share the same artist/channel identity. */
function hasIdentityRun(order: Track[]): boolean {
  for (let i = 1; i < order.length; i++) {
    const a = identityKeyOf(order[i - 1])
    if (a !== '' && a === identityKeyOf(order[i])) return true
  }
  return false
}

/** Spacing is achievable when no identity holds more than half the list. */
function admitsSpacing(order: Track[]): boolean {
  const counts = new Map<string, number>()
  let n = 0
  for (const t of order) {
    const key = identityKeyOf(t)
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
    n += 1
  }
  if (n === 0) return false
  let max = 0
  for (const c of counts.values()) if (c > max) max = c
  return max <= Math.ceil(n / 2)
}

/**
 * Greedy repair pass: while two adjacent tracks share an identity, swap the
 * second with the nearest later track that breaks the run without creating a
 * new one. Local swaps only, so the favourite spread survives almost intact.
 */
function repairIdentityRuns(order: Track[]): void {
  const id = (i: number) => identityKeyOf(order[i])
  for (let i = 1; i < order.length; i++) {
    const a = id(i - 1)
    const b = id(i)
    if (a === '' || b === '' || a !== b) continue
    for (let j = i + 1; j < order.length; j++) {
      const c = id(j)
      if (c === '' || c === b) continue
      if (j === i + 1) {
        // Adjacent swap: (i-1, i) is fixed because c !== b === a; only the
        // pair after j can newly clash.
        if (j + 1 < order.length && id(j + 1) === b) continue
      } else {
        // order[i] = c must not clash with the unchanged order[i + 1];
        // order[j] = b must not clash with either of its new neighbours.
        if (id(i + 1) === c) continue
        if (id(j - 1) === b) continue
        if (j + 1 < order.length && id(j + 1) === b) continue
      }
      const tmp = order[i]
      order[i] = order[j]
      order[j] = tmp
      break
    }
  }
}

/**
 * Deterministic spacing schedule for the rare orders greedy repair cannot
 * fully fix: identities sorted by size fill the even indices first, then the
 * odd ones — the classic arrangement with no adjacent pair while no identity
 * exceeds half the list. Intra-identity order is preserved, so favourites
 * stay ahead within their identity.
 */
function interleaveIdentities(order: Track[]): void {
  const byKey = new Map<string, Track[]>()
  for (const t of order) {
    const key = identityKeyOf(t) || `#anon-${byKey.size}`
    let bucket = byKey.get(key)
    if (!bucket) {
      bucket = []
      byKey.set(key, bucket)
    }
    bucket.push(t)
  }
  const buckets = [...byKey.values()].sort((a, b) => b.length - a.length)
  const slots: number[] = []
  for (let s = 0; s < order.length; s += 2) slots.push(s)
  for (let s = 1; s < order.length; s += 2) slots.push(s)
  const out: Track[] = new Array<Track>(order.length)
  let i = 0
  for (const bucket of buckets) {
    for (const t of bucket) {
      if (i >= slots.length) break
      out[slots[i]] = t
      i += 1
    }
  }
  order.splice(0, order.length, ...out)
}

/**
 * Smart Shuffles a list. `keepFirst` pins the head (e.g. everything up to and
 * including the current track); only the remainder is reordered. With no
 * taste data at all this degrades to a uniform shuffle plus artist spacing.
 */
export function smartShuffle(tracks: Track[], opts: SmartShuffleOptions = {}): Track[] {
  const keepFirst = Math.max(0, Math.min(opts.keepFirst ?? 0, tracks.length))
  const head = tracks.slice(0, keepFirst)
  const body = tracks.slice(keepFirst)
  if (body.length < 2) return [...head, ...body]
  const ordered = spreadFavorites(shuffled(body, opts.rng), opts)
  repairIdentityRuns(ordered)
  if (hasIdentityRun(ordered) && admitsSpacing(ordered)) {
    interleaveIdentities(ordered)
  }
  if (head.length === 0 && opts.recentIds && opts.recentIds.size > 0) {
    // A fresh queue (nothing pinned) should not open with what was just
    // heard; swap the opener with the first track outside that window.
    if (opts.recentIds.has(ordered[0].id)) {
      const swap = ordered.findIndex((t) => !opts.recentIds!.has(t.id))
      if (swap > 0) {
        const tmp = ordered[0]
        ordered[0] = ordered[swap]
        ordered[swap] = tmp
      }
    }
  }
  return [...head, ...ordered]
}
