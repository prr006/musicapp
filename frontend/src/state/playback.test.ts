import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PlaybackAdapter, PlaybackEvent, PlaybackSnapshot, PlaybackStatus } from '../audio/adapter'
import { setBackend, type Backend } from '../bridge/backend'
import type { PlayEvent, Track } from '../bridge/types'
import { defaultSettings } from '../lib/defaults'
import { PlaybackController } from './playback'
import { library, useLibraryStore } from './libraryStore'
import { useLyricsStore } from './lyricsStore'
import { usePlayerStore } from './playerStore'
import { positionChannel } from './positionChannel'
import { recommenderTuning } from './recommender'
import { useUIStore } from './uiStore'

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * A controllable playback adapter. It behaves like a real provider (loads a
 * track, reports a position, fires ended) with none of the side effects, so
 * the controller's decisions can be asserted precisely.
 */
class FakeAdapter implements PlaybackAdapter {
  readonly kind = 'clock' as const
  readonly videoSurface: HTMLElement | null = null
  private listeners = new Set<(event: PlaybackEvent) => void>()
  private gen = 0
  private trackId: string | null = null
  private status: PlaybackStatus = 'idle'
  private error: string | null = null
  private volume = 0.9
  private muted = false
  private rate = 1
  positionVal = 0
  durationVal = 0
  playCount = 0
  stopCount = 0
  loaded: Track[] = []
  seekCalls: number[] = []
  delays = new Map<string, number>()
  failures = new Map<string, string>()

