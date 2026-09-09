import { describe, expect, it } from 'vitest'
import type { PlayRecord, Track } from '../bridge/types'
import {
  artistAffinity, buildProfile, primaryArtist, styleTagsFor, tagAffinity, titleTokens,
} from './profile'

function track(id: string, extra: Partial<Track> = {}): Track {
  return {
    id, sourceId: id, source: 'youtube', url: '', title: `Song ${id}`,
    artist: 'Someone', album: '', artwork: '', duration: 200, explicit: false, ...extra,
  }
}

function record(t: Track, playedAt: number, detail: Partial<PlayRecord> = {}): PlayRecord {
  return {
    track: t,
    playedAt,
    listenedSec: 200,
    trackDuration: 200,
    completed: true,
    skipped: false,
    ...detail,
  }
}

const HOUR = 3600_000

describe('buildProfile', () => {
  it('weights completed listens far above skipped ones', () => {
    const now = 100 * HOUR
    const anirudh = track('a1', { artist: 'Anirudh Ravichander' })
    const dhanush = track('d1', { artist: 'Dhanush' })
    const history = [
      record(anirudh, now - HOUR),        // completed an hour ago
      record(dhanush, now - 2 * HOUR, { listenedSec: 5, completed: false, skipped: true }), // skipped
    ]
    const profile = buildProfile(history, [], now)
    const anirudhWeight = profile.artistWeights.get('anirudh ravichander') ?? 0
    const dhanushWeight = profile.artistWeights.get('dhanush') ?? 0
    expect(anirudhWeight).toBeGreaterThan(0.25)
    expect(dhanushWeight).toBeLessThan(0) // a skip is a mild negative vote
    expect(profile.skipIds.has('d1')).toBe(true)
  })

  it('decays old listens so recent sessions dominate', () => {
    const now = 100 * HOUR
    const recent = track('r', { artist: 'Recent Artist' })
    const old = track('o', { artist: 'Old Artist' })
    const profile = buildProfile(
      [
        record(recent, now - HOUR),
        record(old, now - 72 * HOUR), // three half-lives old
      ],
      [],
      now,
    )
    expect(artistAffinity(profile, 'Recent Artist')).toBeGreaterThan(
      artistAffinity(profile, 'Old Artist'),
    )
    expect(profile.artistWeights.get('recent artist')!).toBeGreaterThan(
      profile.artistWeights.get('old artist')!,
    )
  })

  it('scales weight by how much of the track was actually heard', () => {
    const now = 100 * HOUR
    const full = track('f', { artist: 'A' })
    const half = track('h', { artist: 'B' })
    const profile = buildProfile(
      [record(full, now - HOUR), record(half, now - HOUR, { listenedSec: 50, completed: false })],
      [],
      now,
    )
    expect(profile.artistWeights.get('a')!).toBeGreaterThan(profile.artistWeights.get('b')!)
  })

  it('credits every listed artist on collaborations', () => {
    const now = 100 * HOUR
    const t = track('c', { artist: 'Dhanush, Anirudh Ravichander' })
    const profile = buildProfile([record(t, now - HOUR)], [], now)
    expect(profile.artistWeights.get('dhanush')!).toBeGreaterThan(0)
    expect(profile.artistWeights.get('anirudh ravichander')!).toBeGreaterThan(0)
  })

  it('counts likes as a bounded, non-decaying affinity boost', () => {
    const now = 100 * HOUR
    const liked = track('l', { artist: 'A.R. Rahman' })
    const profile = buildProfile([], [liked], now)
    expect(profile.likedArtists.has('a.r. rahman')).toBe(true)
    expect(profile.artistWeights.get('a.r. rahman')!).toBeGreaterThan(0)
  })

  it('tracks recent order for the listening streak', () => {
    const now = 100 * HOUR
    const history = [
      record(track('t3', { artist: 'Third' }), now - HOUR),
      record(track('t2', { artist: 'Second' }), now - 2 * HOUR),
      record(track('t1', { artist: 'First' }), now - 3 * HOUR),
    ]
    const profile = buildProfile(history, [], now)
    expect(profile.recentArtists.slice(0, 3)).toEqual(['third', 'second', 'first'])
    expect(profile.recentTrackIds[0]).toBe('t3')
  })

  it('accumulates style tags from the provider and the title', () => {
    const now = 100 * HOUR
    const t = track('t', { title: 'Vaathi Coming (Live Remix)', tags: ['tamil', 'film'] })
    const profile = buildProfile([record(t, now - HOUR)], [], now)
    expect(profile.tagWeights.has('tamil')).toBe(true)
    expect(profile.tagWeights.has('film')).toBe(true)
    expect(profile.tagWeights.has('live')).toBe(true)
    expect(profile.tagWeights.has('remix')).toBe(true)
    expect(tagAffinity(profile, t)).toBeGreaterThan(0)
  })
})

describe('styleTagsFor / primaryArtist / titleTokens', () => {
  it('derives style tags deterministically from titles', () => {
    expect(styleTagsFor({ title: 'Believer (Live)' })).toContain('live')
    expect(styleTagsFor({ title: 'Shape of You - Acoustic' })).toContain('acoustic')
    expect(styleTagsFor({ title: 'Kun Faya Kun' })).toEqual([])
    expect(styleTagsFor({ title: 'X', tags: ['sufi'] })).toEqual(['sufi'])
  })

  it('uses the first artist as primary and normalizes case', () => {
    expect(primaryArtist('Anirudh Ravichander, Gana Balachandar')).toBe('anirudh ravichander')
    expect(primaryArtist(undefined)).toBe('')
  })

  it('drops noise words from title tokens', () => {
    expect(titleTokens('Why This Kolaveri Di (Official Video)')).toEqual(
      expect.arrayContaining(['why', 'this', 'kolaveri']),
    )
    expect(titleTokens('Why This Kolaveri Di (Official Video)')).not.toContain('official')
  })
})
