import { describe, expect, it } from 'vitest'
import type { Track } from '../bridge/types'
import {
  buildRadioBatch, canonicalSongKey, identityKeyOf, netSkipsFor, normalizeArtistKey,
  radioSeedFromTrack, scoreCandidate, splitArtists, verifiedSeedContext,
  W_TITLE_COLLISION, type RadioContext,
} from './radio'
import { tasteSnapshot } from './taste'

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
    duration: 200,
    explicit: false,
    ...extra,
  }
}

function ctx(overrides: Partial<RadioContext> = {}): RadioContext {
  return {
    seed: radioSeedFromTrack(track('seed', { title: 'Seed Song', artist: 'Einaudi, Other' })),
    blockedIds: new Set(['yt:seed']),
    blockedKeys: new Set([canonicalSongKey({ title: 'Seed Song', artist: 'Einaudi' })]),
    dislikedIds: new Set(),
    veryRecentIds: new Set(),
    heardIds: new Set(),
    recentArtistKeys: new Set(),
    likedIds: new Set(),
    likedArtistKeys: new Set(),
    artistPlays: new Map(),
    netSkips: new Map(),
    ...overrides,
  }
}

describe('seeds and canonicalisation', () => {
  it('builds a seed from the metadata the provider supplies', () => {
    const seed = radioSeedFromTrack(
      track('a', { title: 'Nuvole Bianche', artist: 'Einaudi, Other', album: 'Album', duration: 360 }),
    )
    expect(seed.normalizedTitle).toBe('nuvolebianche')
    expect(seed.primaryArtist).toBe('einaudi')
    expect(seed.otherArtists).toEqual(['other'])
    expect(seed.album).toBe('Album')
    expect(seed.duration).toBe(360)
  })

  it('recognises upload noise in artists ("- Topic", "VEVO")', () => {
    expect(normalizeArtistKey('Einaudi - Topic')).toBe('einaudi')
    expect(normalizeArtistKey('SomeArtistVEVO')).toBe('someartist')
    expect(splitArtists('A, B & C')[1]).toBe('b')
  })

  it('canonicalSongKey collapses versions of one song but not different songs sharing a title', () => {
    const believer = canonicalSongKey({ title: 'Believer', artist: 'Imagine Dragons' })
    expect(canonicalSongKey({ title: 'Believer (Official Video)', artist: 'Imagine Dragons - Topic' })).toBe(believer)
    expect(canonicalSongKey({ title: 'Believer (Lyric Video)', artist: 'Imagine Dragons' })).toBe(believer)
    // A genuinely different song that merely shares the title stays distinct.
    expect(canonicalSongKey({ title: 'Believer', artist: 'Oceana' })).not.toBe(believer)
  })
})

