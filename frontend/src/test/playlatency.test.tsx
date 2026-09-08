/**
 * Click-to-play latency tests: the search-result click path must go straight
 * to source resolution with the canonical provider ID (never a second text
 * search), the handoff to the audio element must be exact, resolver failures
 * must surface and retry cleanly, and the [play-latency] instrumentation must
 * emit the full ordered timeline when enabled.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from '../App'
import { setBackend, type Backend } from '../bridge/backend'
import type { PlayableSource, SearchResponse, Track } from '../bridge/types'
import { defaultSettings } from '../lib/defaults'
import { useLibraryStore } from '../state/libraryStore'
import { playback } from '../state/playback'
import { usePlayerStore } from '../state/playerStore'
import { positionChannel } from '../state/positionChannel'
import { useUIStore } from '../state/uiStore'

function song(id: string, title: string): Track {
  return {
    id: `yt:${id}`, sourceId: id, source: 'youtube', url: '', title, artist: 'Ed Sheeran',
    album: '÷', artwork: `http://img/${id}.jpg`, duration: 263, explicit: false,
  }
}

const a = song('abc123', 'Perfect')
const b = song('def456', 'Perfect (Acoustic)')

let getPlayableImpl: (t: Track) => Promise<PlayableSource>

function stubBackend() {
  const be = {
    isNative: false,
    getState: vi.fn(async () => ({
      settings: defaultSettings(), liked: [], playlists: [], history: [], searchHistory: [], session: null, version: 1,
    })),
    getDiagnostics: vi.fn(async () => ({ appVersion: '0.0.0', goVersion: 'go1.21', platform: 'linux', dataDir: '/tmp', streamProxy: 'off', resolver: { installed: false, path: '', version: '', message: '' }, resolverBinary: '', mediaKeys: 'off', tray: 'on' })),
    search: vi.fn(async (): Promise<SearchResponse> => ({ query: 'perfect', songs: [a, b], videos: [], albums: [], artists: [], provider: 'ytmusic' })),
    relatedTracks: vi.fn(async () => ({ tracks: [], source: 'ytmusic-next' })),
    logRadio: vi.fn(async () => {}),
    getPlayable: vi.fn(async (t: Track): Promise<PlayableSource> => getPlayableImpl(t)),
    getLyrics: vi.fn(async (q: { trackId: string }) => ({
      trackId: q.trackId, source: 'lrclib', synced: false, lines: [], plain: '', instrumental: false, offset: 0, matchedTitle: '', matchedArtist: '',
    })),
    saveSettings: vi.fn(async (s) => s),
    setLiked: vi.fn(async () => []),
    setDisliked: vi.fn(async () => ({ history: [], stats: {}, disliked: [] })),
    recordPlay: vi.fn(async () => []),
    recordPlayEvent: vi.fn(async () => ({ history: [], stats: {}, disliked: [] })),
    clearHistory: vi.fn(async () => {}),
    addSearchTerm: vi.fn(async () => []), removeSearchTerm: vi.fn(async () => []),
    clearSearchHistory: vi.fn(async () => {}), libraryTracks: vi.fn(async () => []),
    saveSession: vi.fn(async () => {}), clearSession: vi.fn(async () => {}),
    createPlaylist: vi.fn(), renamePlaylist: vi.fn(), deletePlaylist: vi.fn(async () => {}),
    addTracksToPlaylist: vi.fn(), removeTrackFromPlaylist: vi.fn(), reorderPlaylist: vi.fn(), duplicatePlaylist: vi.fn(),
    installResolver: vi.fn(), setNowPlaying: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
  } as unknown as Backend
  setBackend(be)
  return be
}

async function searchAndClickFirst() {
  await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'perfect{enter}')
  await waitFor(() => expect(screen.getByText('Perfect')).toBeInTheDocument())
  fireEvent.click(screen.getByText('Perfect'))
  await waitFor(() => expect(usePlayerStore.getState().status).toBe('playing'))
}

beforeEach(() => {
  stubBackend()
  getPlayableImpl = async (t) => ({
    trackId: t.id, url: `http://127.0.0.1:52134/stream/token/${t.sourceId}`, mimeType: 'audio/mp4', duration: 263, bitrate: 128, expiresAt: 0,
  })
  localStorage.removeItem('melo:play-latency')
  useLibraryStore.setState({
    ready: true, loadError: null, settings: defaultSettings(), liked: [], disliked: [],
    playlists: [], history: [], stats: {}, searchHistory: [],
  })
  usePlayerStore.setState({
    queue: [], autoQueue: [], index: -1, current: null, status: 'idle', error: null,
    shuffle: false, repeat: 'off', volume: 1, muted: false, speed: 1, sleepTimer: null,
    playingFrom: 'queue', contextLabel: '', radioSource: '',
  })
  useUIStore.setState({ route: { name: 'home' }, history: [], future: [], queueOpen: false, nowPlayingOpen: false, lyricsOpen: false, toasts: [], resolverError: null, resolverProgress: null })
  positionChannel.reset()
})

afterEach(() => {
  // The playback controller is a module singleton: stop() clears its pending
  // prefetch debounce, in-flight set, and prefetched-source cache so no state
  // leaks between tests (a stale cached N+1 would fake a reuse pass).
  playback.stop()
  cleanup()
  vi.restoreAllMocks()
  localStorage.removeItem('melo:play-latency')
})

describe('click-to-play path', () => {
  it('resolves the canonical provider ID directly — the click never triggers a second search', async () => {
    const be = stubBackend()
    render(<App />)
    await searchAndClickFirst()
    // One search: the user's query. The click must not re-search by title.
    expect(be.search).toHaveBeenCalledTimes(1)
    // Direct-ID resolution: exactly the clicked result's ID, no siblings.
    expect(be.getPlayable).toHaveBeenCalledTimes(1)
    const arg = (be.getPlayable as ReturnType<typeof vi.fn>).mock.calls[0][0] as Track
    expect(arg.id).toBe('yt:abc123')
    expect(arg.sourceId).toBe('abc123')
    // The chosen song only — never the acoustic sibling.
    expect(usePlayerStore.getState().queue.map((t) => t.id)).toEqual(['yt:abc123'])
  })

  it('hands the resolved source to the audio element exactly once', async () => {
    render(<App />)
    await searchAndClickFirst()
    const el = playback.engine.el
    expect(el.getAttribute('src')).toBe('http://127.0.0.1:52134/stream/token/abc123')
    expect(usePlayerStore.getState().current?.id).toBe('yt:abc123')
    // The resolved source's duration fed the scrubber before the element's own
    // loadedmetadata took over (jsdom's media shim reports a fixed 120s).
    expect(positionChannel.getDuration()).toBeGreaterThan(0)
  })

  it('replaying the same video keeps the canonical ID (resolver cache layer serves the repeat)', async () => {
    const be = stubBackend()
    render(<App />)
    await searchAndClickFirst()
    // A second explicit play of the same track resolves the SAME id again —
    // in the real app the Go resolver's TTL cache answers this instantly.
    await playback.play(a)
    await waitFor(() => expect(be.getPlayable).toHaveBeenCalledTimes(2))
    const second = (be.getPlayable as ReturnType<typeof vi.fn>).mock.calls[1][0] as Track
    expect(second.sourceId).toBe('abc123')
    expect(be.search).toHaveBeenCalledTimes(1) // still no re-search
  })

  it('surfaces resolver failures and recovers on retry', async () => {
    const be = stubBackend()
    let fail = true
    getPlayableImpl = async (t) => {
      if (fail) {
        fail = false
        throw new Error('couldn’t reach YouTube: connection reset')
      }
      return { trackId: t.id, url: `http://127.0.0.1:52134/stream/token/${t.sourceId}`, mimeType: 'audio/mp4', duration: 263, bitrate: 128, expiresAt: 0 }
    }
    render(<App />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'perfect{enter}')
    await waitFor(() => expect(screen.getByText('Perfect')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Perfect'))
    await waitFor(() => expect(usePlayerStore.getState().status).toBe('error'))
    expect(usePlayerStore.getState().error).toContain('YouTube')
    // Retry: the same canonical ID resolves and playback starts.
    await playback.play(a)
    await waitFor(() => expect(usePlayerStore.getState().status).toBe('playing'))
    expect(be.getPlayable).toHaveBeenCalledTimes(2)
    const ids = (be.getPlayable as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as Track).sourceId)
    expect(ids).toEqual(['abc123', 'abc123'])
  })
})

describe('[play-latency] instrumentation', () => {
  it('emits the full ordered timeline when enabled, and nothing when disabled', async () => {
    localStorage.setItem('melo:play-latency', '1')
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    render(<App />)
    await searchAndClickFirst()

    const lines = debugSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[play-latency]'))
    const stages = lines.map((l) => /^\[play-latency\] ([A-Z_]+)/.exec(l)?.[1] ?? '')

    // Every stage of the click → first-audio path, in order.
    const order = ['CLICK', 'PLAY_REQUEST', 'RESOLVE_START', 'RESOLVE_END', 'SRC_SET', 'PLAY_CALL', 'FIRST_PLAYING', 'TOTAL']
    let last = -1
    for (const stage of order) {
      const idx = stages.indexOf(stage)
      expect(idx, `missing stage ${stage} in ${JSON.stringify(stages)}`).toBeGreaterThan(-1)
      expect(idx).toBeGreaterThan(last)
      last = idx
    }
    // The TOTAL line carries the breakdown numbers.
    const total = lines.find((l) => l.includes('TOTAL'))
    expect(total).toMatch(/total=\d+ms resolve=\d+ms handoff=\d+ms/)

    // Disabled flag ⇒ zero noise on a subsequent play.
    debugSpy.mockClear()
    localStorage.removeItem('melo:play-latency')
    await playback.play(b)
    await waitFor(() => expect(usePlayerStore.getState().current?.id).toBe('yt:def456'))
    const noise = debugSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[play-latency]'))
    expect(noise).toEqual([])
  })
})

/**
 * Next-track prefetch path (queue advance latency): while track N plays, the
 * controller resolves the stream URL of the immediate next track in the
 * background. The N → N+1 transition must reuse that prefetched source and
 * NEVER re-invoke the resolver; a prefetch in flight must not be duplicated;
 * a failed prefetch must never break the real transition; and an unsettled
 * prefetch must never block an immediate skip.
 */