  subscribe(listener: (event: PlaybackEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: PlaybackEvent): void {
    for (const l of [...this.listeners]) l(event)
  }

  private emitState(): void {
    this.emit({ type: 'state', snapshot: this.snapshot() })
  }

  private setStatus(status: PlaybackStatus): void {
    if (this.status === status) return
    this.status = status
    this.emitState()
  }

  snapshot(): PlaybackSnapshot {
    return {
      status: this.status,
      trackId: this.trackId,
      duration: this.durationVal,
      buffered: this.durationVal,
      error: this.error,
      volume: this.volume,
      muted: this.muted,
      rate: this.rate,
    }
  }

  get position(): number {
    return this.positionVal
  }

  get currentGeneration(): number {
    return this.gen
  }

  beginLoad(trackId: string): number {
    this.gen += 1
    this.trackId = trackId
    this.error = null
    this.positionVal = 0
    this.setStatus('loading')
    this.emit({ type: 'position', position: 0, trackId })
    return this.gen
  }

  async load(token: number, track: Track, startAt = 0, autoplay = true): Promise<boolean> {
    const delay = this.delays.get(track.id)
    if (delay) await sleep(delay)
    if (token !== this.gen) return false
    const failure = this.failures.get(track.id)
    if (failure) {
      this.fail(token, failure)
      return false
    }
    this.loaded.push(track)
    this.durationVal = track.duration || 100
    this.positionVal = startAt
    if (autoplay) await this.play()
    else this.setStatus('paused')
    return token === this.gen
  }

  fail(token: number, message: string): void {
    if (token !== this.gen) return
    this.error = message
    this.setStatus('error')
    this.emit({ type: 'error', trackId: this.trackId, message })
  }

  isCurrent(token: number): boolean {
    return token === this.gen
  }

  async play(): Promise<void> {
    if (!this.trackId) return
    this.playCount += 1
    this.setStatus('playing')
  }

  pause(): void {
    if (!this.trackId) return
    this.setStatus('paused')
  }

  stop(): void {
    this.gen += 1
    this.stopCount += 1
    this.trackId = null
    this.positionVal = 0
    this.durationVal = 0
    this.setStatus('idle')
    this.emit({ type: 'position', position: 0, trackId: null })
  }

  seek(seconds: number): void {
    this.seekCalls.push(seconds)
    this.positionVal = seconds
    this.emit({ type: 'position', position: seconds, trackId: this.trackId })
  }

  restart(): void {
    this.seek(0)
    void this.play()
  }

  setVolume(volume: number): void {
    this.volume = volume
    this.emitState()
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.emitState()
  }

  setRate(rate: number): void {
    this.rate = rate
    this.emitState()
  }

  dispose(): void {}

  // ----- test helpers -----
  tick(seconds: number): void {
    this.positionVal = seconds
    this.emit({ type: 'position', position: seconds, trackId: this.trackId })
  }

  endNaturally(): void {
    this.positionVal = this.durationVal
    this.emit({ type: 'position', position: this.positionVal, trackId: this.trackId })
    this.status = 'paused'
    this.emitState()
    if (this.trackId) this.emit({ type: 'ended', trackId: this.trackId })
  }
}

interface Harness {
  adapter: FakeAdapter
  controller: PlaybackController
  backend: Backend
  recorded: { track: Track; event: PlayEvent }[]
}

function harness(): Harness {
  const adapter = new FakeAdapter()
  const recorded: { track: Track; event: PlayEvent }[] = []
  const lyricsDelays = new Map<string, number>()

  const be = {
    isNative: false,
    getState: vi.fn(),
    getDiagnostics: vi.fn(),
    search: vi.fn().mockResolvedValue({ query: '', songs: [], videos: [], albums: [], artists: [], provider: 'test' }),
    getLyrics: vi.fn(async (q: { trackId: string }) => {
      const delay = lyricsDelays.get(q.trackId) ?? 0
      if (delay) await sleep(delay)
      return {
        trackId: q.trackId,
        source: 'test',
        synced: true,
        lines: [{ time: 0, text: `lyrics for ${q.trackId}` }],
        plain: '',
        instrumental: false,
        offset: 0,
        matchedTitle: '',
        matchedArtist: '',
      }
    }),
    saveSettings: vi.fn(async (s) => s),
    setLiked: vi.fn(async () => []),
    recordPlayEvent: vi.fn(async (t: Track, event: PlayEvent) => {
      recorded.push({ track: t, event })
      return []
    }),
    clearHistory: vi.fn(async () => {}),
    addSearchTerm: vi.fn(async () => []),
    removeSearchTerm: vi.fn(async () => []),
    clearSearchHistory: vi.fn(async () => {}),
    libraryTracks: vi.fn(async () => []),
    saveSession: vi.fn(async () => {}),
    clearSession: vi.fn(async () => {}),
    createPlaylist: vi.fn(),
    renamePlaylist: vi.fn(),
    deletePlaylist: vi.fn(),
    addTracksToPlaylist: vi.fn(),
    removeTrackFromPlaylist: vi.fn(),
    reorderPlaylist: vi.fn(),
    duplicatePlaylist: vi.fn(),
    setNowPlaying: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
  } as unknown as Backend

  setBackend(be)
  return { adapter, controller: new PlaybackController(adapter), backend: be, recorded }
}

const state = () => usePlayerStore.getState()

beforeEach(() => {
  usePlayerStore.setState({
    queue: [], autoQueue: [], index: -1, current: null, status: 'idle', error: null,
    shuffle: false, repeat: 'off', volume: 0.9, muted: false, speed: 1,
    playingFrom: 'queue', contextLabel: '',
  })
  useLibraryStore.setState({
    ...useLibraryStore.getState(),
    settings: defaultSettings(), liked: [], history: [], playlists: [], searchHistory: [],
  })
  useLyricsStore.setState({ trackId: null, status: 'idle', result: null, error: null })
  positionChannel.reset()
  recommenderTuning.fetchCooldownMs = 0
  useUIStore.setState({ toasts: [] })
})

describe('track switching', () => {
  it('plays a track through the adapter by its source id, with no playable lookup', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a, track('b')], index: 0, label: 'Test' })
    expect(state().current?.id).toBe(a.id)
    expect(state().status).toBe('playing')
    expect(h.adapter.loaded.map((t) => t.sourceId)).toEqual(['a'])
    // The playback path never asks the backend for a playable source.
    expect((h.backend as unknown as Record<string, unknown>).getPlayable).toBeUndefined()
  })

  it('stops A immediately and never lets A’s late load replace B', async () => {
    const h = harness()
    const a = track('a')
    const b = track('b')
    h.adapter.delays.set(a.id, 60)

    const playA = h.controller.play(a, { tracks: [a, b], index: 0 })
    // The UI already shows A as loading, with nothing playing yet.
    expect(state().current?.id).toBe(a.id)
    expect(state().status).toBe('loading')
    expect(h.adapter.loaded).toHaveLength(0)

    await h.controller.play(b, { tracks: [a, b], index: 1 })
    expect(state().current?.id).toBe(b.id)
    expect(h.adapter.loaded.map((t) => t.id)).toEqual([b.id])

    await playA // A's load finishes late
    expect(state().current?.id).toBe(b.id)
    expect(h.adapter.loaded.map((t) => t.id)).toEqual([b.id])
    expect(state().status).toBe('playing')
  })

  it('drops stale lyrics from a previous track', async () => {
    const h = harness()
    const a = track('a')
    const b = track('b')
    ;(h.backend.getLyrics as ReturnType<typeof vi.fn>).mockImplementation(
      async (q: { trackId: string }) => {
        await sleep(q.trackId === a.id ? 80 : 0)
        return {
          trackId: q.trackId, source: 'test', synced: true,
          lines: [{ time: 0, text: `lyrics for ${q.trackId}` }], plain: '',
          instrumental: false, offset: 0, matchedTitle: '', matchedArtist: '',
        }
      },
    )

    const playA = h.controller.play(a, { tracks: [a, b], index: 0 })
    await h.controller.play(b, { tracks: [a, b], index: 1 })
    await playA
    await sleep(120)

    expect(useLyricsStore.getState().trackId).toBe(b.id)
    expect(useLyricsStore.getState().result?.lines[0].text).toContain(b.id)
  })

  it('clears stale metadata, artwork and position when switching', async () => {
    const h = harness()
    const a = track('a')
    const b = track('b', { artwork: 'http://img/b.jpg' })
    await h.controller.play(a, { tracks: [a, b], index: 0 })
    h.adapter.durationVal = 100
    h.adapter.tick(42)
    expect(positionChannel.getPosition()).toBe(42)

    h.adapter.delays.set(b.id, 30)
    const playB = h.controller.play(b, { tracks: [a, b], index: 1 })
    expect(state().current?.artwork).toBe('http://img/b.jpg')
    expect(positionChannel.getPosition()).toBe(0)
    expect(useLyricsStore.getState().result).toBeNull()
    await playB
  })

  it('surfaces a provider failure as an actionable error', async () => {
    const h = harness()
    const a = track('a')
    h.adapter.failures.set(a.id, 'This song can’t be played outside YouTube.')
    await h.controller.play(a, { tracks: [a] })
    expect(state().status).toBe('error')
    expect(state().error).toMatch(/outside YouTube/)
  })
})

