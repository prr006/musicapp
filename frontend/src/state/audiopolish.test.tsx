/**
 * Audio & playback quality-of-life tests: sleep timer, persistent playback
 * speed, next-track pre-resolution, and the honest capability surface for
 * gapless/crossfade/normalization. Everything drives a real PlaybackController
 * wired to a real PlaybackEngine over the FakeMedia element — no re-stubbed
 * player logic. Test names map to the milestone spec (Sleep 1–8, Speed 9–14,
 * Transition 15–17, Crossfade/Normalization 18–22); regressions 23–28 are the
 * pre-existing suites, which must keep passing unchanged alongside this file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PlaybackEngine } from '../audio/engine'
import { setBackend, type Backend } from '../bridge/backend'
import type { PlayableSource, Track } from '../bridge/types'
import { AUDIO_CAPABILITIES } from '../lib/audioCapabilities'
import { defaultSettings } from '../lib/defaults'
import { NowPlaying } from '../components/NowPlaying'
import { PlaybackController, playback } from './playback'
import { useLibraryStore } from './libraryStore'
import { useLyricsStore } from './lyricsStore'
import { usePlayerStore } from './playerStore'
import { positionChannel } from './positionChannel'
import { timerChannel } from './timerChannel'
import { ui, useUIStore } from './uiStore'
import { FakeMedia } from '../test/fakeMedia'

function track(id: string, extra: Partial<Track> = {}): Track {
  return {
    id: `yt:${id}`,
    sourceId: id,
    source: 'youtube',
    url: `https://youtube.com/watch?v=${id}`,
    title: `Song ${id.toUpperCase()}`,
    artist: 'Artist',
    album: 'Album',
    artwork: `http://img/${id}.jpg`,
    duration: 100,
    explicit: false,
    ...extra,
  }
}

interface Harness {
  media: FakeMedia
  controller: PlaybackController
  backend: {
    getPlayable: ReturnType<typeof vi.fn>
    relatedTracks: ReturnType<typeof vi.fn>
    saveSettings: ReturnType<typeof vi.fn>
    recordPlayEvent: ReturnType<typeof vi.fn>
  }
  recorded: { track: Track; event: string }[]
}

function harness(related: Track[] = []): Harness {
  const media = new FakeMedia()
  const engine = new PlaybackEngine(media.asElement())
  const recorded: { track: Track; event: string }[] = []
  const be = {
    isNative: false,
    getState: vi.fn(),
    getDiagnostics: vi.fn(),
    search: vi.fn(async () => ({ query: '', songs: [], videos: [], albums: [], artists: [], provider: 'test' })),
    getPlayable: vi.fn(async (t: Track): Promise<PlayableSource> => ({
      trackId: t.id, url: `http://local/${t.sourceId}`, mimeType: 'audio/mp4',
      duration: 100, bitrate: 128, expiresAt: 0,
    })),
    getLyrics: vi.fn(async (q: { trackId: string }) => ({
      trackId: q.trackId, source: 'test', synced: false, lines: [], plain: '', instrumental: false, offset: 0, matchedTitle: '', matchedArtist: '',
    })),
    saveSettings: vi.fn(async (s) => s),
    setLiked: vi.fn(async () => []),
    recordPlay: vi.fn(async () => []),
    recordPlayEvent: vi.fn(async (t: Track, event: string) => {
      recorded.push({ track: t, event })
      const s = useLibraryStore.getState()
      return { history: s.history, stats: s.stats, disliked: s.disliked }
    }),
    getTaste: vi.fn(async () => {
      const s = useLibraryStore.getState()
      return { history: s.history, stats: s.stats, disliked: s.disliked }
    }),
    setDisliked: vi.fn(async () => ({ history: [], stats: {}, disliked: [] })),
    relatedTracks: vi.fn(async () => ({ tracks: related, source: 'ytmusic-next' })),
    clearHistory: vi.fn(async () => {}),
    addSearchTerm: vi.fn(async () => []), removeSearchTerm: vi.fn(async () => []),
    clearSearchHistory: vi.fn(async () => {}), libraryTracks: vi.fn(async () => []),
    saveSession: vi.fn(async () => {}), clearSession: vi.fn(async () => {}),
    createPlaylist: vi.fn(), renamePlaylist: vi.fn(), deletePlaylist: vi.fn(async () => {}),
    addTracksToPlaylist: vi.fn(), removeTrackFromPlaylist: vi.fn(), reorderPlaylist: vi.fn(),
    duplicatePlaylist: vi.fn(), installResolver: vi.fn(), setNowPlaying: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
  } as unknown as Backend
  setBackend(be)
  const controller = new PlaybackController(engine)
  LIVE.add(controller)
  return {
    media,
    controller,
    backend: {
      getPlayable: be.getPlayable as unknown as Harness['backend']['getPlayable'],
      relatedTracks: be.relatedTracks as unknown as Harness['backend']['relatedTracks'],
      saveSettings: be.saveSettings as unknown as Harness['backend']['saveSettings'],
      recordPlayEvent: be.recordPlayEvent as unknown as Harness['backend']['recordPlayEvent'],
    },
    recorded,
  }
}

const state = () => usePlayerStore.getState()

/**
 * Every controller created by harness() is stopped when the test ends: a
 * controller with a pending prefetch debounce must never fire its callback
 * into the NEXT test's freshly installed backend mock.
 */
