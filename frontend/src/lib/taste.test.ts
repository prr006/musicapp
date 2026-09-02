import { describe, expect, it } from 'vitest'
import type { PlayRecord, Track } from '../bridge/types'
import { mostPlayed, recentArtists, recentTracks } from './taste'

function track(id: string, extra: Partial<Track> = {}): Track {
  return {
    id: `yt:${id}`, sourceId: id, source: 'youtube', url: '', title: `Song ${id}`,
    artist: 'Artist', album: '', artwork: '', duration: 100, explicit: false, ...extra,
  }
}

function history(...entries: { id: string; at: number; extra?: Partial<Track> }[]): PlayRecord[] {
  return entries.map((e) => ({ track: track(e.id, e.extra), playedAt: e.at }))
}

describe('mostPlayed', () => {
  it('ranks by play count and only lists tracks it still knows', () => {
    const hist = history({ id: 'a', at: 3 }, { id: 'b', at: 2 }, { id: 'c', at: 1 })
    const stats = {
      'yt:ghost': { playCount: 99, significantCount: 0, completeCount: 0, skipCount: 0, lastPlayedAt: 5 },
      'yt:b': { playCount: 7, significantCount: 5, completeCount: 4, skipCount: 0, lastPlayedAt: 9 },
      'yt:a': { playCount: 2, significantCount: 2, completeCount: 2, skipCount: 0, lastPlayedAt: 8 },
    }
    const top = mostPlayed(hist, stats, 5)
    // 'ghost' has stats but no known metadata — never rendered as a fake row.
    expect(top.map((t) => t.track.id)).toEqual(['yt:b', 'yt:a'])
    expect(top[0].playCount).toBe(7)
    expect(top[0].completeCount).toBe(4)
  })
})

describe('recentTracks', () => {
  it('deduplicates by id, newest first', () => {
    const recent = recentTracks(history({ id: 'a', at: 9 }, { id: 'b', at: 8 }, { id: 'a', at: 7 }), 5)
    expect(recent.map((t) => t.id)).toEqual(['yt:a', 'yt:b'])
  })
})

describe('recentArtists', () => {
  it('groups by primary artist and keeps play counts', () => {
    const artists = recentArtists(
      history(
        { id: 'a', at: 5, extra: { artist: 'Marlow, Other' } },
        { id: 'b', at: 4, extra: { artist: 'Marlow' } },
        { id: 'c', at: 3, extra: { artist: 'Neon Atlas' } },
      ),
      5,
    )
    const marlow = artists.find((a) => a.name === 'Marlow')
    expect(marlow?.playCount).toBe(2)
    expect(artists.find((a) => a.name === 'Neon Atlas')?.playCount).toBe(1)
  })
})