describe('queue advancement', () => {
  it('advances exactly once on natural EOF: A → B → C', async () => {
    const h = harness()
    const [a, b, c] = [track('a'), track('b'), track('c')]
    await h.controller.play(a, { tracks: [a, b, c], index: 0 })

    h.adapter.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(b.id))
    expect(state().index).toBe(1)

    h.adapter.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(c.id))
    expect(state().index).toBe(2)
  })

  it('manual stop does not advance the queue', async () => {
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b], index: 0 })
    h.controller.stop()
    await sleep(20)
    expect(state().current).toBeNull()
    expect(state().status).toBe('idle')
    expect(h.adapter.stopCount).toBe(1)
  })

  it('manual next advances exactly once', async () => {
    const h = harness()
    const [a, b, c] = [track('a'), track('b'), track('c')]
    await h.controller.play(a, { tracks: [a, b, c], index: 0 })
    await h.controller.next()
    expect(state().current?.id).toBe(b.id)
    expect(state().index).toBe(1)
  })

  it('previous restarts the track after 3s, otherwise steps back', async () => {
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b], index: 0 })
    await h.controller.next()
    expect(state().current?.id).toBe(b.id)

    h.adapter.tick(1)
    await h.controller.previous()
    expect(state().current?.id).toBe(a.id)

    h.adapter.tick(30)
    await h.controller.previous()
    expect(state().current?.id).toBe(a.id)
    expect(h.adapter.positionVal).toBe(0)
  })

  it('previous walks back through what actually played during autoplay', async () => {
    const h = harness()
    const a = track('a')
    const r1 = track('r1')
    const r2 = track('r2')
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [r1, r2], videos: [], albums: [], artists: [], provider: 'test',
    })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))

    h.adapter.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(r1.id))
    expect(state().playingFrom).toBe('autoplay')

    h.adapter.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(r2.id))

    h.adapter.tick(1) // early enough to step back rather than restart
    await h.controller.previous()
    expect(state().current?.id).toBe(r1.id)
    expect(state().playingFrom).toBe('autoplay')
  })

  it('stops at the end of the queue when repeat is off and autoplay is disabled', async () => {
    const h = harness()
    const a = track('a')
    useLibraryStore.setState({ settings: { ...defaultSettings(), autoplay: false } })
    await h.controller.play(a, { tracks: [a], index: 0 })
    h.adapter.endNaturally()
    await vi.waitFor(() => expect(state().status).toBe('idle'))
    expect(state().queue).toHaveLength(1)
  })

  it('repeat one replays the same track on EOF', async () => {
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b], index: 0 })
    h.controller.setRepeat('one')
    h.adapter.endNaturally()
    await vi.waitFor(() => expect(h.adapter.playCount).toBeGreaterThan(1))
    expect(state().current?.id).toBe(a.id)
  })

  it('repeat all wraps A → B → C → A', async () => {
    const h = harness()
    const [a, b, c] = [track('a'), track('b'), track('c')]
    await h.controller.play(a, { tracks: [a, b, c], index: 0 })
    h.controller.setRepeat('all')
    await h.controller.next()
    await h.controller.next()
    expect(state().current?.id).toBe(c.id)
    h.adapter.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(a.id))
    expect(state().index).toBe(0)
  })
})