const LIVE = new Set<PlaybackController>()

const flush = async (times = 12) => {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  usePlayerStore.setState({
    queue: [], autoQueue: [], index: -1, current: null, status: 'idle', error: null,
    shuffle: false, repeat: 'off', volume: 0.9, muted: false, speed: 1, sleepTimer: null,
    playingFrom: 'queue', contextLabel: '', radioSource: '',
  })
  useLibraryStore.setState({
    ...useLibraryStore.getState(), settings: defaultSettings(),
    liked: [], disliked: [], stats: {}, history: [],
  })
  useLyricsStore.setState({ trackId: null, status: 'idle', result: null, error: null })
  useUIStore.setState({ route: { name: 'home' }, history: [], future: [], queueOpen: false, nowPlayingOpen: false, lyricsOpen: false, toasts: [], resolverError: null, resolverProgress: null })
  positionChannel.reset()
  timerChannel.setRemaining(null)
})

afterEach(() => {
  for (const c of LIVE) {
    try {
      c.stop()
    } catch {
      /* a test may have already torn the controller down */
    }
  }
  LIVE.clear()
  vi.useRealTimers()
  vi.clearAllMocks()
  cleanup()
})

describe('Sleep timer', () => {
  it('1. starts a duration timer and publishes the countdown', async () => {
    const h = harness()
    await h.controller.play(track('a'), { tracks: [track('a')] })
    const before = Date.now()
    h.controller.setSleepTimer(15)
    const t = state().sleepTimer
    expect(t?.mode).toBe('duration')
    expect(t?.minutes).toBe(15)
    expect(t?.endsAt).toBeGreaterThanOrEqual(before + 15 * 60_000)
    expect(timerChannel.getRemaining()).toBeGreaterThan(0)
    h.controller.setSleepTimer(null)
  })

  it('2. starting a second timer replaces the first', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const h = harness()
    await h.controller.play(track('a'), { tracks: [track('a')] })
    await flush()
    h.controller.setSleepTimer(15)
    h.controller.setSleepTimer(45)
    expect(state().sleepTimer?.minutes).toBe(45)
    // 16 minutes: the replaced 15-minute timer must NOT have fired…
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    expect(state().status).toBe('playing')
    // …but 45 minutes still expires.
    await vi.advanceTimersByTimeAsync(30 * 60_000)
    expect(state().status).toBe('paused')
    expect(state().sleepTimer).toBeNull()
  })

  it('3. cancelling works immediately', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const h = harness()
    await h.controller.play(track('a'), { tracks: [track('a')] })
    await flush()
    h.controller.setSleepTimer(15)
    h.controller.setSleepTimer(null)
    expect(state().sleepTimer).toBeNull()
    expect(timerChannel.getRemaining()).toBeNull()
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(state().status).toBe('playing')
  })

  it('4. expiry pauses playback without clearing the session', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b] })
    await flush()
    h.controller.setSleepTimer(15)
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 5_000)
    expect(state().status).toBe('paused')
    expect(state().current?.id).toBe(a.id) // paused, not stopped: track intact
    expect(h.media.paused).toBe(true)
    expect(state().sleepTimer).toBeNull()
    expect(timerChannel.getRemaining()).toBeNull()
  })

  it('5. end-of-track waits for natural completion, records it once, and does not advance', async () => {
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b] })
    await flush()
    h.controller.setSleepTimer('endOfTrack')
    expect(state().sleepTimer).toEqual({ mode: 'endOfTrack', endsAt: null, minutes: null })
    h.media.endNaturally()
    await flush()
    // Natural completion happened → the REAL completed event, exactly once.
    expect(h.recorded.filter((r) => r.event === 'completed')).toHaveLength(1)
    // No advance: the same track stays current, parked at the start, paused.
    expect(state().current?.id).toBe(a.id)
    expect(state().status).toBe('paused')
    expect(positionChannel.getPosition()).toBe(0)
    expect(state().sleepTimer).toBeNull()
  })

  it('6. the timer never touches the User Queue', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b] })
    await flush()
    const queueBefore = state().queue.map((t) => t.id)
    const indexBefore = state().index
    h.controller.setSleepTimer(15)
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 5_000)
    expect(state().queue.map((t) => t.id)).toEqual(queueBefore)
    expect(state().index).toBe(indexBefore)
  })

  it('7. the timer never touches Autoplay or the radio state', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const rel = Array.from({ length: 4 }, (_, i) => track(`r${i}`, { artist: 'Other' }))
    const h = harness(rel)
    await h.controller.play(track('a'), { tracks: [track('a')] })
    await flush()
    await vi.advanceTimersByTimeAsync(50)
    const autoBefore = state().autoQueue.map((t) => t.id)
    expect(autoBefore.length).toBeGreaterThan(0)
    const radioSourceBefore = state().radioSource
    h.controller.setSleepTimer(15)
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 5_000)
    expect(state().autoQueue.map((t) => t.id)).toEqual(autoBefore)
    expect(state().radioSource).toBe(radioSourceBefore)
    expect(h.backend.relatedTracks).toHaveBeenCalledTimes(1) // no discovery duplication
  })

  it('8. starting/cancelling/expiry create no history events', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const h = harness()
    await h.controller.play(track('a'), { tracks: [track('a')] })
    await flush()
    const eventsBefore = h.recorded.length
    h.controller.setSleepTimer(15)
    h.controller.setSleepTimer(30)
    h.controller.setSleepTimer(null)
    await vi.advanceTimersByTimeAsync(35 * 60_000)
    expect(h.recorded.length).toBe(eventsBefore) // only the ladder's own entries
  })
})

