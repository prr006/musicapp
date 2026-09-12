/**
 * Tests for web lyrics fetching: LRC parsing (including [offset:] tags),
 * recording-aware candidate selection, and the per-track drift registry.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bestMatch, fetchWebLyrics, parseLrc, resolveTrackDrift } from './webLyrics'
import type { LyricsQuery } from '../bridge/types'

interface Hit {
  id: number
  trackName: string
  artistName: string
  albumName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

const ctx = (over: Partial<LyricsQuery> = {}): LyricsQuery => ({
  trackId: 't1',
  title: 'Some Song',
  artist: 'The Artist',
  album: '',
  duration: 210,
  ...over,
})

describe('parseLrc', () => {
  it('parses m:ss and mm:ss times, keeping order', () => {
    const out = parseLrc('[00:05.50] A\n[01:02] B\n[00:01] C\n')
    expect(out.map((l) => l.time)).toEqual([1, 5.5, 62])
    expect(out.map((l) => l.text)).toEqual(['C', 'A', 'B'])
  })

  it('applies a positive [offset:] tag (lyrics moved later)', () => {
    const out = parseLrc('[offset:+500]\n[00:10] Line\n[00:20] Next\n')
    expect(out.map((l) => l.time)).toEqual([10.5, 20.5])
  })

  it('applies a negative [offset:] tag (lyrics moved earlier)', () => {
    const out = parseLrc('[offset:-1000]\n[00:10] Line\n[00:20] Next\n')
    expect(out.map((l) => l.time)).toEqual([9, 19])
  })

  it('clamps offset-shifted times below zero away', () => {
    const out = parseLrc('[offset:-5000]\n[00:03] Early\n[00:10] Line\n')
    expect(out.map((l) => l.time)).toEqual([5])
  })

  it('ignores metadata tags such as [ti:], [ar:], [length:]', () => {
    const out = parseLrc('[ti:Some Song]\n[ar:The Artist]\n[length:03:30]\n[00:10] Line\n')
    expect(out.map((l) => l.text)).toEqual(['Line'])
  })

  it('drops malformed timing lines', () => {
    const out = parseLrc('no timestamp\n[xx:yy] bad\n[00:10] OK\n')
    expect(out.map((l) => l.text)).toEqual(['OK'])
  })
})

describe('bestMatch — recording awareness', () => {
  it('prefers a synced hit over a plain-lyrics hit', () => {
    const hits: Hit[] = [
      { id: 1, trackName: 'Some Song', artistName: 'The Artist', duration: 210, syncedLyrics: '[00:01] x' },
      { id: 2, trackName: 'Some Song', artistName: 'The Artist', duration: 210, plainLyrics: 'x' },
    ]
    const hit = bestMatch(hits, ctx())
    expect(hit?.id).toBe(1)
  })

  it('rejects a remix when the played track is the original', () => {
    const hits: Hit[] = [
      { id: 1, trackName: 'Some Song (Remix)', artistName: 'The Artist', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
      { id: 2, trackName: 'Some Song', artistName: 'The Artist', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
    ]
    const hit = bestMatch(hits, ctx({ duration: 210 }))
    expect(hit?.id).toBe(2)
  })

  it('prefers the original hit when the played track has no version marker', () => {
    const hits: Hit[] = [
      { id: 1, trackName: 'Some Song', artistName: 'The Artist', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
      { id: 2, trackName: 'Some Song (Live)', artistName: 'The Artist', duration: 211, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
    ]
    const hit = bestMatch(hits, ctx({ duration: 210 }))
    expect(hit?.id).toBe(1)
  })

  it('keeps a remix when the played track is itself a remix', () => {
    const hits: Hit[] = [
      { id: 1, trackName: 'Some Song', artistName: 'The Artist', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
      { id: 2, trackName: 'Some Song (Remix)', artistName: 'The Artist', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
    ]
    const hit = bestMatch(hits, ctx({ title: 'Some Song (Remix)', duration: 210 }))
    expect(hit?.id).toBe(2)
  })

  it('prefers the exact-length recording over a merely-close one', () => {
    const hits: Hit[] = [
      { id: 1, trackName: 'Some Song', artistName: 'The Artist', duration: 205, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
      { id: 2, trackName: 'Some Song', artistName: 'The Artist', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
    ]
    const hit = bestMatch(hits, ctx({ duration: 210 }))
    expect(hit?.id).toBe(2)
  })

  it('prefers an exact-title hit over a merely-supplementary one', () => {
    const hits: Hit[] = [
      { id: 1, trackName: 'Some Song (Other Version)', artistName: 'The Artist', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
      { id: 2, trackName: 'Some Song', artistName: 'The Artist', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
    ]
    const hit = bestMatch(hits, ctx({ duration: 210 }))
    expect(hit?.id).toBe(2)
  })

  it('prefers a hit whose primary artist contains the queried artist', () => {
    const hits: Hit[] = [
      { id: 1, trackName: 'Some Song', artistName: 'Someone Else', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
      { id: 2, trackName: 'Some Song', artistName: 'The Artist, Feat. Guest', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
    ]
    const hit = bestMatch(hits, ctx({ duration: 210 }))
    expect(hit?.id).toBe(2)
  })

  it('drops instrumental hits when the track has lyrics', () => {
    const hits: Hit[] = [
      { id: 1, trackName: 'Some Song', artistName: 'The Artist', duration: 210, instrumental: true, plainLyrics: 'x' },
      { id: 2, trackName: 'Some Song', artistName: 'The Artist', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
    ]
    const hit = bestMatch(hits, ctx({ duration: 210 }))
    expect(hit?.id).toBe(2)
  })

  it('penalizes candidates with no duration when the track has a known duration', () => {
    const hits: Hit[] = [
      { id: 1, trackName: 'Some Song', artistName: 'The Artist', syncedLyrics: '[00:01] x', plainLyrics: 'x' },
      { id: 2, trackName: 'Some Song', artistName: 'The Artist', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
    ]
    const hit = bestMatch(hits, ctx({ duration: 210 }))
    expect(hit?.id).toBe(2)
  })

  it('penalizes album disagreement between query and hit', () => {
    const hits: Hit[] = [
      { id: 1, trackName: 'Some Song', artistName: 'The Artist', duration: 210, albumName: 'Album A', syncedLyrics: '[00:01] x', plainLyrics: 'x' },
      { id: 2, trackName: 'Some Song', artistName: 'The Artist', duration: 210, albumName: 'Album B', syncedLyrics: '[00:01] x', plainLyrics: 'x' },
    ]
    const hit = bestMatch(hits, ctx({ duration: 210, album: 'Album A' }))
    expect(hit?.id).toBe(1)
  })

  it('boosts artist containment with substring match', () => {
    const hits: Hit[] = [
      { id: 1, trackName: 'Some Song', artistName: 'Artist X', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
      { id: 2, trackName: 'Some Song', artistName: 'The Artist, Feat. Guest', duration: 210, syncedLyrics: '[00:01] x', plainLyrics: 'x' },
    ]
    const hit = bestMatch(hits, ctx({ duration: 210 }))
    expect(hit?.id).toBe(2)
  })
})

describe('resolveTrackDrift — per-track only', () => {
  const castQuery: LyricsQuery = {
    trackId: 't1',
    title: 'Yeshanagula | The Paradise | Nani | Keerthy Suresh | Anirudh Ravichander',
    artist: 'TNA Productions',
    album: '',
    duration: 192,
  }

  it('applies the offset to the cast-listed upload', () => {
    expect(resolveTrackDrift(castQuery)).toBe(-3)
  })

  it('applies the offset regardless of a director/channel suffix', () => {
    const withDirector: LyricsQuery = {
      ...castQuery,
      title: 'Yeshanagula | The Paradise | Nani | Keerthy Suresh | Anirudh Ravichander | Srikanth Odela',
    }
    expect(resolveTrackDrift(withDirector)).toBe(-3)
  })

  it('leaves the official single untouched', () => {
    const official: LyricsQuery = { ...castQuery, title: 'Yeshanagula (From "The Paradise") (Telugu)', duration: 189 }
    expect(resolveTrackDrift(official)).toBe(0)
  })

  it('leaves fanmade/DJ mirrors (no star names) untouched', () => {
    const fanmade: LyricsQuery = {
      ...castQuery,
      title: 'Yeshanagula | Jumma Jummavva (The Paradise Movie Fanmade Song)',
    }
    expect(resolveTrackDrift(fanmade)).toBe(0)
  })

it('leaves out-of-range cast durations untouched', () => {
    expect(resolveTrackDrift({ ...castQuery, duration: 200 })).toBe(0)
  })

  it('leaves unrelated tracks untouched', () => {
    expect(resolveTrackDrift(ctx())).toBe(0)
  })
})

describe('fetchWebLyrics — end to end', () => {
  afterEach(() => vi.unstubAllGlobals())

  const synced = '[00:22.40] హే జిమ్మెదరీ\n[00:45.00] ముద్దుకి\n'

  const castHits = [
    { id: 38290908, trackName: 'Yeshanagula (From "The Paradise") (Telugu)', artistName: 'Anirudh Ravichander', albumName: 'Yeshanagula (From "The Paradise") (Telugu)', duration: 188, syncedLyrics: synced, plainLyrics: 'x' },
    { id: 38187363, trackName: 'Yeshanagula', artistName: 'Anirudh Ravichander, Singer Prabha, Jangi Reddy, Kasarla Shyam', albumName: 'The Paradise', duration: 189, syncedLyrics: '[00:22.64] Hey..\n[00:45.10] Moodu..\n[01:20] Next\n', plainLyrics: 'x' },
  ]

  function stub(search: (url: string) => unknown[]) {
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      const text = String(url)
      const hits = search(text)
      return new Response(JSON.stringify(hits), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
  }

  it('applies the per-track drift to a cast-listed upload', async () => {
    stub((url) => {
      if (url.includes('artist_name')) return []
      return castHits
    })
    const result = await fetchWebLyrics({
      trackId: 'vid-1',
      title: 'Yeshanagula | The Paradise | Nani | Keerthy Suresh | Anirudh Ravichander',
      artist: 'TNA Productions',
      album: '',
      duration: 192,
    })
    expect(result.offset).toBe(-3)
    expect(result.synced).toBe(true)
  })

  it('does not apply any drift to the official single', async () => {
    stub(() => castHits)
    const result = await fetchWebLyrics({
      trackId: 'vid-2',
      title: 'Yeshanagula (From "The Paradise") (Telugu)',
      artist: 'Anirudh Ravichander',
      album: '',
      duration: 189,
    })
    expect(result.offset).toBe(0)
  })
})

describe('fetchWebLyrics — YTM timed-lyrics fallback', () => {
  afterEach(() => vi.unstubAllGlobals())

  const plainOnly = [
    { id: 1, trackName: 'Some Song', artistName: 'The Artist', duration: 210, plainLyrics: 'plain text only' },
  ]

  const ytmSynced = [
    { time: 0.5, text: 'YTM Line 1' },
    { time: 5.0, text: 'YTM Line 2' },
  ]

  function stubLrc(hits: unknown[]) {
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(JSON.stringify(hits), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
  }

  it('uses LRCLIB when it returns synced lyrics', async () => {
    const ytmSpy = vi.spyOn(await import('./ytmusic'), 'fetchYtmTimedLyrics')

    stubLrc([{ id: 1, trackName: 'Some Song', artistName: 'The Artist', duration: 210, syncedLyrics: '[00:01] A\n[00:05] B\n', plainLyrics: 'A\nB' }])
    const result = await fetchWebLyrics({ trackId: 't1', title: 'Some Song', artist: 'The Artist', album: '', duration: 210 })
    expect(result.source).toBe('lrclib')
    expect(result.synced).toBe(true)
    expect(ytmSpy).not.toHaveBeenCalled()
    ytmSpy.mockRestore()
  })

  it('falls back to YTM when LRCLIB returns plain-only', async () => {
    const ytmSpy = vi.spyOn(await import('./ytmusic'), 'fetchYtmTimedLyrics').mockResolvedValue({
      synced: ytmSynced,
      plain: 'YTM Line 1\nYTM Line 2',
    })

    stubLrc(plainOnly)
    const result = await fetchWebLyrics({ trackId: 't1', title: 'Some Song', artist: 'The Artist', album: '', duration: 210 })
    expect(result.source).toBe('ytmusic')
    expect(result.synced).toBe(true)
    expect(result.lines).toHaveLength(2)
    ytmSpy.mockRestore()
  })

  it('falls back to YTM when LRCLIB synced is structurally suspect (duration mismatch >5s)', async () => {
    const ytmSpy = vi.spyOn(await import('./ytmusic'), 'fetchYtmTimedLyrics').mockResolvedValue({
      synced: ytmSynced,
      plain: 'YTM Line 1\nYTM Line 2',
    })

    stubLrc([{ id: 1, trackName: 'Some Song', artistName: 'The Artist', duration: 220, syncedLyrics: '[00:01] A\n[00:05] B\n', plainLyrics: 'A\nB' }])
    const result = await fetchWebLyrics({ trackId: 't1', title: 'Some Song', artist: 'The Artist', album: '', duration: 210 })
    expect(result.source).toBe('ytmusic')
    expect(result.synced).toBe(true)
    ytmSpy.mockRestore()
  })

  it('does NOT fall back to YTM when LRCLIB synced is good (duration within 5s)', async () => {
    const ytmSpy = vi.spyOn(await import('./ytmusic'), 'fetchYtmTimedLyrics').mockResolvedValue({
      synced: ytmSynced,
      plain: 'YTM Line 1\nYTM Line 2',
    })

    stubLrc([{ id: 1, trackName: 'Some Song', artistName: 'The Artist', duration: 212, syncedLyrics: '[00:01] A\n[00:05] B\n', plainLyrics: 'A\nB' }])
    const result = await fetchWebLyrics({ trackId: 't1', title: 'Some Song', artist: 'The Artist', album: '', duration: 210 })
    expect(result.source).toBe('lrclib')
    expect(result.synced).toBe(true)
    expect(ytmSpy).not.toHaveBeenCalled()
    ytmSpy.mockRestore()
  })

  it('falls through to LRCLIB when YTM returns null', async () => {
    const ytmSpy = vi.spyOn(await import('./ytmusic'), 'fetchYtmTimedLyrics').mockResolvedValue(null)

    stubLrc(plainOnly)
    const result = await fetchWebLyrics({ trackId: 't1', title: 'Some Song', artist: 'The Artist', album: '', duration: 210 })
    expect(result.source).toBe('lrclib')
    expect(result.synced).toBe(false)
    ytmSpy.mockRestore()
  })
})