describe('listening history recording', () => {
  it('records a start when playback actually runs, once per listen', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a] })
    await vi.waitFor(() => expect(h.recorded).toHaveLength(1))
    expect(h.recorded[0].event.phase).toBe('start')
    // Pause/resume must not record a second start.
    h.controller.pause()
    await h.controller.resume()
    await sleep(20)
    expect(h.recorded).toHaveLength(1)
  })

  it('records a completed listen on natural EOF', async () => {
    const h = harness()
    const a = track('a', { duration: 100 })
    await h.controller.play(a, { tracks: [a] })
    await vi.waitFor(() => expect(h.recorded).toHaveLength(1))
    h.adapter.endNaturally()
    await vi.waitFor(() => expect(h.recorded).toHaveLength(2))
    const end = h.recorded[1]
    expect(end.event.phase).toBe('end')
    expect(end.event.completed).toBe(true)
    expect(end.event.skipped).toBe(false)
  })

  it('records a skip when the user hits next early', async () => {
    const h = harness()
    const a = track('a', { duration: 200 })
    await h.controller.play(a, { tracks: [a, track('b')], index: 0 })
    await vi.waitFor(() => expect(h.recorded).toHaveLength(1))
    h.adapter.tick(5) // 5s into a 200s track is a skip
    await h.controller.next()
    await vi.waitFor(() => expect(h.recorded.length).toBeGreaterThanOrEqual(3))
    const endForA = h.recorded.find((r) => r.track.id === a.id && r.event.phase === 'end')
    expect(endForA?.event.skipped).toBe(true)
    expect(endForA?.event.completed).toBe(false)
  })

  it('does not record an end for a track that never played', async () => {
    const h = harness()
    const a = track('a')
    h.adapter.failures.set(a.id, 'nope')
    await h.controller.play(a, { tracks: [a] })
    await sleep(30)
    expect(h.recorded).toHaveLength(0) // never reached 'playing'
  })
})

