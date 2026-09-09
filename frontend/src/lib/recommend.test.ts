import { describe, expect, it } from 'vitest'
import type { PlayRecord, Track } from '../bridge/types'
import { buildProfile, type ListeningProfile } from './profile'
import {
  anchorQueries, reRankBuffer, scoreCandidate, selectRecommendations,
  type RecommendationContext,
} from './recommend'

function track(id: string, extra: Partial<Track> = {}): Track {
  return {
    id, sourceId: id, source: 'youtube', url: '', title: `Song ${id}`,
    artist: 'Someone', album: '', artwork: '', duration: 200, explicit: false, ...extra,
  }
}

function profileFrom(history: PlayRecord[], liked: Track[] = []): ListeningProfile {
  return buildProfile(history, liked, 1000 * 3600_000)
}

function record(t: Track, playedAt: number, detail: Partial<PlayRecord> = {}): PlayRecord {
  return {
    track: t, playedAt, listenedSec: 200, trackDuration: 200, completed: true, skipped: false,
    ...detail,
  }
}

function ctx(overrides: Partial<RecommendationContext> = {}): RecommendationContext {
  return {
    current: null,
    profile: profileFrom([]),
    blockedIds: new Set<string>(),
    blockedTitleKeys: new Set<string>(),
    buffer: [],
    ...overrides,
  }
}

describe('scoreCandidate', () => {
  it('a different-artist track with strong affinity can beat a weak same-artist track', () => {
    // The listener has played Anirudh non-stop for days; the current track is
    // by someone else entirely. An Anirudh track should outrank an unrelated
    // track from the current artist with no history behind it.
    const now = 1000 * 3600_000
    const history = [
      record(track('h1', { artist: 'Anirudh Ravichander' }), now - 3600_000),
      record(track('h2', { artist: 'Anirudh Ravichander' }), now - 7200_000),
      record(track('h3', { artist: 'Anirudh Ravichander' }), now - 10800_000),
    ]
    const profile = profileFrom(history)
    const current = track('cur', { artist: 'Coldplay', title: 'Viva La Vida' })
    const anirudhTrack = track('an1', { artist: 'Anirudh Ravichander', title: 'Vaathi Coming' })
    const coldplayTrack = track('cp1', { artist: 'Coldplay', title: 'Totally Unrelated B Side' })

    const score = scoreCandidate(anirudhTrack, { ...ctx(), current, profile }, 5)
    const coldplayScore = scoreCandidate(coldplayTrack, { ...ctx(), current, profile }, 5)
    expect(score).toBeGreaterThan(coldplayScore)
  })

  it('penalises an artist that already dominates the buffer', () => {
    const current = track('cur', { artist: 'Imagine Dragons' })
    const candidate = track('x', { artist: 'Imagine Dragons' })
    const alone = scoreCandidate(candidate, ctx({ current, buffer: [] }))
    const crowded = scoreCandidate(
      candidate,
      ctx({ current, buffer: [track('b1', { artist: 'Imagine Dragons' }), track('b2', { artist: 'Imagine Dragons' }), track('b3', { artist: 'Imagine Dragons' })] }),
    )
    expect(crowded).toBeLessThan(alone)
  })

  it('penalises tracks played before, but does not exclude them', () => {
    const t = track('old', { artist: 'Old' })
    const profile = profileFrom([record(t, 999_000_000_000)])
    const fresh = track('fresh', { artist: 'Old' })
    const playedScore = scoreCandidate(t, ctx({ profile }))
    const freshScore = scoreCandidate(fresh, ctx({ profile }))
    expect(playedScore).toBeLessThan(freshScore)
  })
})

