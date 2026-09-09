import type { PlayRecord, RepeatMode, Track } from '../bridge/types'
import { normalizeArtist, normalizeTitle, pickDiscoveryCandidates, type DiscoveryBlock } from '../lib/discovery'
import { dedupeTracks } from '../lib/queue'

/**
 * Canonical queue policy used by the shared renderer on both Wails desktop and
 * hosted web. Backend adapters resolve/search tracks; they never decide order.
 */
export const DISCOVERY_TARGET = 8
export const DISCOVERY_REFILL_THRESHOLD = 5
export const DISCOVERY_RECENT_HISTORY = 50

export interface QueueStateLike {
  current: Track | null
  queue: Track[]
  autoQueue: Track[]
  index: number
  playingFrom: 'queue' | 'autoplay'
  repeat: RepeatMode
}

export interface QueueSelection {
  track: Track
  source: 'queue' | 'autoplay'
  /** Present only for an explicit queue selection. */
  queueIndex?: number
}

export interface RadioSeen {
  ids: ReadonlySet<string>
  titles: ReadonlySet<string>
}

export interface DiscoveryContext {
  state: Pick<QueueStateLike, 'current' | 'queue' | 'autoQueue'>
  history?: PlayRecord[]
  recent?: Track[]
  radioSeen?: RadioSeen | null
  includeAutoplay?: boolean
}

/** Real visual/selection order: explicit upcoming first, discovery second. */
export function projectUpcoming(state: Pick<QueueStateLike, 'queue' | 'autoQueue' | 'index'>): {
  explicit: Track[]
  discovery: Track[]
  all: Track[]
} {
  const explicit = state.index < 0 ? state.queue.slice() : state.queue.slice(state.index + 1)
  const discovery = state.autoQueue.slice()
  return { explicit, discovery, all: [...explicit, ...discovery] }
}

/**
 * One canonical next-track decision for desktop and web. Explicit tracks are
 * authoritative; discovery is considered only after explicit upcoming items.
 */
export function selectNextTrack(state: QueueStateLike, autoplay: boolean): QueueSelection | null {
  const explicitIndex = state.index + 1
  if (explicitIndex >= 0 && explicitIndex < state.queue.length) {
    return { track: state.queue[explicitIndex], source: 'queue', queueIndex: explicitIndex }
  }
  if (state.playingFrom === 'queue' && state.repeat === 'all' && state.queue.length > 0) {
    return { track: state.queue[0], source: 'queue', queueIndex: 0 }
  }
  if (autoplay && state.autoQueue.length > 0) {
    return { track: state.autoQueue[0], source: 'autoplay' }
  }
  return null
}

/** First tracks worth resolving early, in the exact order they would play. */
export function prefetchCandidates(state: QueueStateLike, autoplay: boolean, limit = 3): Track[] {
  const projected = projectUpcoming(state)
  const ordered = autoplay ? projected.all : projected.explicit
  return dedupeTracks(ordered).slice(0, Math.max(0, limit))
}

export function buildDiscoveryBlock(context: DiscoveryContext): DiscoveryBlock {
  const ids = new Set<string>()
  const titles = new Set<string>()
  const artistCounts = new Map<string, number>()
  let lastArtist = ''
  const addTrack = (track?: Track | null) => {
    if (!track) return
    if (track.id) ids.add(track.id)
    const title = normalizeTitle(track.title)
    if (title) titles.add(title)
  }

  addTrack(context.state.current)
  for (const track of context.state.queue) addTrack(track)
  if (context.includeAutoplay !== false) {
    for (const track of context.state.autoQueue) addTrack(track)
  }

  // Diversity applies only to provider-generated playback, never to the user's
  // explicit queue. Current + the prepared discovery prefix define occupancy.
  for (const track of [context.state.current, ...(context.includeAutoplay === false ? [] : context.state.autoQueue)]) {
    if (!track) continue
    const artist = normalizeArtist(track.artist) || `unknown:${track.id}`
    artistCounts.set(artist, (artistCounts.get(artist) ?? 0) + 1)
    lastArtist = artist
  }
  for (const entry of (context.history ?? []).slice(0, DISCOVERY_RECENT_HISTORY)) addTrack(entry.track)
  for (const track of (context.recent ?? []).slice(0, DISCOVERY_RECENT_HISTORY)) addTrack(track)
  for (const id of context.radioSeen?.ids ?? []) ids.add(id)
  for (const title of context.radioSeen?.titles ?? []) titles.add(title)
  return { ids, titles, artistCounts, lastArtist }
}

/** Incremental append: the existing prefix is never replaced or reordered. */
export function appendDiscovery(
  existing: Track[],
  candidates: Track[],
  block: DiscoveryBlock,
  target = DISCOVERY_TARGET,
): { queue: Track[]; added: Track[] } {
  const capacity = Math.max(0, target - existing.length)
  if (capacity === 0) return { queue: existing, added: [] }
  const added = pickDiscoveryCandidates(candidates, block, capacity)
  if (added.length === 0) return { queue: existing, added }
  return { queue: [...existing, ...added], added }
}

/** Remove stale duplicates while retaining the first valid discovery ordering. */
export function reconcileDiscovery(
  discovery: Track[],
  block: DiscoveryBlock,
  target = DISCOVERY_TARGET,
): Track[] {
  return pickDiscoveryCandidates(discovery, block, target)
}

/** Remove one failed/removed candidate without disturbing any other ordering. */
export function removeCandidate(
  state: QueueStateLike,
  trackId: string,
  source: 'queue' | 'autoplay',
): Pick<QueueStateLike, 'queue' | 'autoQueue' | 'index'> {
  if (source === 'autoplay') {
    return {
      queue: state.queue,
      autoQueue: state.autoQueue.filter((track) => track.id !== trackId),
      index: state.index,
    }
  }

  const failedIndex = state.queue.findIndex((track) => track.id === trackId)
  if (failedIndex < 0) return { queue: state.queue, autoQueue: state.autoQueue, index: state.index }
  return {
    queue: state.queue.filter((_, index) => index !== failedIndex),
    autoQueue: state.autoQueue,
    index: failedIndex <= state.index ? state.index - 1 : state.index,
  }
}

export function isUpcomingCandidate(state: QueueStateLike, trackId: string): 'queue' | 'autoplay' | null {
  if (state.queue.slice(Math.max(0, state.index + 1)).some((track) => track.id === trackId)) return 'queue'
  if (state.autoQueue.some((track) => track.id === trackId)) return 'autoplay'
  return null
}
