import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlaybackEngine } from '../audio/engine'
import { setBackend, type Backend } from '../bridge/backend'
import type { PlayableSource, Track } from '../bridge/types'
import { defaultSettings } from '../lib/defaults'
import { PlaybackController } from './playback'
import { library, useLibraryStore } from './libraryStore'
import { useLyricsStore } from './lyricsStore'
import { usePlayerStore } from './playerStore'
import { positionChannel } from './positionChannel'
import { useUIStore } from './uiStore'
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
  backend: Backend
  resolveDelays: Map<string, number>
  resolveErrors: Map<string, string>
  recorded: { track: Track; event: string }[]
  lyricsDelays: Map<string, number>
}

function harness(): Harness {
  const media = new FakeMedia()
  const engine = new PlaybackEngine(media.asElement())
  const resolveDelays = new Map<string, number>()
  const resolveErrors = new Map<string, string>()
  const lyricsDelays = new Map<string, number>()
  const recorded: { track: Track; event: string }[] = []

  const be = {
    isNative: false,
    getState: vi.fn(),
    getDiagnostics: vi.fn(),
    search: vi.fn().mockResolvedValue({ query: '', songs: [], videos: [], albums: [], artists: [], provider: 'test' }),
    getPlayable: vi.fn(async (t: Track): Promise<PlayableSource> => {
      const delay = resolveDelays.get(t.id) ?? 0
      if (delay) await new Promise((r) => setTimeout(r, delay))
      const err = resolveErrors.get(t.id)
      if (err) throw new Error(err)
      return { trackId: t.id, url: `http://local/${t.sourceId}`, mimeType: 'audio/mp4', duration: 100, bitrate: 128, expiresAt: 0 }
    }),
    getLyrics: vi.fn(async (q: { trackId: string }) => {
      const delay = lyricsDelays.get(q.trackId) ?? 0
      if (delay) await new Promise((r) => setTimeout(r, delay))
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
    recordPlay: vi.fn(async (t: Track) => {
      recorded.push({ track: t, event: 'play_started' })
      return []
    }),
    recordPlayEvent: vi.fn(async (t: Track, event: string) => {
      recorded.push({ track: t, event })
      // Neutral by default: echo the store's current taste back.
      const s = useLibraryStore.getState()
      return { history: s.history, stats: s.stats, disliked: s.disliked }
    }),
    getTaste: vi.fn(async () => {
      const s = useLibraryStore.getState()
      return { history: s.history, stats: s.stats, disliked: s.disliked }
    }),
    setDisliked: vi.fn(async (t: Track, disliked: boolean) => {
      const s = useLibraryStore.getState()
      return {
        history: s.history,
        stats: s.stats,
        disliked: disliked ? [t, ...s.disliked.filter((d) => d.id !== t.id)] : s.disliked.filter((d) => d.id !== t.id),
      }
    }),
    relatedTracks: vi.fn(async () => ({ tracks: [], source: '' })),
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
    installResolver: vi.fn(),
    setNowPlaying: vi.fn(async () => {}),
    on: vi.fn(() => () => {}),
  } as unknown as Backend

  setBackend(be)
  return { media, controller: new PlaybackController(engine), backend: be, resolveDelays, resolveErrors, recorded, lyricsDelays }
}

const state = () => usePlayerStore.getState()

beforeEach(() => {
  usePlayerStore.setState({
    queue: [], autoQueue: [], index: -1, current: null, status: 'idle', error: null,
    shuffle: false, repeat: 'off', volume: 0.9, muted: false, speed: 1,
    playingFrom: 'queue', contextLabel: '', radioSource: '',
  })
  useLibraryStore.setState({ ...useLibraryStore.getState(), settings: defaultSettings(), liked: [], disliked: [], stats: {}, history: [] })
  useLyricsStore.setState({ trackId: null, status: 'idle', result: null, error: null })
  positionChannel.reset()
})

describe('track switching', () => {
  it('plays a track and exposes it as current', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a, track('b')], index: 0, label: 'Test' })
    expect(state().current?.id).toBe(a.id)
    expect(state().status).toBe('playing')
    expect(h.media.src).toBe('http://local/a')
  })

  it('stops A immediately and never lets A\'s late resolver result replace B', async () => {
    const h = harness()
    const a = track('a')
    const b = track('b')
    h.resolveDelays.set(a.id, 60)

    const playA = h.controller.play(a, { tracks: [a, b], index: 0 })
    // The UI already shows A as loading, with no audio attached.
    expect(state().current?.id).toBe(a.id)
    expect(state().status).toBe('loading')
    expect(h.media.src).toBe('')

    await h.controller.play(b, { tracks: [a, b], index: 1 })
    expect(state().current?.id).toBe(b.id)
    expect(h.media.src).toBe('http://local/b')

    await playA // A's resolver finishes late
    expect(state().current?.id).toBe(b.id)
    expect(h.media.src).toBe('http://local/b')
    expect(state().status).toBe('playing')
  })

  it('drops stale lyrics from a previous track', async () => {
    const h = harness()
    const a = track('a')
    const b = track('b')
    h.lyricsDelays.set(a.id, 80)

    const playA = h.controller.play(a, { tracks: [a, b], index: 0 })
    await h.controller.play(b, { tracks: [a, b], index: 1 })
    await playA
    await new Promise((r) => setTimeout(r, 120))

    expect(useLyricsStore.getState().trackId).toBe(b.id)
    expect(useLyricsStore.getState().result?.lines[0].text).toContain(b.id)
  })

  it('clears stale metadata, artwork and position when switching', async () => {
    const h = harness()
    const a = track('a')
    const b = track('b', { artwork: 'http://img/b.jpg' })
    await h.controller.play(a, { tracks: [a, b], index: 0 })
    h.media.setDuration(100)
    h.media.tick(42)
    expect(positionChannel.getPosition()).toBe(42)

    h.resolveDelays.set(b.id, 30)
    const playB = h.controller.play(b, { tracks: [a, b], index: 1 })
    expect(state().current?.artwork).toBe('http://img/b.jpg')
    expect(positionChannel.getPosition()).toBe(0)
    expect(useLyricsStore.getState().result).toBeNull()
    await playB
  })

  it('surfaces a resolver failure as an actionable error', async () => {
    const h = harness()
    const a = track('a')
    h.resolveErrors.set(a.id, 'Couldn’t load this song.')
    await h.controller.play(a, { tracks: [a] })
    expect(state().status).toBe('error')
    expect(state().error).toMatch(/Couldn’t load this song/)
  })
})