describe('scoreCandidate', () => {
  it('rewards the seed artist without rejecting same-artist tracks', () => {
    const base = ctx()
    const same = track('x', { artist: 'Einaudi' })
    const other = track('y', { artist: 'Stranger' })
    expect(scoreCandidate(same, base, 0, 2)).toBeGreaterThan(scoreCandidate(other, base, 0, 2))
    expect(scoreCandidate(other, base, 0, 2)).toBeGreaterThan(-10) // still playable, just weaker
  })

  it('rewards album context and liked tracks/artists', () => {
    const seed = radioSeedFromTrack(track('seed', { title: 'S', artist: 'Einaudi', album: 'Album X' }))
    const liked = track('liked', { artist: 'Einaudi' })
    const likedOther = track('likedother', { artist: 'Fave' })
    const base = ctx({
      seed,
      likedIds: new Set([liked.id]),
      likedArtistKeys: new Set(['fave']),
    })
    const plain = track('plain', { artist: 'Einaudi' })
    expect(scoreCandidate(liked, base, 0, 3)).toBeGreaterThan(scoreCandidate(plain, base, 0, 3))
    expect(scoreCandidate(likedOther, base, 0, 3)).toBeGreaterThan(
      scoreCandidate(track('unloved', { artist: 'Nobody' }), base, 0, 3),
    )
    const inAlbum = track('album-mate', { artist: 'Einaudi', album: 'Album X' })
    expect(scoreCandidate(inAlbum, base, 0, 3)).toBeGreaterThan(scoreCandidate(plain, base, 0, 3))
  })

  it('rewards frequently played artists gradually and boundedly', () => {
    const base = ctx({ artistPlays: new Map([['marlow', 50]]) })
    const favourite = track('m', { artist: 'Marlow' })
    const stranger = track('s', { artist: 'Stranger' })
    const withPlays = scoreCandidate(favourite, base, 0, 2)
    expect(withPlays).toBeGreaterThan(scoreCandidate(stranger, base, 0, 2))
    // The bonus is bounded: it can never dominate by raw play count alone.
    expect(withPlays).toBeLessThan(scoreCandidate(stranger, base, 0, 2) + 2)
  })

  it('penalises recently heard tracks and recent skips — weaker than dislike', () => {
    const skipped = track('skipped')
    const heard = track('heard')
    const base = ctx({
      heardIds: new Set([heard.id]),
      netSkips: new Map([[skipped.id, 1]]),
    })
    const plain = track('plain')
    const plainScore = scoreCandidate(plain, base, 0, 3)
    expect(scoreCandidate(heard, base, 0, 3)).toBeLessThan(plainScore)
    expect(scoreCandidate(skipped, base, 0, 3)).toBeLessThan(plainScore)
    // A skip is a penalty, never an exclusion: the score stays reasonable…
    expect(scoreCandidate(skipped, base, 0, 3)).toBeGreaterThan(plainScore - 5)
    // …while a dislike removes the track from the batch entirely.
    const nope = track('nope')
    const disliked = buildRadioBatch([nope], { ...base, dislikedIds: new Set([nope.id]) }, { limit: 5 })
    expect(disliked).toHaveLength(0)
  })

  it('down-weights artists that already dominated the recent window', () => {
    const base = ctx({ recentArtistKeys: new Set(['einaudi']) })
    const seedArtist = track('x', { artist: 'Einaudi' })
    const stranger = track('y', { artist: 'Stranger' })
    expect(scoreCandidate(seedArtist, base, 0, 2)).toBeLessThan(
      scoreCandidate(seedArtist, ctx({ recentArtistKeys: new Set() }), 0, 2),
    )
    // The seed bonus still outweighs the variety penalty — familiarity wins.
    expect(scoreCandidate(seedArtist, base, 0, 2)).toBeGreaterThan(scoreCandidate(stranger, base, 0, 2))
  })
})

