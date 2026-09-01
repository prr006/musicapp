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
  recorded: Track[]
  lyricsDelays: Map<string, number>
}

function harness(): Harness {
  const media = new FakeMedia()
  const engine = new PlaybackEngine(media.asElement())
  const resolveDelays = new Map<string, number>()
  const resolveErrors = new Map<string, string>()
  const lyricsDelays = new Map<string, number>()
  const recorded: Track[] = []

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
      recorded.push(t)
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
    playingFrom: 'queue', contextLabel: '',
  })
  useLibraryStore.setState({ ...useLibraryStore.getState(), settings: defaultSettings(), liked: [], history: [] })
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
    ;(h.backend.recordPlay as ReturnType<typeof vi.fn>).mockResolvedValue([
      { track: dup, playedAt: Date.now() },
    ])
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
    ;(h.backend.recordPlay as ReturnType<typeof vi.fn>).mockImplementation(async (t: Track) => {
      played.unshift({ track: t, playedAt: Date.now() })
      return played
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
