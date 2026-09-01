import { describe, expect, it } from 'vitest'
import { deriveAlbums, deriveArtists, findAlbum, primaryArtist } from './derive'
import { formatLongDuration, formatTime, initials, relativeTime } from './format'
import { dedupeTracks, moveItem, shuffleUpcoming, shuffled } from './queue'
import type { Track } from '../bridge/types'

function track(id: string, over: Partial<Track> = {}): Track {
  return {
    id, sourceId: id, source: 'youtube', url: '', title: `T${id}`, artist: 'Artist One',
    album: 'Album One', artwork: `art-${id}`, duration: 60, explicit: false, ...over,
  }
}

describe('queue helpers', () => {
  it('shuffle keeps every element exactly once', () => {
    const input = Array.from({ length: 50 }, (_, i) => i)
    const out = shuffled(input)
    expect(out).toHaveLength(50)
    expect(new Set(out).size).toBe(50)
  })

  it('shuffleUpcoming never moves the current track', () => {
    const queue = ['a', 'b', 'c', 'd', 'e']
    for (let i = 0; i < 20; i += 1) {
      const out = shuffleUpcoming(queue, 2)
      expect(out.slice(0, 3)).toEqual(['a', 'b', 'c'])
      expect(new Set(out).size).toBe(5)
    }
  })

  it('shuffleUpcoming handles edge indexes', () => {
    expect(shuffleUpcoming(['a'], 0)).toEqual(['a'])
    expect(new Set(shuffleUpcoming(['a', 'b', 'c'], -1)).size).toBe(3)
    expect(shuffleUpcoming([], 0)).toEqual([])
  })

  it('moveItem reorders without losing elements', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
    expect(moveItem(['a', 'b', 'c'], 0, 9)).toEqual(['a', 'b', 'c'])
  })

  it('dedupeTracks keeps the first occurrence', () => {
    const out = dedupeTracks([track('a'), track('b'), track('a')])
    expect(out.map((t) => t.id)).toEqual(['a', 'b'])
  })
})

describe('derived library views', () => {
  it('groups albums by title and primary artist', () => {
    const albums = deriveAlbums([
      track('1'),
      track('2'),
      track('3', { album: 'Other', artist: 'Artist Two' }),
    ])
    expect(albums.map((a) => a.title).sort()).toEqual(['Album One', 'Other'])
    expect(albums.find((a) => a.title === 'Album One')?.tracks).toHaveLength(2)
  })

  it('never invents an album for tracks without one', () => {
    const albums = deriveAlbums([track('1', { album: '' }), track('2', { album: '   ' })])
    expect(albums).toHaveLength(0)
  })

  it('derives artists with their albums', () => {
    const artists = deriveArtists([track('1'), track('2', { artist: 'Artist Two, Guest' })])
    expect(artists.map((a) => a.name)).toEqual(['Artist One', 'Artist Two'])
    expect(artists[0].albums?.[0].title).toBe('Album One')
  })

  it('primaryArtist keeps only the lead credit', () => {
    expect(primaryArtist('A, B')).toBe('A')
    expect(primaryArtist('A & B')).toBe('A')
    expect(primaryArtist('Solo')).toBe('Solo')
  })

  it('findAlbum resolves the key used for navigation', () => {
    const tracks = [track('1')]
    const key = deriveAlbums(tracks)[0].id
    expect(findAlbum(tracks, key)?.title).toBe('Album One')
    expect(findAlbum(tracks, 'nope|nope')).toBeNull()
  })
})

describe('formatting', () => {
  it('formats times, including hours and unknown values', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(65)).toBe('1:05')
    expect(formatTime(3725)).toBe('1:02:05')
    expect(formatTime(NaN)).toBe('--:--')
    expect(formatTime(-4)).toBe('--:--')
  })

  it('formats long durations', () => {
    expect(formatLongDuration(0)).toBe('')
    expect(formatLongDuration(90)).toBe('2 min')
    expect(formatLongDuration(7200)).toBe('2 hr 0 min')
  })

  it('formats relative times', () => {
    expect(relativeTime(Date.now())).toBe('Just now')
    expect(relativeTime(Date.now() - 3 * 60_000)).toBe('3m ago')
    expect(relativeTime(Date.now() - 5 * 3600_000)).toBe('5h ago')
  })

  it('builds fallback initials', () => {
    expect(initials('Nightfall')).toBe('NI')
    expect(initials('Paper Lanterns')).toBe('PL')
    expect(initials('   ')).toBe('?')
  })
})
