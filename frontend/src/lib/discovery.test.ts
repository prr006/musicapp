import { describe, expect, it } from 'vitest'
import type { Track } from '../bridge/types'
import { normalizeTitle, pickDiscoveryCandidates, type DiscoveryBlock } from './discovery'

function track(id: string, title: string, artist = `Artist ${id}`): Track {
  return {
    id: `yt:${id}`, sourceId: id, source: 'youtube', url: '', title, artist,
    album: 'Album', artwork: '', duration: 100, explicit: false,
  }
}

describe('normalizeTitle', () => {
  it('collapses upload noise so variants of one song compare equal', () => {
    const variants = [
      'Believer',
      'Believer (Official Video)',
      'Believer (Official Music Video)',
      'Believer [Lyrics]',
      'Believer (Lyric Video)',
      'Believer (Audio)',
      'Believer (Visualizer)',
      'Believer (Live)',
      'Believer (Remastered)',
      'Believer (Remastered 2017)',
      'Believer (HD)',
      'Believer (4K)',
      'Believer (Cover)',
      'Believer (Acoustic)',
      'Believer (Slowed + Reverb)',
      'Believer (Nightcore)',
      'Believer (Explicit)',
    ]
    const keys = new Set(variants.map((t) => normalizeTitle(t)))
    expect(keys.size).toBe(1)
  })

  it('never strips meaningful song words', () => {
    expect(normalizeTitle('Live Forever')).toBe('liveforever')
    expect(normalizeTitle('Cover Me')).toBe('coverme')
    expect(normalizeTitle('Acoustic')).toBe('acoustic')
    expect(normalizeTitle('Nightcore')).toBe('nightcore')
  })
})

describe('pickDiscoveryCandidates', () => {
  it('drops known ids and repeated variants of the same upload', () => {
    const block: DiscoveryBlock = {
      ids: new Set(['yt:current']),
      titles: new Set(['radioactive']),
    }
    const candidates = [
      track('current', 'Radioactive'), // current track (blocked by title)
      track('a', 'Believer'),
      track('b', 'Believer (Official Video)'), // variant of the same song
      track('c', 'Believer', 'Someone Else'), // same title, different artist — still a variant here
      track('d', 'Thunder'),
    ]
    const picked = pickDiscoveryCandidates(candidates, block)
    expect(picked.map((t) => t.id)).toEqual(['yt:a', 'yt:d'])
  })

  it('does not reject a track merely for sharing the current artist', () => {
    const block: DiscoveryBlock = { ids: new Set(), titles: new Set() }
    const picked = pickDiscoveryCandidates(
      [track('a', 'Bones', 'Imagine Dragons'), track('b', 'Warriors', 'Imagine Dragons')],
      block,
    )
    expect(picked.map((t) => t.id)).toEqual(['yt:a', 'yt:b'])
  })

  it('caps and spaces artists even when provider relevance is artist-heavy', () => {
    const block: DiscoveryBlock = {
      ids: new Set(), titles: new Set(),
      artistCounts: new Map([['seedartist', 1]]), lastArtist: 'seedartist',
    }
    const candidates = [
      ...Array.from({ length: 8 }, (_, i) => track(`seed${i}`, `Seed song ${i}`, 'Seed Artist')),
      ...Array.from({ length: 4 }, (_, i) => track(`b${i}`, `B song ${i}`, 'Related B')),
      ...Array.from({ length: 4 }, (_, i) => track(`c${i}`, `C song ${i}`, 'Related C')),
      ...Array.from({ length: 4 }, (_, i) => track(`d${i}`, `D song ${i}`, 'Related D')),
      ...Array.from({ length: 4 }, (_, i) => track(`e${i}`, `E song ${i}`, 'Related E')),
    ]
    const picked = pickDiscoveryCandidates(candidates, block, 8)
    const artists = picked.map((candidate) => candidate.artist)
    const counts = artists.reduce<Record<string, number>>((out, artist) => {
      out[artist] = (out[artist] ?? 0) + 1
      return out
    }, {})

    expect(picked).toHaveLength(8)
    expect(counts['Seed Artist']).toBe(1)
    expect(Math.max(...Object.values(counts))).toBeLessThanOrEqual(2)
    expect(artists.every((artist, index) => index === 0 || artist !== artists[index - 1])).toBe(true)
  })

  it('honours the bound for a diverse provider result', () => {
    const block: DiscoveryBlock = { ids: new Set(), titles: new Set() }
    const candidates = Array.from({ length: 30 }, (_, i) => track(`d${i}`, `Song ${i}`))
    expect(pickDiscoveryCandidates(candidates, block, 20)).toHaveLength(20)
  })
})
