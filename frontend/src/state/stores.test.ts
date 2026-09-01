import { beforeEach, describe, expect, it, vi } from 'vitest'
import { setBackend, type Backend } from '../bridge/backend'
import { activeLineIndex, lyrics, useLyricsStore } from './lyricsStore'
import { search, useSearchStore } from './searchStore'
import type { Track } from '../bridge/types'

const line = (time: number, text: string) => ({ time, text })

describe('activeLineIndex', () => {
  const lines = [line(0, 'a'), line(5, 'b'), line(10, 'c'), line(15, 'd')]

  it('returns -1 before the first timestamp', () => {
    expect(activeLineIndex([line(3, 'x')], 1)).toBe(-1)
    expect(activeLineIndex([], 10)).toBe(-1)
  })

  it('tracks the player position', () => {
    expect(activeLineIndex(lines, 0)).toBe(0)
    expect(activeLineIndex(lines, 4.99)).toBe(0)
    expect(activeLineIndex(lines, 5)).toBe(1)
    expect(activeLineIndex(lines, 14.5)).toBe(2)
    expect(activeLineIndex(lines, 999)).toBe(3)
  })

  it('applies the LRC offset', () => {
    expect(activeLineIndex(lines, 4.5, 0.6)).toBe(1)
    expect(activeLineIndex(lines, 5.5, -1)).toBe(0)
  })

  it('freezes when the position stops changing (pause behaviour)', () => {
    const first = activeLineIndex(lines, 7)
    expect(activeLineIndex(lines, 7)).toBe(first)
  })
})

function track(id: string): Track {
  return {
    id, sourceId: id, source: 'youtube', url: '', title: 'T', artist: 'A', album: '',
    artwork: '', duration: 100, explicit: false,
  }
}

function stubBackend(overrides: Partial<Backend>): Backend {
  const be = {
    isNative: false,
    getLyrics: vi.fn(),
    search: vi.fn(),
    addSearchTerm: vi.fn(async () => []),
    on: vi.fn(() => () => {}),
  } as unknown as Backend
  Object.assign(be, overrides)
  setBackend(be)
  return be
}

describe('lyricsStore', () => {
  beforeEach(() => {
    useLyricsStore.setState({ trackId: null, status: 'idle', result: null, error: null })
  })

  it('reports empty rather than an error when nothing is found', async () => {
    stubBackend({ getLyrics: vi.fn().mockRejectedValue(new Error('no lyrics found')) })
    lyrics.loadFor(track('a'), () => true)
    await vi.waitFor(() => expect(useLyricsStore.getState().status).toBe('empty'))
    expect(useLyricsStore.getState().error).toBeNull()
  })

  it('reports provider failures as errors', async () => {
    stubBackend({ getLyrics: vi.fn().mockRejectedValue(new Error('couldn’t reach the lyrics service')) })
    lyrics.loadFor(track('a'), () => true)
    await vi.waitFor(() => expect(useLyricsStore.getState().status).toBe('error'))
    expect(useLyricsStore.getState().error).toMatch(/lyrics service/)
  })

  it('discards results for a track that is no longer current', async () => {
    stubBackend({
      getLyrics: vi.fn(async () => ({
        trackId: 'a', source: 'lrclib', synced: true, lines: [line(0, 'stale')], plain: '',
        instrumental: false, offset: 0, matchedTitle: '', matchedArtist: '',
      })),
    })
    lyrics.loadFor(track('a'), () => false)
    await new Promise((r) => setTimeout(r, 20))
    expect(useLyricsStore.getState().result).toBeNull()
    expect(useLyricsStore.getState().status).toBe('loading')
  })

  it('clear wipes the pane immediately', () => {
    useLyricsStore.setState({ trackId: 'a', status: 'ready', result: null, error: null })
    lyrics.clear()
    expect(useLyricsStore.getState().status).toBe('idle')
    expect(useLyricsStore.getState().trackId).toBeNull()
  })
})

describe('searchStore', () => {
  beforeEach(() => {
    useSearchStore.setState({ query: '', submitted: '', filter: '', status: 'idle', results: null, error: null })
  })

  it('moves through loading → results', async () => {
    stubBackend({
      search: vi.fn(async () => ({ query: 'x', songs: [track('a')], videos: [], albums: [], artists: [], provider: 'ytmusic' })),
      addSearchTerm: vi.fn(async () => ['x']),
    })
    const p = search.run('x')
    expect(useSearchStore.getState().status).toBe('loading')
    await p
    expect(useSearchStore.getState().status).toBe('results')
  })

  it('reports an empty result set distinctly from an error', async () => {
    stubBackend({ search: vi.fn(async () => ({ query: 'x', songs: [], videos: [], albums: [], artists: [], provider: 'ytmusic' })) })
    await search.run('x')
    expect(useSearchStore.getState().status).toBe('empty')
  })

  it('surfaces provider errors with a retry path', async () => {
    const be = stubBackend({ search: vi.fn().mockRejectedValue(new Error('couldn’t reach YouTube')) })
    await search.run('x')
    expect(useSearchStore.getState().status).toBe('error')
    expect(useSearchStore.getState().error).toMatch(/YouTube/)
    search.retry()
    expect(be.search).toHaveBeenCalledTimes(2)
  })

  it('ignores a slow response for a superseded query', async () => {
    const slow = { query: 'slow', songs: [track('slow')], videos: [], albums: [], artists: [], provider: 'ytmusic' }
    const fast = { query: 'fast', songs: [track('fast')], videos: [], albums: [], artists: [], provider: 'ytmusic' }
    stubBackend({
      search: vi.fn(async (q: string) => {
        if (q === 'slow') {
          await new Promise((r) => setTimeout(r, 60))
          return slow
        }
        return fast
      }),
      addSearchTerm: vi.fn(async () => []),
    })
    const first = search.run('slow')
    await search.run('fast')
    await first
    expect(useSearchStore.getState().submitted).toBe('fast')
    expect(useSearchStore.getState().results?.songs[0].id).toBe('fast')
  })
})