describe('buildRadioBatch', () => {
  it('never contains the current track, blocked ids, duplicates or dislikes', () => {
    const dup = track('dup')
    const batch = buildRadioBatch(
      [
        track('seed', { title: 'Seed Song', artist: 'Einaudi' }), // blocked id + key
        track('q1'),
        dup,
        dup, // exact duplicate id within the batch
        track('nope'), // disliked
        track('q2'),
      ],
      ctx({ dislikedIds: new Set(['yt:nope']) }),
      { limit: 10 },
    )
    const ids = batch.map((t) => t.id)
    expect(ids).toContain('yt:q1')
    expect(ids).toContain('yt:q2')
    expect(ids.filter((id) => id === 'yt:dup')).toHaveLength(1)
    expect(ids).not.toContain('yt:seed')
    expect(ids).not.toContain('yt:nope')
  })

  it('drops further versions of the same canonical song', () => {
    const batch = buildRadioBatch(
      [
        track('v1', { title: 'Believer', artist: 'Imagine Dragons' }),
        track('v2', { title: 'Believer (Official Video)', artist: 'Imagine Dragons - Topic' }),
        track('v3', { title: 'Believer [Lyrics]', artist: 'Imagine Dragons' }),
        track('other', { title: 'Thunder', artist: 'Imagine Dragons' }),
      ],
      ctx(),
      { limit: 10 },
    )
    expect(batch.map((t) => t.id)).toEqual(['yt:v1', 'yt:other'])
  })

  it('excludes very recently played tracks and keeps different new songs flowing', () => {
    const batch = buildRadioBatch(
      [track('r1'), track('n1'), track('n2')],
      ctx({ veryRecentIds: new Set(['yt:r1']) }),
      { limit: 10 },
    )
    expect(batch.map((t) => t.id)).toEqual(['yt:n1', 'yt:n2'])
  })

  it('excludes non-music durations but tolerates unknown duration', () => {
    const batch = buildRadioBatch(
      [
        track('mix', { duration: 4500 }), // 75-minute DJ mix
        track('jingle', { duration: 12 }),
        track('unknown', { duration: 0 }),
      ],
      ctx(),
      { limit: 10 },
    )
    expect(batch.map((t) => t.id)).toEqual(['yt:unknown'])
  })

  it('breaks artist runs while a good mix is available', () => {
    // Ten Artist-A songs rank highest; B and C songs are close alternatives.
    const aTracks = Array.from({ length: 10 }, (_, i) => track(`a${i}`, { title: `A Song ${i}`, artist: 'Big Artist' }))
    const bTracks = Array.from({ length: 5 }, (_, i) => track(`b${i}`, { title: `B Song ${i}`, artist: 'Other Artist' }))
    const cTracks = Array.from({ length: 5 }, (_, i) => track(`c${i}`, { title: `C Song ${i}`, artist: 'Third' }))
    const batch = buildRadioBatch([...aTracks, ...bTracks, ...cTracks], ctx({ blockedIds: new Set() }), {
      limit: 12,
      windowSize: 5,
      maxPerArtistInWindow: 2,
    })
    expect(batch).toHaveLength(12)
    // No window of 5 consecutive tracks may hold 3+ of the same artist.
    for (let i = 0; i + 5 <= batch.length; i += 1) {
      const window = batch.slice(i, i + 5)
      const counts = new Map<string, number>()
      for (const t of window) counts.set(t.artist, (counts.get(t.artist) ?? 0) + 1)
      for (const count of counts.values()) expect(count).toBeLessThan(3)
    }
    // Same-artist tracks are still welcome — the batch is not stripped of them.
    expect(batch.filter((t) => t.artist === 'Big Artist').length).toBeGreaterThanOrEqual(4)
  })

  it('allows a homogeneous pool (a legitimate artist radio) to fill the batch', () => {
    const pool = Array.from({ length: 10 }, (_, i) => track(`a${i}`, { title: `Song ${i}`, artist: 'Only Artist' }))
    const batch = buildRadioBatch(pool, ctx({ blockedIds: new Set() }), { limit: 10 })
    expect(batch).toHaveLength(10)
    expect(batch.every((t) => t.artist === 'Only Artist')).toBe(true)
  })

  it('continues the diversity window across batches via queueTailArtists', () => {
    // Queue tail already ends with two Big Artist songs.
    const batch = buildRadioBatch(
      [track('a1', { artist: 'Big Artist' }), track('b1', { artist: 'Other' })],
      ctx({ blockedIds: new Set() }),
      { limit: 2, queueTailArtists: ['big artist', 'big artist'] },
    )
    expect(batch.map((t) => t.id)).toEqual(['yt:b1', 'yt:a1'])
  })

  it('is deterministic for the same input', () => {
    const pool = Array.from({ length: 20 }, (_, i) => track(`p${i}`, { title: `Song ${i}`, artist: i % 2 ? 'A' : 'B' }))
    const base = ctx({ blockedIds: new Set() })
    expect(buildRadioBatch(pool, base, { limit: 10 })).toEqual(buildRadioBatch(pool, base, { limit: 10 }))
  })

  it('honours the bound', () => {
    const pool = Array.from({ length: 60 }, (_, i) => track(`p${i}`, { title: `Song ${i}`, artist: `Artist ${i % 7}` }))
    expect(buildRadioBatch(pool, ctx({ blockedIds: new Set() }), { limit: 20 })).toHaveLength(20)
  })
})

