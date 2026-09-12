/**
 * Tests for the exact-video lyrics client (lib/lyricsBackend.ts).
 *
 * Only a strictly validated payload (found, matching videoId, ≥2 timed
 * lines) resolves — everything else rejects so the resolver falls back
 * to LRCLIB.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchExactVideoLyrics } from './lyricsBackend'

const VID = '1kqpUuxomK0'

function ok(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

const goodBody = {
  found: true,
  videoId: VID,
  lines: [
    { time: 35.37, text: 'Line one' },
    { time: 38.99, text: 'Line two' },
  ],
  plain: 'Line one\nLine two',
}

afterEach(() => vi.unstubAllGlobals())

describe('fetchExactVideoLyrics', () => {
  it('resolves normalized lines on a valid payload', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok(goodBody)))
    const result = await fetchExactVideoLyrics(VID)
    expect(result.lines).toHaveLength(2)
    expect(result.lines[0]).toEqual({ time: 35.37, text: 'Line one' })
    expect(result.plain).toBe('Line one\nLine two')
  })

  it('rejects on non-OK status (endpoint missing, 404, 500)', async () => {
    for (const status of [404, 500]) {
      vi.stubGlobal('fetch', vi.fn(async () => ok({ found: false }, status)))
      await expect(fetchExactVideoLyrics(VID)).rejects.toThrow()
    }
  })

  it('rejects when found is false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ found: false, videoId: VID })))
    await expect(fetchExactVideoLyrics(VID)).rejects.toThrow()
  })

  it('rejects on videoId mismatch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ ...goodBody, videoId: 'dQw4w9WgXcQ' })))
    await expect(fetchExactVideoLyrics(VID)).rejects.toThrow()
  })

  it('rejects with fewer than 2 timed lines', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ ...goodBody, lines: [{ time: 1, text: 'Only' }] })),
    )
    await expect(fetchExactVideoLyrics(VID)).rejects.toThrow()
  })

  it('rejects malformed line entries', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ok({ ...goodBody, lines: [{ time: NaN, text: 'x' }, { time: 2, text: '' }] })),
    )
    await expect(fetchExactVideoLyrics(VID)).rejects.toThrow()
  })

  it('rejects malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json{{{', { status: 200 })))
    await expect(fetchExactVideoLyrics(VID)).rejects.toThrow()
  })

  it('rejects on network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    await expect(fetchExactVideoLyrics(VID)).rejects.toThrow()
  })
})
