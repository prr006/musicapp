import { describe, expect, it } from 'vitest'
import type { PlayStats, Track } from '../bridge/types'
import { smartShuffle } from './smartshuffle'
import { identityKeyOf } from './radio'

function track(id: string, extra: Partial<Track> = {}): Track {
  return {
    id: `yt:${id}`,
    sourceId: id,
    source: 'youtube',
    url: '',
    title: `Song ${id}`,
    artist: 'Artist',
    album: '',
    artwork: '',
    duration: 100,
    explicit: false,
    ...extra,
  }
}

/** Deterministic LCG so every assertion below is reproducible. */
function seededRng(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

function stats(playCount: number, completeCount = 0): PlayStats {
  return { playCount, significantCount: 0, completeCount, skipCount: 0, lastPlayedAt: 1 }
}

const ids = (tracks: Track[]) => tracks.map((t) => t.id).sort()
const positionsOf = (tracks: Track[], wanted: ReadonlySet<string>) =>
  tracks.map((t, i) => (wanted.has(t.id) ? i : -1)).filter((i) => i >= 0)

describe('smartShuffle', () => {
  it('keeps every track exactly once, with or without taste data', () => {
    const list = Array.from({ length: 20 }, (_, i) => track(`t${i}`, { artist: `Artist ${i % 5}` }))
    expect(ids(smartShuffle(list, { rng: seededRng(1) }))).toEqual(ids(list))
    expect(
      ids(smartShuffle(list, { rng: seededRng(2), stats: { 'yt:t3': stats(5, 2) }, likedIds: new Set(['yt:t7']) })),
    ).toEqual(ids(list))
  })

  it('is deterministic for a given rng seed and still random across seeds', () => {
    const list = Array.from({ length: 12 }, (_, i) => track(`t${i}`, { artist: `A${i}` }))
    const a = smartShuffle(list, { rng: seededRng(42) })
    const b = smartShuffle(list, { rng: seededRng(42) })
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id))
    const c = smartShuffle(list, { rng: seededRng(7) })
    expect(a.map((t) => t.id)).not.toEqual(c.map((t) => t.id))
  })

  it('pins the head: nothing up to and including keepFirst moves', () => {
    const list = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => track(id, { artist: `A-${id}` }))
    const out = smartShuffle(list, { keepFirst: 3, rng: seededRng(3) })
    expect(out.slice(0, 3).map((t) => t.id)).toEqual(['yt:a', 'yt:b', 'yt:c'])
    expect(out).toHaveLength(6)
    expect(new Set(out.map((t) => t.id)).size).toBe(6)
  })

  it('never places the same artist back-to-back when the list admits spacing', () => {
    // 8 tracks over 3 identities, the largest exactly half the list — the
    // hardest spacing case that is still solvable.
    const list = [
      ...Array.from({ length: 4 }, (_, i) => track(`a${i}`, { artist: 'Alpha' })),
      ...Array.from({ length: 2 }, (_, i) => track(`b${i}`, { artist: 'Beta' })),
      track('c0', { artist: 'Gamma' }),
      track('c1', { artist: 'Gamma' }),
    ]
    for (let seed = 1; seed <= 10; seed += 1) {
      const out = smartShuffle(list, { rng: seededRng(seed) })
      for (let i = 1; i < out.length; i++) {
        const prev = identityKeyOf(out[i - 1])
        expect(prev === '' || prev !== identityKeyOf(out[i])).toBe(true)
      }
    }
  })

  it('keeps runs only when one identity dominates the whole list', () => {
    const list = Array.from({ length: 6 }, (_, i) => track(`a${i}`, { artist: 'Solo' }))
    const out = smartShuffle(list, { rng: seededRng(5) })
    expect(out.map((t) => t.id).sort()).toEqual(list.map((t) => t.id).sort())
  })

  it('spreads favourites across the queue instead of letting them clump', () => {
    // Distinct artists, so spacing is a no-op and only the spread shows.
    const list = Array.from({ length: 14 }, (_, i) => track(`t${i}`, { artist: `A${i}` }))
    const favorites = new Set(['yt:t2', 'yt:t9', 'yt:t12'])
    const out = smartShuffle(list, { rng: seededRng(11), likedIds: favorites })
    const positions = positionsOf(out, favorites)
    expect(positions).toHaveLength(3)
    // Each half of the queue contains at least one favourite...
    expect(positions.some((p) => p < 7)).toBe(true)
    expect(positions.some((p) => p >= 7)).toBe(true)
    // ...and the gap between consecutive favourites stays bounded.
    const gaps = positions.slice(1).map((p, i) => p - positions[i])
    expect(Math.max(...gaps)).toBeLessThanOrEqual(7)
  })

  it('treats repeatedly completed tracks as favourites too', () => {
    const list = Array.from({ length: 10 }, (_, i) => track(`t${i}`, { artist: `A${i}` }))
    const favorites = new Set(['yt:t4'])
    const out = smartShuffle(list, { rng: seededRng(13), stats: { 'yt:t4': stats(1, 1) } })
    expect(positionsOf(out, favorites)[0]).toBeGreaterThanOrEqual(2)
    expect(positionsOf(out, favorites)[0]).toBeLessThanOrEqual(7)
  })

  it('does not open with a track heard in the last few songs', () => {
    const list = ['a', 'b', 'c', 'd', 'e'].map((id) => track(id, { artist: `A-${id}` }))
    const recent = new Set(['yt:a'])
    for (let seed = 1; seed <= 10; seed += 1) {
      const out = smartShuffle(list, { rng: seededRng(seed), recentIds: recent })
      expect(out[0].id).not.toBe('yt:a')
    }
  })

  it('degenerates safely on tiny lists', () => {
    expect(smartShuffle([])).toEqual([])
    expect(smartShuffle([track('solo')]).map((t) => t.id)).toEqual(['yt:solo'])
    const pair = [track('x'), track('y')]
    expect(new Set(smartShuffle(pair).map((t) => t.id))).toEqual(new Set(['yt:x', 'yt:y']))
  })
})
