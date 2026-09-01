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