const callsFor = (be: Backend, sourceId: string) =>
  (be.getPlayable as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => (c[0] as Track).sourceId === sourceId).length

async function playAWithBNext() {
  render(<App />)
  await searchAndClickFirst() // a playing, queue [a]
  usePlayerStore.setState({ queue: [a, b] })
  await waitFor(() => expect(usePlayerStore.getState().status).toBe('playing'))
}

describe('next-track prefetch path', () => {

  it('reuses the prefetched source on advance — the N→N+1 transition never re-invokes the resolver', async () => {
    const be = stubBackend()
    localStorage.setItem('melo:play-latency', '1')
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    await playAWithBNext()

    // The debounced background prefetch (1.5s) resolves b while a keeps playing.
    await waitFor(() => expect(callsFor(be, 'def456')).toBe(1), { timeout: 5000 })
    expect(usePlayerStore.getState().current?.id).toBe('yt:abc123') // a undisturbed
    expect(usePlayerStore.getState().status).toBe('playing')

    // Natural end of a: b must start from the prefetched source.
    act(() => {
      playback.engine.el.dispatchEvent(new Event('ended'))
    })
    await waitFor(() => expect(usePlayerStore.getState().current?.id).toBe('yt:def456'))
    await waitFor(() => expect(usePlayerStore.getState().status).toBe('playing'))
    expect(playback.engine.el.getAttribute('src')).toBe('http://127.0.0.1:52134/stream/token/def456')

    // THE regression assertion: a + one prefetch = two resolver invocations
    // total. A third call would mean the cached N+1 transition went back to
    // the resolver (the slow next-track path this prefetch exists to remove).
    expect(be.getPlayable).toHaveBeenCalledTimes(2)

    // And the instrumentation names the shortcut: the transition's resolve
    // came from the prefetch cache, at zero cost.
    const reused = debugSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes('cache=prefetch'))
    expect(reused).toMatch(/RESOLVE_END.*cache=prefetch/)
  }, 15000)

  it('never duplicates the prefetch while one is already in flight', async () => {
    const be = stubBackend()
    let releaseB: (s: PlayableSource) => void = () => {}
    getPlayableImpl = (t) =>
      t.sourceId === 'def456'
        ? new Promise<PlayableSource>((resolve) => {
            releaseB = (s) => resolve(s)
          })
        : Promise.resolve({
            trackId: t.id, url: `http://127.0.0.1:52134/stream/token/${t.sourceId}`, mimeType: 'audio/mp4',
            duration: 263, bitrate: 128, expiresAt: 0,
          })
    await playAWithBNext()

    // Wait for the prefetch to actually be in flight.
    await waitFor(() => expect(callsFor(be, 'def456')).toBe(1), { timeout: 5000 })

    // Re-entering the playing state (pause/resume, progress ticks, any state
    // re-emission re-arms the debounce) must not issue a second resolve for b.
    act(() => {
      playback.engine.el.dispatchEvent(new Event('playing'))
    })
    await new Promise((r) => setTimeout(r, 2200))
    expect(callsFor(be, 'def456')).toBe(1)

    // The in-flight background work never disturbed the audible track.
    expect(usePlayerStore.getState().current?.id).toBe('yt:abc123')
    expect(usePlayerStore.getState().status).toBe('playing')

    // Let the pending promise settle so no state leaks between tests.
    releaseB({
      trackId: b.id, url: 'http://127.0.0.1:52134/stream/token/def456', mimeType: 'audio/mp4',
      duration: 263, bitrate: 128, expiresAt: 0,
    })
    await new Promise((r) => setTimeout(r, 0))
  }, 15000)

  it('a failed prefetch stays silent and the real transition resolves fresh', async () => {
    const be = stubBackend()
    let failPrefetch = true
    getPlayableImpl = async (t) => {
      if (t.sourceId === 'def456' && failPrefetch) {
        failPrefetch = false
        throw new Error('offline blip during prefetch')
      }
      return {
        trackId: t.id, url: `http://127.0.0.1:52134/stream/token/${t.sourceId}`, mimeType: 'audio/mp4',
        duration: 263, bitrate: 128, expiresAt: 0,
      }
    }
    await playAWithBNext()

    // The prefetch for b fails silently…
    await waitFor(() => expect(callsFor(be, 'def456')).toBe(1), { timeout: 5000 })
    expect(usePlayerStore.getState().status).toBe('playing') // …and playback never noticed.

    // …so the natural transition resolves b for real and plays it.
    act(() => {
      playback.engine.el.dispatchEvent(new Event('ended'))
    })
    await waitFor(() => expect(usePlayerStore.getState().current?.id).toBe('yt:def456'))
    await waitFor(() => expect(usePlayerStore.getState().status).toBe('playing'))
    expect(playback.engine.el.getAttribute('src')).toBe('http://127.0.0.1:52134/stream/token/def456')
    expect(usePlayerStore.getState().error).toBeNull() // the failure was invisible
    expect(be.getPlayable).toHaveBeenCalledTimes(3) // a, failed prefetch, real resolve
  }, 15000)

  it('an unsettled prefetch never blocks an immediate skip', async () => {
    const be = stubBackend()
    // The background prefetch for b never settles; b's OWN resolve (issued by
    // start() on the skip) answers immediately. If start() ever awaited the
    // prefetch promise instead of issuing its own request, b could never
    // start here. (In the real app the Go resolver dedupes concurrent
    // requests for the same id, so the second call shares work, not fate.)
    let prefetchStarted = false
    getPlayableImpl = (t) => {
      if (t.sourceId === 'def456' && !prefetchStarted) {
        prefetchStarted = true
        return new Promise<PlayableSource>(() => {}) // prefetch never settles
      }
      return Promise.resolve({
        trackId: t.id, url: `http://127.0.0.1:52134/stream/token/${t.sourceId}`, mimeType: 'audio/mp4',
        duration: 263, bitrate: 128, expiresAt: 0,
      })
    }
    await playAWithBNext()
    await waitFor(() => expect(callsFor(be, 'def456')).toBe(1), { timeout: 5000 })

    // The user hits Next while the prefetch is still hanging: start() must
    // resolve b itself instead of waiting on the background promise.
    await playback.next()
    await waitFor(() => expect(usePlayerStore.getState().current?.id).toBe('yt:def456'))
    await waitFor(() => expect(usePlayerStore.getState().status).toBe('playing'))
    expect(playback.engine.el.getAttribute('src')).toBe('http://127.0.0.1:52134/stream/token/def456')
    expect(callsFor(be, 'def456')).toBe(2) // the hanging prefetch + its own resolve
  }, 15000)
})