describe('queue editing', () => {
  it('play next inserts directly after the current track', async () => {
    const h = harness()
    const [a, b, c] = [track('a'), track('b'), track('c')]
    await h.controller.play(a, { tracks: [a, b], index: 0 })
    h.controller.playNext([c])
    expect(state().queue.map((t) => t.sourceId)).toEqual(['a', 'c', 'b'])
  })

  it('add to queue appends and ignores duplicates', async () => {
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a], index: 0 })
    h.controller.addToQueue([b])
    h.controller.addToQueue([b])
    expect(state().queue.map((t) => t.sourceId)).toEqual(['a', 'b'])
  })

  it('add to queue touches only the user queue, never the autoplay buffer', async () => {
    const h = harness()
    const a = track('a')
    const extra = track('z')
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [extra], videos: [], albums: [], artists: [], provider: 'test',
    })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue).toHaveLength(1))
    const autoplayBefore = state().autoQueue.map((t) => t.id)

    const manual = track('manual')
    h.controller.addToQueue([manual])
    expect(state().queue.map((t) => t.id)).toEqual([a.id, manual.id])
    expect(state().autoQueue.map((t) => t.id)).toEqual(autoplayBefore)
  })

  it('remove and reorder keep the current index pointing at the same track', async () => {
    const h = harness()
    const [a, b, c] = [track('a'), track('b'), track('c')]
    await h.controller.play(b, { tracks: [a, b, c], index: 1 })
    h.controller.removeFromQueue(0)
    expect(state().index).toBe(0)
    expect(state().current?.id).toBe(b.id)

    h.controller.reorderQueue(0, 1)
    expect(state().queue.map((t) => t.sourceId)).toEqual(['c', 'b'])
    expect(state().current?.id).toBe(b.id)
    expect(state().queue[state().index].id).toBe(b.id)
  })

  it('never removes the currently playing track from the queue', async () => {
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b], index: 0 })
    h.controller.removeFromQueue(0)
    expect(state().queue).toHaveLength(2)
  })

  it('clear upcoming keeps the current track', async () => {
    const h = harness()
    const [a, b, c] = [track('a'), track('b'), track('c')]
    await h.controller.play(a, { tracks: [a, b, c], index: 0 })
    h.controller.clearUpcoming()
    expect(state().queue.map((t) => t.sourceId)).toEqual(['a'])
  })

  it('shuffle keeps the current track in place and loses nothing', async () => {
    const h = harness()
    const tracks = ['a', 'b', 'c', 'd', 'e'].map((id) => track(id))
    await h.controller.play(tracks[1], { tracks, index: 1 })
    h.controller.toggleShuffle()
    const after = state().queue
    expect(state().shuffle).toBe(true)
    expect(after[1].id).toBe(tracks[1].id)
    expect(after).toHaveLength(5)
    expect(new Set(after.map((t) => t.id)).size).toBe(5)
    expect(after.slice(0, 2).map((t) => t.id)).toEqual([tracks[0].id, tracks[1].id])
  })
})

