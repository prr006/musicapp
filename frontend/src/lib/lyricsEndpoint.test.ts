/**
 * Tests for the MELO lyrics backend (api/lyrics.ts, imported relatively).
 *
 * Exact videoId validation, normalized LyricLine shape (never raw YTM),
 * bounded positive + negative caching, and graceful failure on
 * timeout/403/malformed upstream data.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import handler, { __resetLyricsCache, normalizeTimedLines } from '../../../api/lyrics'

function req(url: string): any {
  return { url, method: 'GET' }
}

function res(): any {
  const r: any = { statusCode: 0, headers: {} as Record<string, string>, body: '' }
  r.status = (code: number) => {
    r.statusCode = code
    return r
  }
  r.json = (obj: unknown) => {
    r.body = JSON.stringify(obj)
    return r
  }
  r.send = (s: string) => {
    r.body = s
    return r
  }
  r.setHeader = (k: string, v: string) => {
    r.headers[k] = v
  }
  return r
}

const VID = '1kqpUuxomK0'

function stubUpstream(nextJson: unknown, browseJson: unknown, opts: { nextOk?: boolean; browseOk?: boolean } = {}) {
  const { nextOk = true, browseOk = true } = opts
  return vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL) => {
      const text = String(url)
      if (text.includes('/next')) {
        if (!nextOk) return new Response('forbidden', { status: 403 })
        return new Response(JSON.stringify(nextJson), { status: 200 })
      }
      if (!browseOk) return new Response('forbidden', { status: 403 })
      return new Response(JSON.stringify(browseJson), { status: 200 })
    }),
  )
}

const nextWithLyrics = {
  tabs: [
    { browseEndpoint: { browseId: 'MPLYt_test', browseEndpointContextMusicConfig: { pageType: 'MUSIC_PAGE_TYPE_TRACK_LYRICS' } } },
  ],
}
const browseWithLines = {
  timedLyricsModel: {
    lyricsData: {
      timedLyricsData: [
        { cueRange: { startTimeMilliseconds: 35370 }, lyricLine: 'Line one' },
        { cueRange: { startTimeMilliseconds: 38990 }, lyricLine: 'Line two' },
      ],
    },
  },
}

beforeEach(() => {
  __resetLyricsCache()
  vi.unstubAllGlobals()
})

describe('GET /api/lyrics', () => {
  it('rejects an invalid videoId without calling upstream', async () => {
    const spy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', spy)
    const r = res()
    await handler(req('/api/lyrics?videoId=not-an-id'), r)
    expect(r.statusCode).toBe(400)
    expect(JSON.parse(r.body).found).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns normalized lines and never the raw YTM payload', async () => {
    stubUpstream(nextWithLyrics, browseWithLines)
    const r = res()
    await handler(req(`/api/lyrics?videoId=${VID}`), r)
    expect(r.statusCode).toBe(200)
    const body = JSON.parse(r.body)
    expect(body.found).toBe(true)
    expect(body.videoId).toBe(VID)
    expect(body.lines).toEqual([
      { time: 35.37, text: 'Line one' },
      { time: 38.99, text: 'Line two' },
    ])
    expect(body.plain).toBe('Line one\nLine two')
    expect(r.body).not.toContain('timedLyricsModel')
    expect(r.body).not.toContain('cueRange')
    expect(r.body).not.toContain('browseEndpoint')
  })

  it('caches positives: the second call performs no upstream fetch', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        calls++
        const text = String(url)
        return new Response(JSON.stringify(text.includes('/next') ? nextWithLyrics : browseWithLines), { status: 200 })
      }),
    )
    const r1 = res()
    await handler(req(`/api/lyrics?videoId=${VID}`), r1)
    expect(r1.statusCode).toBe(200)
    expect(r1.headers['X-Cache']).toBe('MISS')
    const afterFirst = calls
    expect(afterFirst).toBeGreaterThan(0)
    const r2 = res()
    await handler(req(`/api/lyrics?videoId=${VID}`), r2)
    expect(r2.statusCode).toBe(200)
    expect(r2.headers['X-Cache']).toBe('HIT')
    expect(calls).toBe(afterFirst)
  })

  it('caches negatives: 404 without timed lyrics, then HIT', async () => {
    stubUpstream({ tabs: [] }, {})
    const r1 = res()
    await handler(req(`/api/lyrics?videoId=${VID}`), r1)
    expect(r1.statusCode).toBe(404)
    expect(JSON.parse(r1.body)).toEqual({ found: false, videoId: VID })
    const r2 = res()
    await handler(req(`/api/lyrics?videoId=${VID}`), r2)
    expect(r2.statusCode).toBe(404)
    expect(r2.headers['X-Cache']).toBe('HIT')
  })

  it('fails gracefully on upstream 403', async () => {
    stubUpstream(nextWithLyrics, browseWithLines, { nextOk: false, browseOk: false })
    const r = res()
    await handler(req(`/api/lyrics?videoId=${VID}`), r)
    expect(r.statusCode).toBe(404)
    expect(JSON.parse(r.body).found).toBe(false)
  })

  it('fails gracefully on malformed upstream JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('this is not json{{{', { status: 200 })))
    const r = res()
    await handler(req(`/api/lyrics?videoId=${VID}`), r)
    expect(r.statusCode).toBe(404)
  })

  it('fails gracefully when upstream throws (network down)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const r = res()
    await handler(req(`/api/lyrics?videoId=${VID}`), r)
    expect(r.statusCode).toBe(404)
  })
})

describe('normalizeTimedLines', () => {
  it('drops empty, negative and non-finite entries and sorts', () => {
    const out = normalizeTimedLines({
      timedLyricsModel: {
        lyricsData: {
          timedLyricsData: [
            { cueRange: { startTimeMilliseconds: 9000 }, lyricLine: 'B' },
            { cueRange: { startTimeMilliseconds: 1000 }, lyricLine: '  ' },
            { cueRange: { startTimeMilliseconds: -5 }, lyricLine: 'neg' },
            { cueRange: {}, lyricLine: 'nan' },
            { cueRange: { startTimeMilliseconds: 3000 }, lyricLine: 'A' },
          ],
        },
      },
    })
    expect(out).toEqual([
      { time: 3, text: 'A' },
      { time: 9, text: 'B' },
    ])
  })
})