describe('taste snapshot', () => {
  it('separates the very-recent exclusion window from the wider recency window', () => {
    const history = Array.from({ length: 10 }, (_, i) => ({
      track: track(`h${i}`),
      playedAt: Date.now() - i * 1000,
    }))
    const snap = tasteSnapshot(history, {}, 8, 3)
    expect([...snap.recentIds]).toEqual(['yt:h0', 'yt:h1', 'yt:h2'])
    expect(snap.heardIds.has('yt:h7')).toBe(true)
    expect(snap.heardIds.has('yt:h8')).toBe(false)
  })

  it('derives artist play counts and net skips', () => {
    const history = [
      { track: track('x', { artist: 'Marlow' }), playedAt: 1 },
      { track: track('y', { artist: 'Marlow' }), playedAt: 2 },
    ]
    const snap = tasteSnapshot(history, {
      'yt:x': { playCount: 5, significantCount: 3, completeCount: 4, skipCount: 1, lastPlayedAt: 9 },
      'yt:z': { playCount: 3, significantCount: 0, completeCount: 0, skipCount: 2, lastPlayedAt: 8 },
    })
    expect(snap.artistPlays.get('marlow')).toBe(6)
    expect(snap.netSkips.get('yt:x')).toBe(0) // completions outweigh skips
    expect(snap.netSkips.get('yt:z')).toBe(2)
    expect(netSkipsFor({ playCount: 1, significantCount: 0, completeCount: 1, skipCount: 3, lastPlayedAt: 0 })).toBe(2)
  })
})

describe('music identity (artist vs uploader)', () => {
  it('identityKeyOf prefers the performing artist and falls back to the uploader', () => {
    expect(identityKeyOf(track('a', { artist: 'Einaudi', uploader: 'some channel' }))).toBe('einaudi')
    expect(identityKeyOf(track('b', { artist: '', uploader: 'Fearless' }))).toBe('fearless')
    expect(identityKeyOf(track('c', { artist: '', uploader: 'X - Topic' }))).toBe('x')
  })

  it('verifiedSeedContext accepts the seed artist, never a shared title or an uploader', () => {
    const seed = radioSeedFromTrack(track('seed', { title: 'Nightfall', artist: 'Halcyon' }))
    expect(verifiedSeedContext(track('x', { title: 'Other Song', artist: 'Halcyon' }), seed)).toBe(true)
    // Three unrelated songs that merely share the title — all rejected.
    expect(verifiedSeedContext(track('t1', { title: 'Nightfall', artist: 'Taylor Swift' }), seed)).toBe(false)
    expect(verifiedSeedContext(track('t2', { title: 'Nightfall', artist: 'Pink Floyd' }), seed)).toBe(false)
    expect(verifiedSeedContext(track('t3', { title: 'Nightfall', artist: 'LE SSERAFIM' }), seed)).toBe(false)
    // Channel-name matches and artist-less uploads are not context either.
    expect(verifiedSeedContext(track('u1', { title: 'Nightfall', artist: '', uploader: 'Halcyon' }), seed)).toBe(false)
    expect(verifiedSeedContext(track('u2', { title: 'Whatever', artist: '' }), seed)).toBe(false)
    // Album seeds also accept album mates.
    const albumSeed = radioSeedFromTrack(
      track('s2', { title: 'X', artist: 'Halcyon', album: 'Blue Hours' }),
      'album',
    )
    expect(verifiedSeedContext(track('m1', { title: 'Y', artist: 'Guest', album: 'Blue Hours' }), albumSeed)).toBe(true)
    expect(verifiedSeedContext(track('m2', { title: 'Y', artist: 'Guest', album: 'Other' }), albumSeed)).toBe(false)
    // An uploader-only seed verifies nothing: it must never text-search.
    const channelSeed = radioSeedFromTrack(track('s3', { title: 'Farben (Slowed)', artist: '', uploader: 'fearless' }))
    expect(verifiedSeedContext(track('f1', { title: 'Farben', artist: '', uploader: 'fearless' }), channelSeed)).toBe(false)
  })

  it('demotes candidates that share the seed title but not its artist', () => {
    const base = ctx()
    const plain = track('plain', { title: 'Unrelated Title', artist: 'Someone' })
    const collision = { ...plain, title: 'Seed Song' } // the seed's normalized title
    const delta =
      scoreCandidate(collision, base, 0, 2) - scoreCandidate(plain, base, 0, 2)
    expect(delta).toBeCloseTo(W_TITLE_COLLISION)
    // The seed's own song version (same artist) is NOT demoted — that is
    // dedupe's job, not relevance's.
    const own = { ...plain, title: 'Seed Song', artist: 'Einaudi' }
    expect(scoreCandidate(own, base, 0, 2)).toBeGreaterThan(scoreCandidate(collision, base, 0, 2))
  })
})