describe('queue advancement', () => {
  it('advances exactly once on natural EOF: A → B → C', async () => {
    const h = harness()
    const [a, b, c] = [track('a'), track('b'), track('c')]
    await h.controller.play(a, { tracks: [a, b, c], index: 0 })

    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(b.id))
    expect(state().index).toBe(1)

    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(c.id))
    expect(state().index).toBe(2)
  })

  it('manual stop does not advance the queue', async () => {
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b], index: 0 })
    h.controller.stop()
    await new Promise((r) => setTimeout(r, 20))
    expect(state().current).toBeNull()
    expect(state().status).toBe('idle')
    expect(h.media.src).toBe('')
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

    h.media.setDuration(100)
    h.media.tick(1)
    await h.controller.previous()
    expect(state().current?.id).toBe(a.id)

    h.media.tick(30)
    await h.controller.previous()
    expect(state().current?.id).toBe(a.id)
    expect(h.media.currentTime).toBe(0)
  })

  it('stops at the end of the queue when repeat is off', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a], index: 0 })
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().status).toBe('idle'))
    expect(state().queue).toHaveLength(1)
  })

  it('repeat one replays the same track on EOF', async () => {
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.play(a, { tracks: [a, b], index: 0 })
    h.controller.setRepeat('one')
    const loadsBefore = h.media.loadCount
    h.media.endNaturally()
    await vi.waitFor(() => expect(h.media.playCount).toBeGreaterThan(1))
    expect(state().current?.id).toBe(a.id)
    expect(h.media.loadCount).toBe(loadsBefore) // same source, just replayed
  })

  it('repeat all wraps A → B → C → A', async () => {
    const h = harness()
    const [a, b, c] = [track('a'), track('b'), track('c')]
    await h.controller.play(a, { tracks: [a, b, c], index: 0 })
    h.controller.setRepeat('all')
    await h.controller.next()
    await h.controller.next()
    expect(state().current?.id).toBe(c.id)
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(a.id))
    expect(state().index).toBe(0)
  })

  it('records history when playback actually starts, once per track', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a] })
    await vi.waitFor(() => expect(h.recorded).toHaveLength(1))
    h.media.dispatchEvent(new Event('pause'))
    await h.media.play()
    await new Promise((r) => setTimeout(r, 10))
    expect(h.recorded).toHaveLength(1)
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

  it('add to queue touches only the user queue, never the discovery list', async () => {
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

  it('play next touches only the user queue, never the discovery list', async () => {
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
    h.controller.playNext([manual])
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

describe('autoplay', () => {
  it('is kept separate from the explicit queue and only used after it ends', async () => {
    const h = harness()
    const a = track('a')
    const extra = track('z')
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [extra], videos: [], albums: [], artists: [], provider: 'test',
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue).toHaveLength(1))
    expect(state().queue.map((t) => t.id)).toEqual([a.id]) // untouched

    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(extra.id))
    expect(state().playingFrom).toBe('autoplay')
  })

  it('does not run when the user turned it off', async () => {
    const h = harness()
    useLibraryStore.setState({ settings: { ...defaultSettings(), autoplay: false } })
    const a = track('a')
    await h.controller.play(a, { tracks: [a], index: 0 })
    await new Promise((r) => setTimeout(r, 30))
    expect(state().autoQueue).toHaveLength(0)
    expect(h.backend.search).not.toHaveBeenCalled()

    h.media.endNaturally()
    await vi.waitFor(() => expect(state().status).toBe('idle'))
  })
})

describe('discovery (endless queue)', () => {
  it('fills the background queue and keeps it separate from the explicit queue', async () => {
    const h = harness()
    const a = track('a')
    const pool = Array.from({ length: 10 }, (_, i) => track(`d${i}`))
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: pool, videos: [], albums: [], artists: [], provider: 'test',
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(8))
    expect(state().queue.map((t) => t.id)).toEqual([a.id])
  })

  it('never queues songs already in the queue, upcoming, current, or recent history', async () => {
    const h = harness()
    const a = track('a')
    const b = track('b')
    const dup = track('dup')
    const fresh = track('fresh')
    // The backend reports `dup` as recently played, so discovery must skip it.
    ;(h.backend.recordPlayEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
      history: [{ track: dup, playedAt: Date.now() }],
      stats: {},
      disliked: [],
    })
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [a, b, dup, fresh], videos: [], albums: [], artists: [], provider: 'test',
    })

    await h.controller.play(a, { tracks: [a, b], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
    expect(state().autoQueue.map((t) => t.id)).toEqual([fresh.id])
  })

  it('gives manual queue entries priority over discovery', async () => {
    const h = harness()
    const a = track('a')
    const extra = track('z')
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [extra], videos: [], albums: [], artists: [], provider: 'test',
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue).toHaveLength(1))
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(extra.id))
    expect(state().playingFrom).toBe('autoplay')

    const manual = track('manual')
    h.controller.addToQueue([manual])
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(manual.id))
    expect(state().playingFrom).toBe('queue')
  })

  it('keeps existing upcoming tracks, warns once and retries on provider failure', async () => {
    useUIStore.setState({ toasts: [] })
    const h = harness()
    const a = track('a')
    const one = track('one')
    const two = track('two')
    const three = track('three')

    let mode: 'seed' | 'fail' | 'recover' = 'seed'
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (mode === 'fail') throw new Error('network down')
      if (mode === 'recover') {
        return { query: '', songs: [three], videos: [], albums: [], artists: [], provider: 'test' }
      }
      return { query: '', songs: [one, two], videos: [], albums: [], artists: [], provider: 'test' }
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual([one.id, two.id]))

    // Consume `one`; the refill for the next slot fails but must not disturb playback.
    mode = 'fail'
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(one.id))
    expect(state().status).toBe('playing')
    expect(state().autoQueue.map((t) => t.id)).toEqual([two.id]) // kept intact
    await vi.waitFor(() => expect(useUIStore.getState().toasts).toHaveLength(1))
    expect(useUIStore.getState().toasts[0].message).toMatch(/retry/)

    // Consume `two`; the warning is not repeated.
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(two.id))
    expect(useUIStore.getState().toasts).toHaveLength(1)

    // …and a later refill recovers.
    mode = 'recover'
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(three.id))
    expect(state().status).toBe('playing')
  })

  it('stopping autoplay empties discovery without touching the explicit queue', async () => {
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

  it('play now without a context queues only the chosen track — never its search siblings', async () => {
    const h = harness()
    const chosen = track('chosen')
    const siblings = [track('s1'), track('s2'), track('s3')]
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: siblings, videos: [], albums: [], artists: [], provider: 'test',
    })

    // Mirrors the SearchView single-click: no `tracks` context at all.
    await h.controller.play(chosen)
    expect(state().current?.id).toBe(chosen.id)
    expect(state().queue.map((t) => t.id)).toEqual([chosen.id])
    // Discovery is seeded from the provider (artist/title), not from a search array.
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

  it('refills incrementally as the discovery queue drains, and stays bounded', async () => {
    const h = harness()
    const a = track('a')
    const pool = Array.from({ length: 40 }, (_, i) => track(`d${i}`))
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: pool, videos: [], albums: [], artists: [], provider: 'test',
    })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(8))
    // One fetch is bounded well below the full pool.
    expect(state().autoQueue.length).toBeLessThanOrEqual(20)

    // Draining one track triggers a top-up, keeping the pipeline ahead.
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(pool[0].id))
    expect(state().autoQueue.length).toBeGreaterThanOrEqual(8)
    expect(state().autoQueue.length).toBeLessThanOrEqual(20)
  })

  it('keeps playing indefinitely while autoplay is on, without immediate repeats', async () => {
    const h = harness()
    const a = track('a')
    const pool = Array.from({ length: 30 }, (_, i) => track(`d${i}`))
    const played: { track: Track; playedAt: number }[] = []
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: pool, videos: [], albums: [], artists: [], provider: 'test',
    })
    ;(h.backend.recordPlayEvent as ReturnType<typeof vi.fn>).mockImplementation(async (t: Track) => {
      played.unshift({ track: t, playedAt: Date.now() })
      return { history: played, stats: {}, disliked: [] }
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(8))
    const seen = new Set<string>([a.id])
    for (let i = 0; i < 14; i += 1) {
      h.media.endNaturally()
      await vi.waitFor(() => expect(state().status).toBe('playing'))
      const cur = state().current
      expect(cur).not.toBeNull()
      expect(seen.has(cur!.id)).toBe(false)
      seen.add(cur!.id)
    }
  })

  it('drops a late discovery response from a superseded track', async () => {
    const h = harness()
    const a = track('a')
    const b = track('b')
    const stale = track('stale')
    const fresh = track('fresh')

    let call = 0
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      call += 1
      if (call === 1) {
        // Track A's discovery request resolves long after B has taken over.
        await new Promise((r) => setTimeout(r, 60))
        return { query: '', songs: [stale], videos: [], albums: [], artists: [], provider: 'test' }
      }
      return { query: '', songs: [fresh], videos: [], albums: [], artists: [], provider: 'test' }
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    // Intentionally change track before A's discovery has resolved.
    await h.controller.play(b, { tracks: [b], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual([fresh.id]))

    // Give the stale response time to arrive; it must not pollute B's queue.
    await new Promise((r) => setTimeout(r, 80))
    expect(state().autoQueue.map((t) => t.id)).toEqual([fresh.id])
    expect(state().autoQueue.some((t) => t.id === stale.id)).toBe(false)
  })
})

