/**
 * Resolver order for web lyrics (bridge/webBackend.getLyrics):
 *
 *   exact-video YTM (/api/lyrics) → LRCLIB metadata match → no lyrics
 *
 * The endpoint is tried first when the query carries a videoId; any
 * failure (or absence) falls back to the existing LRCLIB path, which
 * keeps its recording-aware matching and per-track drift behavior.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWebBackend } from './webBackend'
import type { LyricsQuery } from './types'

const VID = '1kqpUuxomK0'

const query = (over: Partial<LyricsQuery> = {}): LyricsQuery => ({
  trackId: 'yt:test',
  title: 'Some Song',
  artist: 'The Artist',
  album: '',
  duration: 210,
  ...over,
})

const lrcSynced = [
  {
    id: 7,
    trackName: 'Some Song',
    artistName: 'The Artist',
    duration: 210,
    syncedLyrics: '[00:01] A\n[00:05] B\n',
    plainLyrics: 'A\nB',
  },
]

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => handler(String(input))),
  )
}

const apiFound = () =>
  new Response(
    JSON.stringify({
      found: true,
      videoId: VID,
      lines: [
        { time: 35.37, text: 'Exact line one' },
        { time: 38.99, text: 'Exact line two' },
      ],
      plain: 'Exact line one\nExact line two',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )

afterEach(() => vi.unstubAllGlobals())

describe('webBackend.getLyrics resolver order', () => {
  it('uses exact-video YTM first and never touches LRCLIB', async () => {
    const lrcSpy = vi.fn(async (_url: string) => new Response('[]', { status: 500 }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.startsWith('/api/lyrics')) return apiFound()
        return lrcSpy(url)
      }),
    )
    const be = createWebBackend()
    const result = await be.getLyrics(query({ videoId: VID }))
    expect(result.source).toBe('ytmusic')
    expect(result.synced).toBe(true)
    expect(result.lines.map((l) => l.text)).toEqual(['Exact line one', 'Exact line two'])
    expect(result.offset).toBe(0)
    expect(lrcSpy).not.toHaveBeenCalled()
  })

  it('falls back to LRCLIB when the endpoint has no lyrics', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/lyrics')) {
        return new Response(JSON.stringify({ found: false, videoId: VID }), { status: 404 })
      }
      return new Response(JSON.stringify(lrcSynced), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const be = createWebBackend()
    const result = await be.getLyrics(query({ videoId: VID }))
    expect(result.source).toBe('lrclib')
    expect(result.synced).toBe(true)
  })

  it('falls back to LRCLIB when the endpoint is unreachable', async () => {
    stubFetch((url) => {
      if (url.startsWith('/api/lyrics')) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify(lrcSynced), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const be = createWebBackend()
    const result = await be.getLyrics(query({ videoId: VID }))
    expect(result.source).toBe('lrclib')
  })

  it('uses LRCLIB directly when the query has no videoId', async () => {
    const apiSpy = vi.fn()
    stubFetch((url) => {
      if (url.startsWith('/api/lyrics')) {
        apiSpy(url)
        return new Response('{}', { status: 500 })
      }
      return new Response(JSON.stringify(lrcSynced), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    const be = createWebBackend()
    const result = await be.getLyrics(query())
    expect(result.source).toBe('lrclib')
    expect(apiSpy).not.toHaveBeenCalled()
  })
})