describe('Playback speed', () => {
  it('9. changes apply immediately to the element and the store', async () => {
    const h = harness()
    await h.controller.play(track('a'), { tracks: [track('a')] })
    h.controller.setSpeed(1.75)
    expect(h.media.playbackRate).toBe(1.75)
    expect(state().speed).toBe(1.75)
    expect(h.backend.saveSettings).toHaveBeenCalled()
  })

  it('10. the next track inherits the chosen speed', async () => {
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b] })
    h.controller.setSpeed(1.5)
    await h.controller.next()
    await flush()
    expect(state().current?.id).toBe(b.id)
    expect(h.media.playbackRate).toBe(1.5)
    expect(state().speed).toBe(1.5)
  })

  it('11. speed survives route changes', async () => {
    const h = harness()
    await h.controller.play(track('a'), { tracks: [track('a')] })
    h.controller.setSpeed(0.5)
    ui.navigate({ name: 'search' })
    ui.navigate({ name: 'settings' })
    expect(state().speed).toBe(0.5)
    expect(h.media.playbackRate).toBe(0.5)
  })

  it('12. the default speed is 1×', async () => {
    const h = harness()
    await h.controller.play(track('a'), { tracks: [track('a')] })
    expect(state().speed).toBe(1)
    expect(h.media.playbackRate).toBe(1)
  })

  it('13. speed changes never trigger radio/discovery', async () => {
    const h = harness()
    await h.controller.play(track('a'), { tracks: [track('a')] })
    await flush()
    const calls = h.backend.relatedTracks.mock.calls.length
    const radioSourceBefore = state().radioSource
    ;[0.5, 0.75, 1.25, 1.5, 1.75, 2, 1].forEach((s) => h.controller.setSpeed(s))
    await flush()
    expect(h.backend.relatedTracks.mock.calls.length).toBe(calls)
    expect(state().radioSource).toBe(radioSourceBefore)
  })

  it('14. speed changes never create history events', async () => {
    const h = harness()
    await h.controller.play(track('a'), { tracks: [track('a')] })
    await flush()
    const before = h.recorded.length
    ;[0.5, 1.5, 1].forEach((s) => h.controller.setSpeed(s))
    await flush()
    expect(h.recorded.length).toBe(before)
  })
})