describe('radio engine', () => {
  function mockRelated(h: Harness, songs: Track[], source = 'ytmusic-next'): void {
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({ tracks: songs, source })
  }

  it('prefers the dedicated related feed and never touches plain search while it answers', async () => {
    const h = harness()
    const a = track('a')
    const rel = [track('r1'), track('r2')]
    mockRelated(h, rel)
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual(['yt:r1', 'yt:r2']))
    expect(state().radioSource).toBe('ytmusic-next')
    expect(h.backend.search).not.toHaveBeenCalled()
  })

  it('falls back to identity-verified artist searches only when the related feed is empty', async () => {
    const h = harness()
    const a = track('a', { title: 'Nightfall', artist: 'Halcyon' })
    mockRelated(h, [])
    const same = track('m1', { title: 'Other Halcyon Song', artist: 'Halcyon' })
    // Songs that merely share a title with the seed must not survive the
    // fallback, no matter how prominently text search returns them.
    const sameTitle = track('t1', { title: 'Nightfall', artist: 'Taylor Swift' })
    const sameTitle2 = track('t2', { title: 'Nightfall', artist: 'Pink Floyd' })
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [sameTitle, sameTitle2, same], videos: [], albums: [], artists: [], provider: 'test',
    })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual(['yt:m1']))
    const queries = (h.backend.search as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    // Artist-anchored queries only — never the song title, never a channel name.
    expect(queries.every((q) => q.toLowerCase().includes('halcyon'))).toBe(true)
    expect(queries.some((q) => q.toLowerCase().includes('nightfall'))).toBe(false)
    // Song radio never claims to be "more from this artist" — only Artist
    // Radio gets that label.
    expect(state().radioSource).toBe('seed-song')
  })

  it('never text-searches for a channel-only seed (uploader is not an artist)', async () => {
    const h = harness()
    // The real-world failure shape: a slowed upload whose "artist" is really
    // the uploader channel. No performing artist => no fallback at all.
    const seed = track('farben', { title: 'Farben (Slowed)', artist: '', uploader: 'fearless' })
    mockRelated(h, [])
    const fearlessness = [
      track('t1', { title: 'Fearless', artist: 'Taylor Swift' }),
      track('t2', { title: 'Fearless', artist: 'Pink Floyd' }),
      track('t3', { title: 'FEARLESS', artist: 'LE SSERAFIM' }),
    ]
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: fearlessness, videos: [], albums: [], artists: [], provider: 'test',
    })
    await h.controller.play(seed, { tracks: [seed], index: 0 })
    await new Promise((r) => setTimeout(r, 40))
    expect(h.backend.search).not.toHaveBeenCalled()
    expect(state().autoQueue).toHaveLength(0)
    // The queue stays valid and untouched — nothing unrelated leaked in.
    expect(state().queue.map((t) => t.id)).toEqual([seed.id])
  })

  it('preserves the provider recommendation order when the feed answers', async () => {
    const h = harness()
    const a = track('a')
    const feed = Array.from({ length: 8 }, (_, i) => track(`r${i}`, { title: `Rec ${i}`, artist: `Artist ${i}` }))
    mockRelated(h, feed)
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue).toHaveLength(8))
    // The feed's own order is the relevance graph: no re-sorting by MELO.
    expect(state().autoQueue.map((t) => t.id)).toEqual(feed.map((t) => t.id))
  })

  it('start radio builds a fresh session: only the seed in the queue, discovery separate', async () => {
    const h = harness()
    const old = track('old')
    mockRelated(h, [track('oldrel')])
    await h.controller.play(old, { tracks: [old], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))

    const seed = track('seed', { title: 'Nuvole Bianche', artist: 'Einaudi' })
    const siblings = [track('s1'), track('s2')]
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: siblings, videos: [], albums: [], artists: [], provider: 'test',
    })
    mockRelated(h, [track('rel1'), track('rel2')])
    await h.controller.startRadio(seed)

    expect(state().current?.id).toBe(seed.id)
    expect(state().queue.map((t) => t.id)).toEqual([seed.id]) // never the search siblings
    expect(state().contextLabel).toContain('Radio')
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual(['yt:rel1', 'yt:rel2']))
    expect(state().autoQueue.some((t) => t.id === 'yt:oldrel')).toBe(false)
  })

  it('autoplays from the real feed for a channel-only seed (the Farben case)', async () => {
    const h = harness()
    const seed = track('farben', { title: 'Farben (Slowed)', artist: '', uploader: 'fearless' })
    const feed = [
      track('r1', { title: 'Nuvole Bianche', artist: 'Einaudi' }),
      track('r2', { title: 'Experience', artist: 'Einaudi' }),
      track('r3', { title: 'Farben', artist: 'Homixide' }), // shares the title, different artist
      track('r4', { title: 'Una Mattina', artist: 'Einaudi' }),
    ]
    mockRelated(h, feed, 'ytmusic-next')
    await h.controller.play(seed, { tracks: [seed], index: 0 })
    // The provider's recommendation queue fills autoplay in its own order. The
    // same-title/different-artist track is kept only because the feed
    // recommended it (never boosted by its title — see the radio unit tests,
    // where the title-collision demotion is asserted directly).
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual(feed.map((t) => t.id)))
    expect(state().radioSource).toBe('ytmusic-next')
    // …and no text search ever ran.
    expect(h.backend.search).not.toHaveBeenCalled()
  })

  it('keeps same-artist recommendations when the feed actually recommends them', async () => {
    const h = harness()
    const a = track('a', { title: 'Nuvole Bianche', artist: 'Einaudi' })
    const sameArtist = Array.from({ length: 4 }, (_, i) => track(`e${i}`, { title: `Einaudi Song ${i}`, artist: 'Einaudi' }))
    const others = Array.from({ length: 4 }, (_, i) => track(`x${i}`, { title: `Other ${i}`, artist: `Artist ${i}` }))
    mockRelated(h, [...sameArtist, ...others])
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue).toHaveLength(8))
    const picked = state().autoQueue.filter((t) => t.artist === 'Einaudi')
    expect(picked).toHaveLength(4) // all of them: familiarity is welcome
  })

  it('never recommends the current track itself, even if the feed echoes it', async () => {
    const h = harness()
    const a = track('a', { title: 'Echoed', artist: 'Artist' })
    mockRelated(h, [a, track('variant', { title: 'Echoed (Official Video)' }), track('fresh')])
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual(['yt:fresh']))
  })

  it('excludes disliked tracks from the radio batch', async () => {
    const h = harness()
    const a = track('a')
    const nope = track('nope')
    mockRelated(h, [nope, track('fresh1'), track('fresh2')])
    useLibraryStore.setState({ disliked: [nope] })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
    expect(state().autoQueue.some((t) => t.id === nope.id)).toBe(false)
  })

  it('purges a track from the current autoplay list the moment it is disliked', async () => {
    const h = harness()
    const a = track('a')
    mockRelated(h, [track('x'), track('y')])
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual(['yt:x', 'yt:y']))

    const x = state().autoQueue[0]
    ;(h.backend.setDisliked as ReturnType<typeof vi.fn>).mockResolvedValue({
      history: [], stats: {}, disliked: [x],
    })
    await library.setDisliked(x, true)
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual(['yt:y']))
  })

  it('likes nudge provider recommendations up without overriding the feed order', async () => {
    const h = harness()
    const a = track('a')
    const p0 = track('p0', { title: 'Feed Leader', artist: 'Feed Artist' })
    const p1 = track('p1', { title: 'Feed Second', artist: 'Feed Artist Two' })
    const favourite = track('p2', { title: 'Liked Song', artist: 'Fave' })
    const p3 = track('p3', { title: 'Feed Fourth', artist: 'Feed Artist Four' })
    useLibraryStore.setState({ liked: [favourite] })
    mockRelated(h, [p0, p1, favourite, p3])
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue).toHaveLength(4))
    // The liked song climbs above its direct neighbour but never above the
    // feed's own leader: taste personalizes, the provider graph decides.
    expect(state().autoQueue.map((t) => t.id)).toEqual([p0.id, favourite.id, p1.id, p3.id])
  })

  it('does not re-request discovery on ordinary playback state updates', async () => {
    const h = harness()
    const a = track('a')
    mockRelated(h, [track('r1')])
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
    const calls = (h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.length

    // Buffering, duration changes and position ticks are ordinary playback
    // noise — none of them may trigger another discovery fetch for this track.
    h.media.setDuration(120)
    h.media.dispatchEvent(new Event('progress'))
    h.media.tick(5)
    h.media.tick(11)
    h.media.tick(19)
    await new Promise((r) => setTimeout(r, 30))
    expect((h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls)
  })

  it('records the full listening event ladder: started → significant → completed', async () => {
    const h = harness()
    const a = track('a') // duration 100 → significant at 30s
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(h.recorded.filter((r) => r.event === 'play_started')).toHaveLength(1))

    h.media.tick(31) // crossed the significant threshold
    await vi.waitFor(() => expect(h.recorded.filter((r) => r.event === 'played_significantly')).toHaveLength(1))
    h.media.tick(60) // further ticks never repeat the event
    await new Promise((r) => setTimeout(r, 10))
    expect(h.recorded.filter((r) => r.event === 'played_significantly')).toHaveLength(1)

    h.media.endNaturally()
    await vi.waitFor(() => expect(h.recorded.filter((r) => r.event === 'completed')).toHaveLength(1))
  })

  it('records a skip — a weaker signal — when the user moves on before a real listen', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a, track('b')], index: 0 })
    await vi.waitFor(() => expect(h.recorded.some((r) => r.event === 'play_started')).toBe(true))
    h.media.tick(8) // under the 30s threshold
    await h.controller.next()
    expect(h.recorded.filter((r) => r.event === 'skipped')).toHaveLength(1)
    expect(h.recorded.filter((r) => r.event === 'completed')).toHaveLength(0)
  })

  it('stops after the user queue ends when autoplay is off', async () => {
    const h = harness()
    useLibraryStore.setState({ settings: { ...defaultSettings(), autoplay: false } })
    mockRelated(h, [track('r1')])
    const a = track('a')
    const b = track('b')
    await h.controller.play(a, { tracks: [a, b], index: 0 })
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(b.id))
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().status).toBe('idle'))
    expect(state().autoQueue).toHaveLength(0)
  })

  it('a new radio seed drops the previous seed\u2019s late responses', async () => {
    const h = harness()
    const stale = track('stale')
    const fresh = track('fresh')
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(async (t: Track) => {
      if (t.id === 'yt:a') {
        await new Promise((r) => setTimeout(r, 60))
        return { tracks: [stale], source: 'test' }
      }
      return { tracks: [fresh], source: 'test' }
    })
    const a = track('a')
    await h.controller.play(a, { tracks: [a], index: 0 })
    await h.controller.startRadio(track('b'))
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual([fresh.id]))
    await new Promise((r) => setTimeout(r, 90))
    expect(state().autoQueue.some((t) => t.id === stale.id)).toBe(false)
  })

  // ---------- session-aware, multi-anchor discovery ----------

  it('re-anchors discovery on the current track as the session moves on, and labels the mix', async () => {
    const h = harness()
    const a = track('a', { title: 'Anime Opening', artist: 'A Artist' })
    const b = track('b', { title: 'Phonk Drift', artist: 'B Artist' })
    const a2 = track('a2', { title: 'A Song Two', artist: 'A Artist' })
    const c1 = track('c1', { title: 'C Song One', artist: 'C Artist' })
    const c2 = track('c2', { title: 'C Song Two', artist: 'C Artist' })
    const related = new Map<string, { tracks: Track[]; source: string }>([
      ['yt:a', { tracks: [b, a2], source: 'ytmusic-next' }],
      ['yt:b', { tracks: [c1, c2], source: 'ytmusic-next' }],
    ])
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(
      async (t: Track) => related.get(t.id) ?? { tracks: [], source: '' },
    )

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual(['yt:b', 'yt:a2']))
    expect(state().radioSource).toBe('ytmusic-next') // one feed: based on this song

    // The session moves onto the provider-recommended phonk track: the next
    // batch must be anchored on IT (b's own feed), with the earlier anchor's
    // feed merged as a drift pool — no hard-coded transitions anywhere.
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe('yt:b'))
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toContain('yt:c1'))
    expect(state().autoQueue.map((t) => t.id)).toContain('yt:c2')
    expect(state().radioSource).toBe('session-mix') // several sources contributed
    const anchors = (h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as Track).id,
    )
    expect(anchors).toContain('yt:a')
    expect(anchors).toContain('yt:b')
  })

  it('a concentrated provider feed triggers broader candidate generation, not acceptance', async () => {
    const h = harness()
    // The reported failure shape: one artist flooding the whole feed.
    const names = ['CRIMINAL', 'TAKA', 'UNICO', 'STYLE', 'BPM', 'MASTER', 'CLUB', 'RARE']
    const funk = names.map((n, i) => track(`f${i}`, { title: `FUNK ${n}`, artist: 'Funk Artist' }))
    const likedAnchor = track('L', { title: 'Liked Song', artist: 'Liked Artist' })
    const others = [
      track('o1', { title: 'Other One', artist: 'Other Artist' }),
      track('o2', { title: 'Other Two', artist: 'Second Artist' }),
      track('o3', { title: 'Other Three', artist: 'Third Artist' }),
    ]
    const related = new Map<string, { tracks: Track[]; source: string }>([
      ['yt:s', { tracks: funk, source: 'ytmusic-next' }],
      ['yt:L', { tracks: others, source: 'ytmusic-next' }],
    ])
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(
      async (t: Track) => related.get(t.id) ?? { tracks: [], source: '' },
    )
    useLibraryStore.setState({ ...useLibraryStore.getState(), liked: [likedAnchor] })

    const s = track('s', { title: 'Seed Song', artist: 'Seed Artist' })
    await h.controller.play(s, { tracks: [s], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))

    // Broadening actually fired: a second anchor's feed was fetched.
    const anchors = (h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as Track).id,
    )
    expect(anchors).toContain('yt:L')
    // The queue is not the FUNK wall: alternatives are in, funk is capped.
    const funkCount = state().autoQueue.filter((t) => t.artist === 'Funk Artist').length
    const otherCount = state().autoQueue.filter((t) => t.artist !== 'Funk Artist').length
    expect(otherCount).toBeGreaterThanOrEqual(2)
    expect(funkCount).toBeLessThanOrEqual(4)
  })

  it('a cold session broadens through adjacent artists from the provider\u2019s own feed', async () => {
    const h = harness()
    // The reported Windows shape: the seed's feed is an artist wall with a
    // couple of featured/related artists at the tail.
    const wall = Array.from({ length: 6 }, (_, i) =>
      track(`f${i}`, { title: `FUNK ${i}`, artist: 'Funk Artist' }),
    )
    const featured1 = track('feat1', { title: 'Collab One', artist: 'Other Artist' })
    const featured2 = track('feat2', { title: 'Collab Two', artist: 'Second Artist' })
    // The adjacent anchor's own feed is genuinely broader: four new artists.
    const broader = Array.from({ length: 4 }, (_, i) =>
      track(`d${i}`, { title: `Broader ${i}`, artist: `Broader Artist ${i}` }),
    )
    const related = new Map<string, { tracks: Track[]; source: string }>([
      ['yt:s', { tracks: [...wall, featured1, featured2], source: 'ytmusic-next' }],
      ['yt:feat1', { tracks: broader, source: 'ytmusic-next' }],
    ])
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(
      async (t: Track) => related.get(t.id) ?? { tracks: [], source: '' },
    )

    // Cold session: no history, no likes — first song ever.
    const s = track('s', { title: 'Seed Song', artist: 'Seed Artist' })
    await h.controller.play(s, { tracks: [s], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(4))

    // The graph itself was followed: the featured artist's feed was fetched.
    const anchors = (h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as Track).id,
    )
    expect(anchors).toContain('yt:feat1')
    // The broader candidates actually contribute to the batch…
    const ids = state().autoQueue.map((t) => t.id)
    for (const d of broader) expect(ids).toContain(d.id)
    // …several distinct related artists share the queue…
    const distinctArtists = new Set(state().autoQueue.map((t) => t.artist))
    expect(distinctArtists.size).toBeGreaterThanOrEqual(4)
    // …and the wall stays capped.
    expect(state().autoQueue.filter((t) => t.artist === 'Funk Artist').length).toBeLessThanOrEqual(4)
  })

  it('only Artist Radio is labelled \u201cmore from this artist\u201d; the song fallback says \u201cbased on this song\u201d', async () => {
    const h = harness()
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({ tracks: [], source: '' })
    // The fallback text search answers with the searched artist's own songs
    // (identity verification would reject anything else anyway).
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockImplementation(async (q: string) => ({
      query: q, songs: [track('a1', { title: `Song of ${q}`, artist: String(q).split(' ')[0] })],
      videos: [], albums: [], artists: [], provider: 'test',
    }))

    // Song radio (plain play → track seed): song-context label.
    const song = track('s', { title: 'Nightfall', artist: 'Halcyon' })
    await h.controller.play(song, { tracks: [song], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
    expect(state().radioSource).toBe('seed-song')

    // Artist radio: the artist label is legitimate.
    await h.controller.startRadio(track('x', { title: 'Einaudi Song', artist: 'Einaudi' }), { kind: 'artist' })
    await vi.waitFor(() => expect(state().radioSource).toBe('seed-artist'))
  })

  it('refills continuously: every consumed anchor becomes the next primary as the queue drains', async () => {
    const h = harness()
    // A chain: each track's feed recommends the next (all distinct artists).
    const chain = Array.from({ length: 12 }, (_, i) =>
      track(`t${i}`, { title: `Chain ${i}`, artist: `Chain Artist ${i}` }),
    )
    const related = new Map<string, { tracks: Track[]; source: string }>(
      chain.map((t, i) => [t.id, { tracks: [chain[(i + 1) % chain.length]], source: 'ytmusic-next' }]),
    )
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(
      async (t: Track) => related.get(t.id) ?? { tracks: [], source: '' },
    )

    await h.controller.play(chain[0], { tracks: [chain[0]], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(1))
    const before = (h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.length
    for (let i = 0; i < 4; i += 1) {
      h.media.endNaturally()
      await vi.waitFor(() => expect(state().status).toBe('playing'))
    }
    // Each advance refilled: every consumed track became a fetch anchor.
    const calls = (h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.length
    expect(calls).toBeGreaterThan(before)
    const anchors = (h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as Track).id,
    )
    for (let i = 1; i <= 4; i += 1) expect(anchors).toContain(`yt:t${i}`)
  })

  // ---------- re-anchoring lifecycle (song radio evolves per transition) ----------

  it('re-anchors on every track transition even while the queue is full, keeping the visible upcoming list', async () => {
    const h = harness()
    const feed = (prefix: string, n: number): Track[] =>
      Array.from({ length: n }, (_, i) =>
        track(`${prefix}${i}`, { title: `${prefix.toUpperCase()} Song ${i}`, artist: `${prefix} Artist ${i}` }),
      )
    const related = new Map<string, { tracks: Track[]; source: string }>([
      ['yt:a', { tracks: feed('p', 20), source: 'ytmusic-next' }],
      ['yt:p0', { tracks: feed('q', 10), source: 'ytmusic-next' }],
      ['yt:p1', { tracks: feed('r', 10), source: 'ytmusic-next' }],
    ])
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(
      async (t: Track) => related.get(t.id) ?? { tracks: [], source: '' },
    )
    const anchorsOf = () =>
      (h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[0] as Track).id)

    // Song A: generation 1 fills the queue to the bound with one anchor.
    const a = track('a', { title: 'Song A', artist: 'A Artist' })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(20))
    expect(anchorsOf()).toEqual(['yt:a'])

    // Song B (first autoplay track) becomes current: even with 19 tracks
    // still queued, a NEW generation must run anchored on B.
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe('yt:p0'))
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toContain('yt:q0'))
    expect(anchorsOf()).toEqual(['yt:a', 'yt:p0'])
    // The visible upcoming list is preserved (not discarded): the tracks the
    // listener was about to hear still lead the queue, in order…
    expect(state().autoQueue.slice(0, 8).map((t) => t.id)).toEqual(
      Array.from({ length: 8 }, (_, i) => `yt:p${i + 1}`),
    )
    // …fresh candidates were appended behind them, and the queue stays bounded.
    expect(state().autoQueue.length).toBeLessThanOrEqual(20)
    const afterB = state().autoQueue.length

    // Song C: generation 3, anchored on C — the radio keeps evolving.
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe('yt:p1'))
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toContain('yt:r0'))
    expect(anchorsOf()).toEqual(['yt:a', 'yt:p0', 'yt:p1'])
    expect(state().autoQueue.length).toBeLessThanOrEqual(20)
    expect(state().autoQueue.length).toBeGreaterThan(0)
    void afterB

    // The play/session ladder recorded every consumed song (session context
    // updates as autoplay tracks become current).
    const played = h.recorded.filter((r) => r.event === 'play_started').map((r) => r.track.id)
    expect(played).toContain('yt:p0')
    expect(played).toContain('yt:p1')
  })

  it('ordinary playback state updates never trigger discovery requests', async () => {
    const h = harness()
    const feed = Array.from({ length: 12 }, (_, i) =>
      track(`s${i}`, { title: `Steady ${i}`, artist: `Steady Artist ${i}` }),
    )
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({
      tracks: feed, source: 'ytmusic-next',
    })
    const a = track('a', { title: 'Song A', artist: 'A Artist' })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(8))
    const callsBefore = (h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.length

    // Pause/resume, seek and volume changes are state noise, not track
    // transitions: no media reload, no new generation.
    await h.controller.pause()
    await h.controller.resume()
    h.controller.seek(30)
    h.controller.setVolume(0.5)
    await new Promise((r) => setTimeout(r, 80))
    expect((h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore)

    // But the next real transition does trigger one.
    h.media.endNaturally()
    await vi.waitFor(() => {
      const anchors = (h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => (c[0] as Track).id,
      )
      expect(anchors).toContain('yt:s0')
    })
  })

  it('keeps a short autoplay list intact across a transition (no unnecessary discards)', async () => {
    const h = harness()
    const small = Array.from({ length: 9 }, (_, i) =>
      track(`x${i}`, { title: `Small ${i}`, artist: `Small Artist ${i}` }),
    )
    const related = new Map<string, { tracks: Track[]; source: string }>([
      ['yt:a', { tracks: small, source: 'ytmusic-next' }],
      ['yt:x0', { tracks: small.slice(1), source: 'ytmusic-next' }],
      ['yt:a2', { tracks: [], source: '' }],
    ])
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(
      async (t: Track) => related.get(t.id) ?? { tracks: [], source: '' },
    )
    const a = track('a', { title: 'Song A', artist: 'A Artist' })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(9))

    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe('yt:x0'))
    await new Promise((r) => setTimeout(r, 80))
    const ids = state().autoQueue.map((t) => t.id)
    // Nothing queued was thrown away: the remaining small list survives the
    // transition in order (fresh candidates may only extend it).
    expect(ids.slice(0, 8)).toEqual(['yt:x1', 'yt:x2', 'yt:x3', 'yt:x4', 'yt:x5', 'yt:x6', 'yt:x7', 'yt:x8'])
  })

  // ---------- same-anchor invariant (the SLAVA FUNK! regression) ----------

  it('seed-song provenance: the artist text-search path is traceable end to end', async () => {
    const h = harness()
    // The Let Down (Orchestral Version) shape: /next answers only the seed
    // echo (filtered by the backend) => zero provider candidates, so the
    // last-resort artist search defines the radio.
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({ tracks: [], source: '' })
    const artistSong = (id: string, title: string): Track =>
      track(id, { title, artist: 'Alessandro Veloz', album: 'Orchestral EP', via: 'search:song', artistSrc: 'browse' })
    const impostor = track('impostor', { title: 'Let Down', artist: 'Someone Else' })
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockImplementation(async (q: string) => ({
      query: q,
      songs: q.includes('Orchestral')
        ? [artistSong('ov1', 'Let Down (Orchestral Reprise)'), impostor]
        : [artistSong('av1', 'Veloz Song One'), artistSong('av2', 'Veloz Song Two')],
      videos: [], albums: [], artists: [], provider: 'test',
    }))

    const seed = track('atvX', {
      title: 'Let Down (Orchestral Version)', artist: 'Alessandro Veloz', album: 'Orchestral EP',
    })
    await h.controller.play(seed, { tracks: [seed], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))

    // The exact queries: the seed's raw artist, then artist + album.
    const queries = (h.backend.search as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]))
    expect(queries).toEqual(['Alessandro Veloz', 'Alessandro Veloz Orchestral EP'])
    // Song radio labels itself seed-song, never "more from this artist".
    expect(state().radioSource).toBe('seed-song')
    // Only identity-verified rows survived (the same-title impostor is out)…
    expect(state().autoQueue.some((t) => t.id === 'yt:impostor')).toBe(false)
    // …and the provider's own provenance fields ride along into the queue,
    // so SEED-SOURCE CANDIDATE lines can be matched against real data.
    const withProvenance = state().autoQueue.filter((t) => t.artist === 'Alessandro Veloz')
    expect(withProvenance.length).toBeGreaterThanOrEqual(3)
    for (const t of withProvenance) {
      expect(t.via).toBe('search:song')
      expect(t.artistSrc).toBe('browse')
    }
  })

  it('does not re-fetch the same anchor when the queue is empty: a completed generation is final', async () => {
    const h = harness()
    // The Windows shape: the provider answers only the seed echo, which the
    // backend filters -> the frontend sees ZERO candidates. Channel-only
    // seed, so no artist text fallback can fire either.
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({ tracks: [], source: '' })
    const callsFor = (id: string) =>
      (h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c) => (c[0] as Track).id === id,
      ).length

    const seed = track('slava', { title: 'SLAVA FUNK! - (Slowed)', artist: '', uploader: 'Slowed Channel' })
    await h.controller.play(seed, { tracks: [seed], index: 0 })
    await new Promise((r) => setTimeout(r, 60))
    expect(callsFor('yt:slava')).toBe(1) // generation 1 ran…
    expect(state().autoQueue).toHaveLength(0) // …and honestly completed with nothing

    // The song ends ~2 minutes later: the empty queue must NOT produce a
    // second request for the SAME anchor. Playback simply stops.
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().status).toBe('idle'))
    expect(callsFor('yt:slava')).toBe(1)
    expect(state().autoQueue).toHaveLength(0)
  })

  it('bounds same-anchor retries after provider failures (no infinite loop)', async () => {
    const h = harness()
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network down'))
    ;(h.backend.search as ReturnType<typeof vi.fn>).mockResolvedValue({
      query: '', songs: [], videos: [], albums: [], artists: [], provider: 'test',
    })
    const seed = track('a', { title: 'Song A', artist: 'A Artist' })
    await h.controller.play(seed, { tracks: [seed], index: 0 })
    // Initial attempt fails, the song ends, one legitimate retry is allowed,
    // then the anchor is exhausted forever.
    await vi.waitFor(() =>
      expect((h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(1),
    )
    h.media.endNaturally()
    await vi.waitFor(() =>
      expect((h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2),
    )
    await vi.waitFor(() => expect(state().status).toBe('idle'))
    h.media.endNaturally()
    await new Promise((r) => setTimeout(r, 80))
    expect((h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2) // hard bound
  })

  it('a failed generation on a NEW anchor preserves the kept autoplay head', async () => {
    const h = harness()
    const feed = Array.from({ length: 20 }, (_, i) =>
      track(`p${i}`, { title: `P Song ${i}`, artist: `P Artist ${i}` }),
    )
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(async (t: Track) => {
      if (t.id === 'yt:a') return { tracks: feed, source: 'ytmusic-next' }
      throw new Error('provider down for this anchor')
    })
    const a = track('a', { title: 'Song A', artist: 'A Artist' })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(20))

    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe('yt:p0'))
    await new Promise((r) => setTimeout(r, 60))
    // The transition generation for p0 failed, but the visible head kept at
    // the transition is intact and usable — nothing was cleared.
    expect(state().autoQueue.map((t) => t.id).slice(0, 8)).toEqual(
      Array.from({ length: 8 }, (_, i) => `yt:p${i + 1}`),
    )
    // And the failed anchor is not hammered: playback can continue into the
    // kept queue (next transition anchors on p1).
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe('yt:p1'))
    const p0Calls = (h.backend.relatedTracks as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as Track).id === 'yt:p0',
    ).length
    expect(p0Calls).toBe(1) // initial attempt only; queue was never empty, so no retry even fired
  })

  it('the autoplay queue stays usable while a discovery generation is pending', async () => {
    const h = harness()
    const feed = Array.from({ length: 12 }, (_, i) =>
      track(`p${i}`, { title: `P Song ${i}`, artist: `P Artist ${i}` }),
    )
    const pending = new Promise<never>(() => {}) // never settles within the test
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(async (t: Track) => {
      if (t.id === 'yt:a') return { tracks: feed, source: 'ytmusic-next' }
      return pending as never
    })
    const a = track('a', { title: 'Song A', artist: 'A Artist' })
    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(12))

    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe('yt:p0')) // its generation now pends
    // The queue still advances immediately — discovery never blocks playback.
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe('yt:p1'))
    expect(state().autoQueue.length).toBeGreaterThan(0)
  })
})