describe('provider recommendation order', () => {
  it('keeps the feed order when there are no taste signals', () => {
    const feed = Array.from({ length: 6 }, (_, i) => track(`f${i}`, { title: `Rec ${i}`, artist: `Artist ${i}` }))
    const batch = buildRadioBatch(feed, ctx({ blockedIds: new Set() }), { limit: 6, source: 'provider' })
    expect(batch.map((t) => t.id)).toEqual(feed.map((t) => t.id))
  })

  it('lets likes climb a neighbouring track without overriding the feed leader', () => {
    const feed = [
      track('f0', { title: 'Leader', artist: 'Feed One' }),
      track('f1', { title: 'Second', artist: 'Feed Two' }),
      track('f2', { title: 'Liked', artist: 'Fave' }),
      track('f3', { title: 'Fourth', artist: 'Feed Four' }),
    ]
    const base = ctx({
      blockedIds: new Set(),
      likedIds: new Set(['yt:f2']),
      likedArtistKeys: new Set(['fave']),
    })
    const batch = buildRadioBatch(feed, base, { limit: 4, source: 'provider' })
    expect(batch.map((t) => t.id)).toEqual(['yt:f0', 'yt:f2', 'yt:f1', 'yt:f3'])
  })

  it('hard-filters text-search batches to identity-verified candidates', () => {
    const seedTrack = track('seed', { title: 'Nightfall', artist: 'Halcyon' })
    const seed = radioSeedFromTrack(seedTrack)
    const base = ctx({ seed, blockedIds: new Set() })
    const searchResults = [
      track('t1', { title: 'Nightfall', artist: 'Taylor Swift' }),
      track('t2', { title: 'Nightfall', artist: 'Pink Floyd' }),
      track('ok1', { title: 'Paper Lanterns', artist: 'Halcyon' }),
      track('u1', { title: 'Nightfall', artist: '', uploader: 'Halcyon' }),
    ]
    const batch = buildRadioBatch(searchResults, base, { limit: 5, verifiedOnly: true })
    expect(batch.map((t) => t.id)).toEqual(['yt:ok1'])
  })

  it('diversifies by uploader when no artist is known (no channel runs)', () => {
    const by = (channel: string, n: number, prefix: string) =>
      Array.from({ length: n }, (_, i) => track(`${prefix}${i}`, { title: `Upload ${prefix}${i}`, artist: '', uploader: channel }))
    const batch = buildRadioBatch(
      [...by('Same Channel', 6, 'c'), ...by('Other Channel', 3, 'o'), ...by('Third Channel', 3, 't')],
      ctx({ blockedIds: new Set() }),
      { limit: 10, windowSize: 5, maxPerArtistInWindow: 2 },
    )
    expect(batch).toHaveLength(10)
    // No window of 5 consecutive tracks may hold 3 uploads of one channel.
    for (let i = 0; i + 5 <= batch.length; i += 1) {
      const uploaders = batch.slice(i, i + 5).map((t) => t.uploader)
      for (const channel of ['Same Channel', 'Other Channel', 'Third Channel']) {
        expect(uploaders.filter((u) => u === channel).length).toBeLessThan(3)
      }
    }
    // The dominant channel is still well represented — variety, not exclusion.
    expect(batch.filter((t) => t.uploader === 'Same Channel').length).toBeGreaterThanOrEqual(4)
  })
})
