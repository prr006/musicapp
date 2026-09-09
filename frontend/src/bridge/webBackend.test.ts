import { APIError } from './apiClient'
import { createWebBackend } from './webBackend'
import { defaultSettings } from '../lib/defaults'
import type { AppState, Track } from './types'

function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body === undefined ? '' : JSON.stringify(body),
  } as Response
}

const track: Track = {
  id: 'yt:abcdefghijk', sourceId: 'abcdefghijk', source: 'youtube',
  url: 'https://youtube.com/watch?v=abcdefghijk', title: 'Song', artist: 'Artist',
  album: '', artwork: '', duration: 180, explicit: false,
}

describe('WebBackend', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('loads typed state over credentialed HTTP', async () => {
    const state: AppState = {
      settings: defaultSettings(), liked: [], playlists: [], history: [],
      searchHistory: [], session: null, version: 1,
    }
    const fetchMock = vi.fn().mockResolvedValue(response(200, state))
    vi.stubGlobal('fetch', fetchMock)
    await expect(createWebBackend('/api/v1').getState()).resolves.toEqual(state)
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/state', expect.objectContaining({ credentials: 'include' }))
  })

  it('coalesces duplicate resolution and expands the signed stream URL', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, {
      trackId: track.id, url: '/api/v1/stream/abcdefghijk?expires=1&signature=x',
      mimeType: 'audio/mp4', duration: 180, bitrate: 128, expiresAt: Date.now() + 60_000,
    }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createWebBackend('/api/v1')
    const [first, second] = await Promise.all([backend.getPlayable(track), backend.getPlayable(track)])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(first.url).toMatch(/^http:\/\/localhost:\d+\/api\/v1\/stream\//)
  })

  it('surfaces stable API errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(429, {
      error: { code: 'rate_limited', message: 'too many requests' },
    })))
    const error = await createWebBackend('/api/v1').search('song', '').catch((value) => value)
    expect(error).toBeInstanceOf(APIError)
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', message: 'too many requests' })
  })

  it('bounds a stalled API request instead of buffering indefinitely', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    })))

    const request = createWebBackend('/api/v1').getPlayable(track)
    const rejected = expect(request).rejects.toMatchObject({ code: 'request_timeout' })
    await vi.advanceTimersByTimeAsync(60_000)
    await rejected
  })

  it('uses a radio endpoint without leaking provider logic into playback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200, {
      id: 'radio_1', kind: 'song', seedId: track.sourceId, tracks: [track], generatedAt: 1,
    }))
    vi.stubGlobal('fetch', fetchMock)
    const backend = createWebBackend('/api/v1')
    await backend.radio?.('song', track.sourceId, track)
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('/radio/song/abcdefghijk?')
    expect(url).toContain('artist=Artist')
  })
})