describe('autoplay / recommendations', () => {
  it('is kept separate from the explicit queue and only used after it ends', async () => {
    const h = harness()
    const a = track('a')
    const b = track('b')
    const c = track('c')
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [b, c], videos: [], albums: [], artists: [], provider: 'test',
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
    expect(state().queue.map((t) => t.id)).toEqual([a.id])

    // The explicit queue is exhausted only after A itself finishes.
    h.adapter.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(b.id))
    expect(state().playingFrom).toBe('autoplay')
    expect(state().queue.map((t) => t.id)).toEqual([a.id])
  })

  it('tracks the user queues while autoplaying always come first', async () => {
    const h = harness()
    const a = track('a')
    const r1 = track('r1')
    const r2 = track('r2')
    const manual = track('manual')
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [r1, r2], videos: [], albums: [], artists: [], provider: 'test',
    })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))

    // Autoplay starts.
    h.adapter.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(r1.id))
    expect(state().playingFrom).toBe('autoplay')

    // The user queues something mid-play.
    h.controller.playNext([manual])
    h.adapter.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(manual.id))
    expect(state().playingFrom).toBe('queue')
    expect(state().queue.map((t) => t.id)).toEqual([a.id, manual.id])
  })

  it('explicit choices preserve and re-rank the existing buffer instead of wiping it', async () => {
    const h = harness()
    const a = track('a', { artist: 'Alpha' })
    const b = track('b', { artist: 'Beta' })
    const r1 = track('r1', { artist: 'Alpha' })
    const r2 = track('r2', { artist: 'Gamma' })
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [r1, r2], videos: [], albums: [], artists: [], provider: 'test',
    })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual([r1.id, r2.id]))

    await h.controller.play(b, { tracks: [b], index: 0 })
    await sleep(40)
    // Nothing was dropped; the buffer survives the context change.
    expect(new Set(state().autoQueue.map((t) => t.id))).toEqual(new Set([r1.id, r2.id]))
  })

  it('playing a recommendation removes only that item from the buffer', async () => {
    const h = harness()
    const a = track('a')
    const r1 = track('r1', { artist: 'Riya Sharma' })
    const r2 = track('r2', { artist: 'Gana Bala' })
    const r3 = track('r3', { artist: 'Neon Tide' })
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [r1, r2, r3], videos: [], albums: [], artists: [], provider: 'test',
    })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual([r1.id, r2.id, r3.id]))

    await h.controller.playDiscovered(r2)
    expect(state().current?.id).toBe(r2.id)
    expect(state().playingFrom).toBe('autoplay')
    expect(state().autoQueue.map((t) => t.id)).toEqual([r1.id, r3.id])
  })

  it('keeps playing indefinitely, without immediate repeats, while autoplay is on', async () => {
    const h = harness()
    const a = track('a')
    const pool = Array.from({ length: 40 }, (_, i) => track(`d${i}`))
    const history: { track: Track; event: PlayEvent }[] = []
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockImplementation(async (query: string) => {
      // Rotate the pool a little so later fetches can still find fresh tracks.
      const offset = (query.length * 3) % 10
      return { query, songs: pool.slice(offset), videos: [], albums: [], artists: [], provider: 'test' }
    })
    ;(h.backend.recordPlayEvent as ReturnType<typeof vi.fn>).mockImplementation(
      async (t: Track, event: PlayEvent) => {
        history.push({ track: t, event })
        useLibraryStore.setState({
          history: history.map((r) => ({
            track: r.track, playedAt: Date.now(), listenedSec: 100,
            trackDuration: 100, completed: r.event.completed ?? false, skipped: r.event.skipped ?? false,
          })),
        })
        return useLibraryStore.getState().history
      },
    )

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
    const seen = new Set<string>([a.id])
    for (let i = 0; i < 18; i += 1) {
      h.adapter.endNaturally()
      await vi.waitFor(() => {
        expect(state().status).toBe('playing')
        expect(seen.has(state().current!.id)).toBe(false)
      })
      seen.add(state().current!.id)
      await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
    }
  })

  it('maintains a rolling buffer: tops up as it drains and never exceeds the cap', async () => {
    const h = harness()
    const a = track('a')
    const pool = Array.from({ length: 60 }, (_, i) =>
      track(`d${i}`, { artist: `Pool Artist ${i % 7}`, title: `Pool Song ${i}` }))
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: pool, videos: [], albums: [], artists: [], provider: 'test',
    })
    await h.controller.play(a, { tracks: [a], index: 0 })
    // First fetch lands a bounded batch (never the whole pool).
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
    expect(state().autoQueue.length).toBeLessThanOrEqual(10)

    // As tracks are consumed the buffer grows toward the rolling target…
    for (let i = 0; i < 3; i += 1) {
      h.adapter.endNaturally()
      await vi.waitFor(() => expect(state().status).toBe('playing'))
      await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(8))
    }
    // …and never past the cap.
    expect(state().autoQueue.length).toBeLessThanOrEqual(30)
  })

  it('warns once when a refill fails and recovers on a later fetch', async () => {
    const h = harness()
    const a = track('a')
    const one = track('one')
    const two = track('two')
    const three = track('three')
    let mode: 'ok' | 'fail' | 'recover' = 'ok'
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (mode === 'fail') throw new Error('network down')
      if (mode === 'recover') return { query: '', songs: [three], videos: [], albums: [], artists: [], provider: 'test' }
      return { query: '', songs: [one, two], videos: [], albums: [], artists: [], provider: 'test' }
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual([one.id, two.id]))

    mode = 'fail'
    h.adapter.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(one.id))
    await vi.waitFor(() => expect(useUIStore.getState().toasts).toHaveLength(1))
    expect(useUIStore.getState().toasts[0].message).toMatch(/retry/)

    mode = 'recover'
    h.adapter.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(two.id))
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
    expect(state().autoQueue.map((t) => t.id)).toContain(three.id)
  })

  it('stopping autoplay empties the buffer without touching the explicit queue', async () => {
    const h = harness()
    const a = track('a')
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [track('z')], videos: [], albums: [], artists: [], provider: 'test',
    })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))

    h.controller.setAutoplay(false)
    expect(state().autoQueue).toHaveLength(0)
    expect(state().queue.map((t) => t.id)).toEqual([a.id])
    expect(state().status).toBe('playing')
  })

  it('clearing autoplay drops a fetch that is still in flight', async () => {
    const h = harness()
    const a = track('a')
    const stale = track('stale')
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await sleep(60)
      return { query: '', songs: [stale], videos: [], albums: [], artists: [], provider: 'test' }
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    h.controller.clearAutoplay()
    await sleep(100)
    expect(state().autoQueue).toHaveLength(0)
    expect(state().autoQueue.some((t) => t.id === stale.id)).toBe(false)
  })

  it('play now without a context queues only the chosen track — never its search siblings', async () => {
    const h = harness()
    const chosen = track('chosen')
    const siblings = [
      track('s1', { artist: 'Sia' }),
      track('s2', { artist: 'Sid Sriram' }),
      track('s3', { artist: 'Snow Patrol' }),
    ]
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [chosen, ...siblings], videos: [], albums: [], artists: [], provider: 'test',
    })

    // Mirrors the SearchView single-click: no `tracks` context at all.
    await h.controller.play(chosen)
    expect(state().current?.id).toBe(chosen.id)
    expect(state().queue.map((t) => t.id)).toEqual([chosen.id])
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual(siblings.map((t) => t.id)))
    expect(state().queue).toHaveLength(1)
  })

  it('never queues two uploads of the same song', async () => {
    const h = harness()
    const a = track('a', { title: 'Radioactive', artist: 'Imagine Dragons' })
    const upload1 = track('u1', { title: 'Believer', artist: 'Imagine Dragons' })
    const upload2 = track('u2', { title: 'Believer (Official Video)', artist: 'Imagine Dragons' })
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [upload1, upload2], videos: [], albums: [], artists: [], provider: 'test',
    })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
    expect(state().autoQueue.map((t) => t.id)).toEqual([upload1.id])
  })

  it('does not suggest a recently skipped track again', async () => {
    const h = harness()
    const a = track('a', { duration: 200 })
    const b = track('b', { duration: 200 })
    const pool = [track('p1'), track('p2'), track('p3')]
    const history: { track: Track; event: PlayEvent }[] = []
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [b, ...pool], videos: [], albums: [], artists: [], provider: 'test',
    })
    ;(h.backend.recordPlayEvent as ReturnType<typeof vi.fn>).mockImplementation(
      async (t: Track, event: PlayEvent) => {
        history.push({ track: t, event })
        useLibraryStore.setState({
          history: history.map((r) => ({
            track: r.track, playedAt: Date.now(),
            listenedSec: r.event.listenedSec ?? 0,
            trackDuration: 200,
            completed: r.event.completed ?? false,
            skipped: r.event.skipped ?? false,
          })),
        })
        return useLibraryStore.getState().history
      },
    )

    await h.controller.play(a, { tracks: [a, b], index: 0 })
    h.adapter.tick(4)
    await h.controller.next() // b skipped after 4 seconds
    await vi.waitFor(() => expect(state().current?.id).toBe(b.id))

    // b was skipped moments ago; the next refill must not re-suggest it.
    h.adapter.tick(2)
    await h.controller.next()
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
    expect(state().autoQueue.some((t) => t.id === b.id)).toBe(false)
  })
})