describe('Transition quality', () => {
  it('15. next-track pre-resolution resolves the next stream once, and start() reuses it', async () => {
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b] })
    // Let the debounced prefetch run (and give it room for accidental repeats).
    await wait(2500)
    // a (initial start) + b (one prefetch) — never a duplicate for b.
    expect(h.backend.getPlayable).toHaveBeenCalledTimes(2)
    // Advancing to b reuses the pre-resolved URL: no third resolver call.
    await h.controller.next()
    await flush()
    expect(state().current?.id).toBe(b.id)
    expect(h.media.src).toBe('http://local/b')
    expect(h.backend.getPlayable).toHaveBeenCalledTimes(2)
  })

  it('16. the autoplay queue stays bounded while discovery feeds it', async () => {
    const many = Array.from({ length: 30 }, (_, i) => track(`rel${i}`, { artist: 'Other' }))
    const h = harness(many)
    await h.controller.play(track('a'), { tracks: [track('a')] })
    await wait(1200)
    expect(state().autoQueue.length).toBeGreaterThan(0)
    expect(state().autoQueue.length).toBeLessThanOrEqual(20) // DISCOVERY_MAX
  })

  it('17. playback advances while a new discovery batch is still pending', async () => {
    const never = new Promise(() => {}) as never as ReturnType<() => { tracks: Track[]; source: string }>
    const h = harness()
    h.backend.relatedTracks.mockImplementationOnce(() => never)
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b] })
    await h.controller.next()
    await flush()
    expect(state().current?.id).toBe(b.id)
    expect(state().status).toBe('playing')
  })
})

describe('Crossfade / normalization capabilities (honest surface)', () => {
  it('18–20. no fade side effects exist anywhere in the pipeline', async () => {
    // The capability flags state the verdict; the assertions prove the flags
    // are not hiding a hidden half-implementation: volume is the user's global
    // control and NOTHING in the transport path touches it.
    expect(AUDIO_CAPABILITIES.gapless).toBe(false)
    expect(AUDIO_CAPABILITIES.crossfade).toBe(false)
    expect(AUDIO_CAPABILITIES.loudnessNormalization).toBe(false)

    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b] })
    const volume = h.media.volume

    // Natural transition: no fade ramps, no volume dip.
    h.media.endNaturally()
    await flush()
    expect(h.media.volume).toBe(volume)
    expect(state().volume).toBeCloseTo(volume)

    // Seek: never a crossfade trigger — volume untouched, position moves.
    h.controller.seek(42)
    expect(h.media.volume).toBe(volume)
    expect(positionChannel.getPosition()).toBe(42)

    // Same-track replay (repeat one): restart, no crossfade against itself.
    h.controller.cycleRepeat() // off -> all
    h.controller.cycleRepeat() // all -> one
    h.media.endNaturally()
    await flush()
    expect(state().current?.id).toBe(state().queue[state().index]?.id)
    expect(h.media.volume).toBe(volume)
    expect(h.media.playCount).toBeGreaterThan(1)
  })

  it('21. User Queue priority still wins over autoplay at transitions', async () => {
    const rel = [track('rel', { artist: 'Other' })]
    const h = harness(rel)
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b] })
    await wait(2000) // autoplay is filled by now; the prefetch warms b anyway
    await h.controller.next()
    await flush()
    expect(state().current?.id).toBe(b.id) // the QUEUED track, not the radio's
    expect(state().playingFrom).toBe('queue')
  })

  it('22. no fake loudness normalization: volume is global and per-track gain never applied', async () => {
    const h = harness()
    const [a, b] = [track('a', { title: 'LOUD MASTER' }), track('b', { title: 'quiet master' })]
    await h.controller.play(a, { tracks: [a, b] })
    const volume = h.media.volume
    await h.controller.next()
    await flush()
    // A different track with different (unknowable) loudness: identical volume.
    expect(h.media.volume).toBe(volume)
    expect(state().volume).toBeCloseTo(volume)
  })
})

describe('Player controls UI (speed + sleep timer)', () => {
  it('exposes speed and sleep timer selects that drive the global player', async () => {
    harness() // backend stub for settings persistence
    const a = track('a')
    usePlayerStore.setState({ current: a, status: 'playing', index: 0, queue: [a] })
    render(<NowPlaying />)
    const speed = screen.getByLabelText('Playback speed')
    fireEvent.change(speed, { target: { value: '1.5' } })
    expect(state().speed).toBe(1.5)
    expect(playback.engine.el.playbackRate).toBe(1.5)

    const sleep = screen.getByLabelText('Sleep timer') as HTMLSelectElement
    expect(sleep.value).toBe('off')
    fireEvent.change(sleep, { target: { value: '30' } })
    expect(state().sleepTimer).toMatchObject({ mode: 'duration', minutes: 30 })
    playback.setSleepTimer(null) // don't leave a tick running for other suites
    fireEvent.change(sleep, { target: { value: 'end' } })
    expect(state().sleepTimer).toEqual({ mode: 'endOfTrack', endsAt: null, minutes: null })
    fireEvent.change(sleep, { target: { value: 'off' } })
    expect(state().sleepTimer).toBeNull()
  })
})