describe('library feedback', () => {
  it('liking a disliked track clears the dislike', async () => {
    const h = harness()
    const a = track('a')
    useLibraryStore.setState({ disliked: [a] })
    ;(h.backend.setLiked as ReturnType<typeof vi.fn>).mockResolvedValue([a])
    ;(h.backend.setDisliked as ReturnType<typeof vi.fn>).mockResolvedValue({ history: [], stats: {}, disliked: [] })
    await library.toggleLike(a)
    expect(useLibraryStore.getState().liked.map((t) => t.id)).toEqual([a.id])
    expect(h.backend.setDisliked).toHaveBeenCalledWith(a, false)
  })

  it('disliking a liked track removes the like', async () => {
    const h = harness()
    const a = track('a')
    useLibraryStore.setState({ liked: [a] })
    ;(h.backend.setDisliked as ReturnType<typeof vi.fn>).mockResolvedValue({ history: [], stats: {}, disliked: [a] })
    ;(h.backend.setLiked as ReturnType<typeof vi.fn>).mockResolvedValue([])
    await library.setDisliked(a, true)
    expect(h.backend.setLiked).toHaveBeenCalledWith(a, false)
    expect(useLibraryStore.getState().disliked.map((t) => t.id)).toEqual([a.id])
    expect(useLibraryStore.getState().liked).toHaveLength(0)
  })
})

