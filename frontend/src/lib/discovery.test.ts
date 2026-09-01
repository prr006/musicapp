import { describe, expect, it } from 'vitest'
import type { Track } from '../bridge/types'
import { normalizeTitle, pickDiscoveryCandidates, type DiscoveryBlock } from './discovery'

function track(id: string, title: string, artist = 'Artist'): Track {
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

  it('honours the bound', () => {
    const block: DiscoveryBlock = { ids: new Set(), titles: new Set() }
    const candidates = Array.from({ length: 30 }, (_, i) => track(`d${i}`, `Song ${i}`))
    expect(pickDiscoveryCandidates(candidates, block, 20)).toHaveLength(20)
  })
})