describe('transport controls', () => {
  it('pause and resume use the adapter', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a] })
    h.controller.pause()
    expect(state().status).toBe('paused')
    await h.controller.resume()
    expect(state().status).toBe('playing')
  })

  it('seek moves the adapter and the published position', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a] })
    h.controller.seek(55)
    expect(h.adapter.positionVal).toBe(55)
    expect(positionChannel.getPosition()).toBe(55)
  })

  it('volume, mute and speed are applied and persisted', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a] })
    h.controller.setVolume(0.3)
    expect(h.adapter.snapshot().volume).toBeCloseTo(0.3)
    h.controller.toggleMute()
    expect(h.adapter.snapshot().muted).toBe(true)
    h.controller.setSpeed(1.5)
    expect(h.adapter.snapshot().rate).toBe(1.5)
    expect(h.backend.saveSettings).toHaveBeenCalled()
  })
})

describe('session restore', () => {
  it('restores the queue without auto-resuming by default', async () => {
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.restoreSession(
      { queue: [a, b], autoQueue: [], index: 1, current: null, playingFrom: 'queue', position: 33, shuffle: true, repeat: 'all', speed: 1.25 },
      false,
    )
    expect(state().current?.id).toBe(b.id)
    expect(state().repeat).toBe('all')
    expect(state().shuffle).toBe(true)
    expect(positionChannel.getPosition()).toBe(33)
    expect(h.adapter.loaded).toHaveLength(0)
  })

  it('resumes playback at the saved position when asked', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.restoreSession(
      { queue: [a], autoQueue: [], index: 0, current: a, playingFrom: 'queue', position: 12, shuffle: false, repeat: 'off', speed: 1 },
      true,
    )
    expect(h.adapter.loaded.map((t) => t.id)).toEqual([a.id])
    expect(h.adapter.positionVal).toBe(12)
  })

  it('restores an autoplay session: current may live outside the queue', async () => {
    const h = harness()
    const a = track('a')
    const auto = track('auto1')
    await h.controller.restoreSession(
      { queue: [a], autoQueue: [track('n1')], index: 0, current: auto, playingFrom: 'autoplay', position: 40, shuffle: false, repeat: 'off', speed: 1 },
      false,
    )
    expect(state().current?.id).toBe(auto.id)
    expect(state().playingFrom).toBe('autoplay')
  })
})

