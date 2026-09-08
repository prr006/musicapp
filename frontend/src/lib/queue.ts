import type { Track } from '../bridge/types'

/** Fisher–Yates on a copy. */
export function shuffled<T>(items: T[], rng: () => number = Math.random): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Shuffles the upcoming part of a queue while keeping the current track in
 * place. Everything that was in the queue is still in the queue exactly once.
 */
export function shuffleUpcoming<T>(queue: T[], currentIndex: number, rng?: () => number): T[] {
  if (queue.length < 2) return queue.slice()
  const safeIndex = Math.max(0, Math.min(currentIndex, queue.length - 1))
  const head = queue.slice(0, safeIndex + 1)
  const tail = shuffled(queue.slice(safeIndex + 1), rng)
  return [...head, ...tail]
}

export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length || to < 0 || to >= items.length || from === to) {
    return items
  }
  const out = items.slice()
  const [item] = out.splice(from, 1)
  out.splice(to, 0, item)
  return out
}

/**
 * Up to `max` items spread evenly across the list — a bounded sample that
 * represents the whole list, not just its head. Order follows the input; a
 * list of `max` or fewer items is returned in full (a copy).
 */
export function spreadSample<T>(items: T[], max: number): T[] {
  if (max <= 0) return []
  if (items.length <= max) return items.slice()
  const out: T[] = []
  const step = items.length / max
  for (let i = 0; i < max; i += 1) {
    out.push(items[Math.min(items.length - 1, Math.floor(i * step))])
  }
  return out
}

/** Removes duplicates by track id, keeping the first occurrence. */
export function dedupeTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>()
  const out: Track[] = []
  for (const t of tracks) {
    if (!t?.id || seen.has(t.id)) continue
    seen.add(t.id)
    out.push(t)
  }
  return out
}