describe('selectRecommendations', () => {
  const pool = [
    ...Array.from({ length: 6 }, (_, i) => track(`same${i}`, { artist: 'One Artist', title: `Hit ${i}` })),
    ...Array.from({ length: 6 }, (_, i) => track(`other${i}`, { artist: `Other Artist ${i}`, title: `Track ${i}` })),
  ]

  it('never allows more than two consecutive tracks from one artist', () => {
    const picked = selectRecommendations(pool, ctx(), 8)
    expect(picked.length).toBeGreaterThanOrEqual(6)
    let run = 1
    for (let i = 1; i < picked.length; i += 1) {
      if (picked[i].artist === picked[i - 1].artist) run += 1
      else run = 1
      expect(run).toBeLessThanOrEqual(2)
    }
  })

  it('caps how much of the buffer one artist can fill', () => {
    const picked = selectRecommendations(pool, ctx(), 10)
    const byArtist = new Map<string, number>()
    for (const t of picked) byArtist.set(t.artist, (byArtist.get(t.artist) ?? 0) + 1)
    for (const count of byArtist.values()) {
      // ~40% of (buffer + additions), floored by the run cap.
      expect(count).toBeLessThanOrEqual(5)
    }
    // Relevance still leads: the dominant artist keeps a real presence.
    expect(byArtist.get('One Artist')!).toBeGreaterThanOrEqual(2)
  })

  it('is deterministic — same inputs, same output', () => {
    const a = selectRecommendations(pool, ctx(), 8)
    const b = selectRecommendations(pool, ctx(), 8)
    expect(a.map((t) => t.id)).toEqual(b.map((t) => t.id))
  })

  it('excludes blocked ids, blocked titles and recently skipped tracks', () => {
    const skippedTrack = track('sk', { title: 'Skip Me' })
    const profile = profileFrom([record(skippedTrack, 999_900_000_000, { skipped: true, completed: false, listenedSec: 3 })])
    const picked = selectRecommendations(
      [
        track('same', { title: 'Different Title' }),
        track('dupe-title', { title: 'Different Title (Official Video)' }),
        track('blocked', { title: 'Blocked Id' }),
        skippedTrack,
        track('upload', { title: 'Best of 2019 - 1 Hour Nonstop Mix', duration: 4000 }),
      ],
      ctx({
        profile,
        blockedIds: new Set(['blocked']),
        blockedTitleKeys: new Set(['differenttitle']),
      }),
      10,
    )
    expect(picked).toHaveLength(0)
  })

  it('keeps a high-affinity artist from a different artist than the current track', () => {
    const now = 1000 * 3600_000
    const history = [
      record(track('h1', { artist: 'Sid Sriram' }), now - 3600_000),
      record(track('h2', { artist: 'Sid Sriram' }), now - 7200_000),
    ]
    const current = track('cur', { artist: 'AC/DC' })
    const picked = selectRecommendations(
      [
        track('random1', { artist: 'Totally Random Band' }),
        track('sid1', { artist: 'Sid Sriram' }),
      ],
      ctx({ current, profile: profileFrom(history) }),
      2,
    )
    expect(picked[0]?.id).toBe('sid1')
  })
})

describe('reRankBuffer', () => {
  it('preserves every item while reordering around the new anchor', () => {
    const current = track('cur', { artist: 'Anchor' })
    const buffer = [
      track('a', { artist: 'Other' }),
      track('b', { artist: 'Anchor' }),
      track('c', { artist: 'Third' }),
    ]
    const ranked = reRankBuffer(buffer, ctx({ current, buffer: [] }))
    expect(new Set(ranked.map((t) => t.id))).toEqual(new Set(buffer.map((t) => t.id)))
    expect(ranked[0].id).toBe('b') // same artist as the new anchor leads
  })
})

describe('anchorQueries', () => {
  it('separates current-track anchors from listener-profile anchors', () => {
    const now = 1000 * 3600_000
    const history = [
      record(track('h1', { artist: 'Anirudh Ravichander' }), now - 3600_000),
      record(track('h2', { artist: 'Anirudh Ravichander' }), now - 7200_000),
      record(track('h3', { artist: 'Dhanush' }), now - 10800_000),
    ]
    const current = track('cur', { artist: 'A.R. Rahman', title: 'Kun Faya Kun' })
    const anchors = anchorQueries(current, profileFrom(history), [])
    expect(anchors.current).toEqual(['A.R. Rahman', 'Kun Faya Kun A.R. Rahman'])
    // Affinity artists lead the profile side, in weight order.
    expect(anchors.profile[0]).toBe('anirudh ravichander')
    expect(anchors.profile.indexOf('anirudh ravichander')).toBeLessThan(anchors.profile.indexOf('dhanush'))
    // The current artist never appears on the profile side.
    expect(anchors.profile).not.toContain('a.r. rahman')
  })

  it('surfaces liked artists that history has not', () => {
    const liked = [track('l1', { artist: 'Sai Abhyankar' })]
    const anchors = anchorQueries(null, profileFrom([], liked), liked)
    expect(anchors.profile).toContain('sai abhyankar')
    expect(anchors.current).toEqual([])
  })
})