describe('library integration', () => {
  it('toggling like is optimistic and then reconciled with the backend', async () => {
    const h = harness()
    const a = track('a')
    ;(h.backend.setLiked as ReturnType<typeof vi.fn>).mockResolvedValue([a])
    await library.toggleLike(a)
    expect(useLibraryStore.getState().liked.map((t) => t.id)).toEqual([a.id])
  })
})

describe('desktop mirroring', () => {
  it('tells the backend what is now playing, and that nothing is, after a stop', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a] })
    expect(h.backend.setNowPlaying).toHaveBeenCalledWith(a.title, a.artist)
    h.controller.stop()
    expect(h.backend.setNowPlaying).toHaveBeenLastCalledWith('', '')
  })
})

describe('broken-track resilience', () => {
  it('auto-skips a track that fails to play, then recovers', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const a = track('a', { duration: 100 })
      const b = track('b', { duration: 100 })
      await h.controller.play(a, { tracks: [a, b], index: 0 })

      // A fails mid-flight with an embed-style error.
      h.adapter.failures.set(a.id, 'This song can’t be played outside YouTube.')
      const failing = h.controller.play(a, { tracks: [a, b], index: 0 })
      await failing
      expect(state().status).toBe('error')

      // After the grace period the controller moves on by itself.
      await vi.advanceTimersByTimeAsync(1600)
      expect(state().current?.id).toBe(b.id)
      expect(state().status).toBe('playing')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops auto-skipping after several consecutive failures', async () => {
    vi.useFakeTimers()
    try {
      const h = harness()
      const tracks = [track('a'), track('b'), track('c'), track('d'), track('e')]
      for (const t of tracks) h.adapter.failures.set(t.id, 'broken')
      await h.controller.play(tracks[0], { tracks, index: 0 })
      expect(state().status).toBe('error')

      await vi.advanceTimersByTimeAsync(10_000)
      // It tried a few times, then left the error visible for the user.
      expect(state().status).toBe('error')
      expect(h.adapter.loaded.length).toBeLessThanOrEqual(4)
    } finally {
      vi.useRealTimers()
    }
  })
})