describe('transport controls', () => {
  it('pause and resume use the media element', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a] })
    h.controller.pause()
    expect(h.media.paused).toBe(true)
    expect(state().status).toBe('paused')
    await h.controller.resume()
    expect(h.media.paused).toBe(false)
    expect(state().status).toBe('playing')
  })

  it('seek moves the element and the published position', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a] })
    h.media.setDuration(100)
    h.controller.seek(55)
    expect(h.media.currentTime).toBe(55)
    expect(positionChannel.getPosition()).toBe(55)
  })

  it('volume, mute and speed are applied and persisted', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a] })
    h.controller.setVolume(0.3)
    expect(h.media.volume).toBeCloseTo(0.3)
    h.controller.toggleMute()
    expect(h.media.muted).toBe(true)
    h.controller.setSpeed(1.5)
    expect(h.media.playbackRate).toBe(1.5)
    expect(h.backend.saveSettings).toHaveBeenCalled()
  })

  it('speed changes do not disturb the reported position', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.play(a, { tracks: [a] })
    h.media.setDuration(100)
    h.media.tick(20)
    h.controller.setSpeed(2)
    expect(positionChannel.getPosition()).toBe(20)
  })
})

describe('session restore', () => {
  it('restores the queue without auto-resuming by default', async () => {
    const h = harness()
    const [a, b] = [track('a'), track('b')]
    await h.controller.restoreSession(
      { queue: [a, b], autoQueue: [], index: 1, position: 33, shuffle: true, repeat: 'all', speed: 1.25 },
      false,
    )
    expect(state().current?.id).toBe(b.id)
    expect(state().repeat).toBe('all')
    expect(state().shuffle).toBe(true)
    expect(positionChannel.getPosition()).toBe(33)
    expect(h.media.src).toBe('')
  })

  it('resumes playback at the saved position when asked', async () => {
    const h = harness()
    const a = track('a')
    await h.controller.restoreSession(
      { queue: [a], autoQueue: [], index: 0, position: 12, shuffle: false, repeat: 'off', speed: 1 },
      true,
    )
    expect(h.media.src).toBe('http://local/a')
    h.media.setDuration(100)
    expect(h.media.currentTime).toBe(12)
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