/**
 * Loading stages (UI feedback contract): a fresh resolve must announce itself
 * as Resolving (the stage that can take seconds), the element's own waits are
 * Buffering, a prepared (prefetched) transition must NEVER claim resolving,
 * and every stage clears once playback actually starts. No blocking
 * full-screen state exists — these are inline labels only.
 */
describe('loading stages', () => {
  it('a fresh resolve reports resolving — visibly — until the source arrives, then clears', async () => {
    let release!: (s: PlayableSource) => void
    getPlayableImpl = () =>
      new Promise<PlayableSource>((resolve) => {
        release = (s) => resolve(s)
      })
    render(<App />)
    await userEvent.type(screen.getByRole('textbox', { name: 'Search' }), 'perfect{enter}')
    await waitFor(() => expect(screen.getByText('Perfect')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Perfect'))

    await waitFor(() => expect(usePlayerStore.getState().status).toBe('loading'))
    expect(usePlayerStore.getState().loadStage).toBe('resolving')
    // The mini player says what it is actually doing — no frozen look.
    expect(screen.getByText('Resolving…')).toBeInTheDocument()

    release({
      trackId: a.id, url: 'http://127.0.0.1:52134/stream/token/abc123', mimeType: 'audio/mp4',
      duration: 263, bitrate: 128, expiresAt: 0,
    })
    await waitFor(() => expect(usePlayerStore.getState().status).toBe('playing'))
    expect(usePlayerStore.getState().loadStage).toBeNull()
  })

  it('a prepared (prefetched) transition goes straight to buffering — it never claims resolving', async () => {
    const be = stubBackend()
    await playAWithBNext()
    await waitFor(() => expect(callsFor(be, 'def456')).toBe(1), { timeout: 5000 })

    // Record every loadStage the store passes through during the transition.
    // (jsdom's play() fires 'playing' synchronously, so the final state can
    // already be playing when dispatch returns — the recorded SEQUENCE is the
    // deterministic proof.)
    const stages: Array<string | null> = []
    const unsubscribe = usePlayerStore.subscribe((state) => stages.push(state.loadStage))
    act(() => {
      playback.engine.el.dispatchEvent(new Event('ended'))
    })
    await waitFor(() => expect(usePlayerStore.getState().status).toBe('playing'))
    unsubscribe()
    // A prepared load knows its source: it may pass through buffering (the
    // element fetching data) but must NEVER claim resolving — that would be a
    // fake loading state on a transition where no resolver work happens.
    expect(stages).not.toContain('resolving')
    expect(stages).toContain('buffering')
    expect(usePlayerStore.getState().loadStage).toBeNull()
  }, 15000)

  it('a mid-track rebuffer reports buffering, and clears when playback resumes', async () => {
    render(<App />)
    await searchAndClickFirst()
    expect(usePlayerStore.getState().status).toBe('playing')

    // The element stalls mid-track (network hiccup): the engine re-enters
    // loading — that is the element's wait, never a resolver round trip.
    act(() => {
      playback.engine.el.dispatchEvent(new Event('waiting'))
    })
    expect(usePlayerStore.getState().status).toBe('loading')
    expect(usePlayerStore.getState().loadStage).toBe('buffering')

    act(() => {
      playback.engine.el.dispatchEvent(new Event('playing'))
    })
    expect(usePlayerStore.getState().status).toBe('playing')
    expect(usePlayerStore.getState().loadStage).toBeNull()
  })
})
