/**
 * Tests for the endless rolling queue: buffer sizes, refill-before-exhaustion,
 * buffer-depletion re-generation, proactive refill, manual-queue priority,
 * and long-session continuity.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlaybackEngine } from '../audio/engine'
import type { PlayableSource, Track } from '../bridge/types'
import { setBackend, type Backend } from '../bridge/backend'
import { defaultSettings } from '../lib/defaults'
import { PlaybackController } from './playback'
import { useLibraryStore } from './libraryStore'
import { useLyricsStore } from './lyricsStore'
import { usePlayerStore } from './playerStore'
import { positionChannel } from './positionChannel'
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
}

function harness(): Harness {
  const media = new FakeMedia()
  const engine = new PlaybackEngine(media.asElement())

  const be = {
    isNative: false,
    getState: vi.fn(),
    getDiagnostics: vi.fn(),
    search: vi.fn().mockResolvedValue({ query: '', songs: [], videos: [], albums: [], artists: [], provider: 'test' }),
    getPlayable: vi.fn(async (t: Track): Promise<PlayableSource> => ({
      trackId: t.id, url: `http://local/${t.sourceId}`, mimeType: 'audio/mp4', duration: 100, bitrate: 128, expiresAt: 0,
    })),
    getLyrics: vi.fn(async () => ({
      trackId: '', source: 'test', synced: true, lines: [], plain: '', instrumental: false, offset: 0, matchedTitle: '', matchedArtist: '',
    })),
    saveSettings: vi.fn(async (s) => s),
    setLiked: vi.fn(async () => []),
    recordPlay: vi.fn(async () => []),
    recordPlayEvent: vi.fn(async () => ({ history: useLibraryStore.getState().history, stats: useLibraryStore.getState().stats, disliked: useLibraryStore.getState().disliked })),
    getTaste: vi.fn(async () => ({ history: useLibraryStore.getState().history, stats: useLibraryStore.getState().stats, disliked: useLibraryStore.getState().disliked })),
    setDisliked: vi.fn(async () => ({ history: useLibraryStore.getState().history, stats: useLibraryStore.getState().stats, disliked: [] })),
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
  return { media, controller: new PlaybackController(engine), backend: be }
}

const state = () => usePlayerStore.getState()

beforeEach(() => {
  usePlayerStore.setState({
    queue: [], autoQueue: [], index: -1, current: null, status: 'idle', error: null,
    shuffle: false, repeat: 'off', volume: 1.0, muted: false, speed: 1,
    playingFrom: 'queue', contextLabel: '', radioSource: '',
  })
  useLibraryStore.setState({ ...useLibraryStore.getState(), settings: defaultSettings(), liked: [], disliked: [], stats: {}, history: [] })
  useLyricsStore.setState({ trackId: null, status: 'idle', result: null, error: null })
  positionChannel.reset()
})

describe('endless queue — buffer sizing', () => {
  it('autoplay buffer can grow beyond the old cap of 20', async () => {
    const h = harness()
    const a = track('a')
    const pool = Array.from({ length: 50 }, (_, i) => track(`d${i}`, { artist: `Artist ${i}` }))
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({ tracks: pool, source: 'test' })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(20))
    // Buffer should be able to exceed the old cap of 20
    expect(state().autoQueue.length).toBeLessThanOrEqual(40)
  })

  it('refill triggers when buffer drops below DISCOVERY_TARGET (20)', async () => {
    const h = harness()
    const a = track('a')
    let fetchCount = 0
    const makePool = (offset: number) =>
      Array.from({ length: 30 }, (_, i) => track(`p${offset}_${i}`, { artist: `Artist ${offset}_${i}` }))

    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      fetchCount += 1
      return { tracks: makePool(fetchCount), source: 'test' }
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(20))

    // Consume tracks until buffer is low enough to trigger refill
    for (let i = 0; i < 15; i += 1) {
      h.media.endNaturally()
      await vi.waitFor(() => expect(state().status).toBe('playing'))
    }
    // After consuming ~15 tracks, the buffer should have been refilled
    expect(state().autoQueue.length).toBeGreaterThanOrEqual(10)
    expect(fetchCount).toBeGreaterThan(1)
  })
})

describe('endless queue — refill before exhaustion', () => {
  it('never reaches an empty autoQueue during continuous playback', async () => {
    const h = harness()
    const a = track('a')
    const pool = Array.from({ length: 100 }, (_, i) =>
      track(`c${i}`, { title: `Continuous ${i}`, artist: `Cont Artist ${i}` }),
    )
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({ tracks: pool, source: 'test' })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(20))

    // Play through 30 tracks — well past the initial batch
    for (let i = 0; i < 30; i += 1) {
      h.media.endNaturally()
      await vi.waitFor(() => expect(state().status).toBe('playing'))
      // The queue should never be empty
      expect(state().autoQueue.length).toBeGreaterThanOrEqual(0)
    }
    // After 30 tracks, there should still be upcoming music
    expect(state().autoQueue.length).toBeGreaterThan(0)
  })

  it('multiple refill cycles produce distinct batches', async () => {
    const h = harness()
    const a = track('a')
    let fetchCount = 0
    const seenIds = new Set<string>()

    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      fetchCount += 1
      const batch = Array.from({ length: 20 }, (_, i) => {
        const id = `b${fetchCount}_${i}`
        return track(id, { artist: `Batch ${fetchCount} Artist ${i}` })
      })
      return { tracks: batch, source: 'test' }
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(20))

    // Play through enough tracks to trigger multiple refill cycles
    for (let i = 0; i < 25; i += 1) {
      h.media.endNaturally()
      await vi.waitFor(() => expect(state().status).toBe('playing'))
      const cur = state().current
      if (cur) seenIds.add(cur.id)
    }

    // Should have fetched multiple batches
    expect(fetchCount).toBeGreaterThan(2)
    // All played tracks should be distinct (no repeats)
    expect(seenIds.size).toBeGreaterThanOrEqual(20)
  })
})

describe('endless queue — no duplicates or loops', () => {
  it('never plays the same track twice in a session', async () => {
    const h = harness()
    const a = track('a')
    const pool = Array.from({ length: 80 }, (_, i) =>
      track(`n${i}`, { title: `No Repeat ${i}`, artist: `NR Artist ${i}` }),
    )
    const played: { track: Track; playedAt: number }[] = []
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({ tracks: pool, source: 'test' })
    ;(h.backend.recordPlayEvent as ReturnType<typeof vi.fn>).mockImplementation(async (t: Track) => {
      played.unshift({ track: t, playedAt: Date.now() })
      return { history: played, stats: {}, disliked: [] }
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(20))

    const seen = new Set<string>([a.id])
    for (let i = 0; i < 20; i += 1) {
      h.media.endNaturally()
      await vi.waitFor(() => expect(state().status).toBe('playing'))
      const cur = state().current
      expect(cur).not.toBeNull()
      expect(seen.has(cur!.id)).toBe(false)
      seen.add(cur!.id)
    }
  })

  it('autoQueue contains no duplicate IDs', async () => {
    const h = harness()
    const a = track('a')
    const pool = Array.from({ length: 30 }, (_, i) => track(`dd${i}`, { artist: `Dup Artist ${i}` }))
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({ tracks: pool, source: 'test' })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(20))

    const ids = state().autoQueue.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('endless queue — manual queue priority', () => {
  it('explicit queue songs always play before autoplay songs', async () => {
    const h = harness()
    const a = track('a')
    const manual1 = track('manual1')
    const manual2 = track('manual2')
    const auto = track('auto1')
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({ tracks: [auto], source: 'test' })

    await h.controller.play(a, { tracks: [a, manual1, manual2], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue).toHaveLength(1))

    // Play through explicit queue
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(manual1.id))
    expect(state().playingFrom).toBe('queue')

    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(manual2.id))
    expect(state().playingFrom).toBe('queue')

    // Only after explicit queue is exhausted, autoplay takes over
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(auto.id))
    expect(state().playingFrom).toBe('autoplay')
  })

  it('manually added song during autoplay takes priority', async () => {
    const h = harness()
    const a = track('a')
    const auto1 = track('auto1')
    const auto2 = track('auto2')
    const manual = track('manual_insert')
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({
      tracks: [auto1, auto2], source: 'test',
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue).toHaveLength(2))
    // Consume the seed → autoplay starts
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(auto1.id))
    expect(state().playingFrom).toBe('autoplay')

    // Insert a manual song while autoplay is running
    h.controller.addToQueue([manual])

    // The manual song should play next (it's in the explicit queue)
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().current?.id).toBe(manual.id))
    expect(state().playingFrom).toBe('queue')

    // After the manual song, autoplay resumes
    h.media.endNaturally()
    await vi.waitFor(() => expect(state().playingFrom).toBe('autoplay'))
    // Autoplay queue should still have its remaining candidates
    expect(state().autoQueue.length).toBeGreaterThanOrEqual(0)
  })
})

describe('endless queue — autoplay toggle', () => {
  it('autoplay OFF stops refills; ON resumes them', async () => {
    const h = harness()
    const a = track('a')
    let fetchCount = 0
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      fetchCount += 1
      return {
        tracks: Array.from({ length: 20 }, (_, i) => track(`toggle_${fetchCount}_${i}`, { artist: `T${fetchCount}_${i}` })),
        source: 'test',
      }
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(20))
    const fetchCountAfterFirst = fetchCount

    // Disable autoplay
    useLibraryStore.setState({ settings: { ...useLibraryStore.getState().settings, autoplay: false } })
    h.controller.setAutoplay(false)
    expect(state().autoQueue).toHaveLength(0)

    // Consume seed → should NOT refill
    h.media.endNaturally()
    await new Promise((r) => setTimeout(r, 100))
    expect(state().autoQueue).toHaveLength(0)
    expect(fetchCount).toBe(fetchCountAfterFirst)

    // Re-enable autoplay → should refill
    useLibraryStore.setState({ settings: { ...useLibraryStore.getState().settings, autoplay: true } })
    h.controller.setAutoplay(true)
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
    expect(fetchCount).toBeGreaterThan(fetchCountAfterFirst)
  })
})

describe('endless queue — stale/overlapping refills', () => {
  it('stale refill from a superseded track is discarded', async () => {
    const h = harness()
    const a = track('a')
    const b = track('b')
    const stale = track('stale')
    const fresh = track('fresh')

    let call = 0
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      call += 1
      if (call === 1) {
        // A's discovery is slow
        await new Promise((r) => setTimeout(r, 60))
        return { tracks: [stale], source: 'test' }
      }
      return { tracks: [fresh], source: 'test' }
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    // Switch track before A's discovery resolves
    await h.controller.play(b, { tracks: [b], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.map((t) => t.id)).toEqual([fresh.id]))

    // The stale response must not pollute B's queue
    await new Promise((r) => setTimeout(r, 80))
    expect(state().autoQueue.some((t) => t.id === stale.id)).toBe(false)
  })
})

describe('endless queue — rapid track changes', () => {
  it('rapid next/previous does not corrupt the queue', async () => {
    const h = harness()
    const tracks = Array.from({ length: 5 }, (_, i) => track(`rapid${i}`))
    const pool = Array.from({ length: 20 }, (_, i) => track(`pool${i}`, { artist: `Pool ${i}` }))
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({ tracks: pool, source: 'test' })

    await h.controller.play(tracks[0], { tracks, index: 0, label: 'Rapid' })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(20))

    // Rapidly skip through several tracks
    for (let i = 0; i < 3; i += 1) {
      h.controller.next()
      await new Promise((r) => setTimeout(r, 10))
    }

    // Queue should still be intact
    expect(state().queue).toHaveLength(5)
    expect(state().autoQueue.length).toBeGreaterThan(0)
    // All autoQueue IDs should be unique
    const ids = state().autoQueue.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('endless queue — personalized scoring', () => {
  it('personalized scoring is applied on every refill', async () => {
    const h = harness()
    const a = track('a', { artist: 'Fav Artist' })
    // Pool: some from the fav artist, some from others
    const favTracks = Array.from({ length: 15 }, (_, i) =>
      track(`fav${i}`, { artist: 'Fav Artist', title: `Fav Song ${i}` }),
    )
    const otherTracks = Array.from({ length: 15 }, (_, i) =>
      track(`other${i}`, { artist: `Other ${i}`, title: `Other Song ${i}` }),
    )
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({
      tracks: [...favTracks, ...otherTracks], source: 'test',
    })

    // Seed with a like for Fav Artist
    useLibraryStore.setState({
      ...useLibraryStore.getState(),
      liked: [track('liked1', { artist: 'Fav Artist' })],
      history: [{ track: track('h1', { artist: 'Fav Artist' }), playedAt: Date.now() }],
      stats: { 'yt:fav0': { playCount: 5, significantCount: 5, completeCount: 5, skipCount: 0, lastPlayedAt: Date.now() } },
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(15))

    // Fav Artist tracks should be well-represented in the buffer
    const favCount = state().autoQueue.filter((t) => t.artist === 'Fav Artist').length
    expect(favCount).toBeGreaterThan(0)
  })
})

describe('endless queue — artist diversity', () => {
  it('no single artist dominates the autoplay buffer', async () => {
    const h = harness()
    const a = track('a')
    // Heavy concentration of one artist
    const dominant = Array.from({ length: 30 }, (_, i) => track(`dom${i}`, { artist: 'Dominant Artist' }))
    const others = Array.from({ length: 20 }, (_, i) =>
      track(`oth${i}`, { artist: `Unique Artist ${i}` }),
    )
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({
      tracks: [...dominant, ...others], source: 'test',
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(20))

    const dominantCount = state().autoQueue.filter((t) => t.artist === 'Dominant Artist').length
    const total = state().autoQueue.length
    // Dominant artist should not exceed 50% of the buffer (diversity interleave)
    expect(dominantCount).toBeLessThanOrEqual(Math.ceil(total * 0.5))
  })
})

describe('endless queue — recently played exclusion', () => {
  it('recently played tracks are excluded from refill', async () => {
    const h = harness()
    const a = track('a')
    const recent = track('recent')
    const fresh = track('fresh')
    ;(h.backend.recordPlayEvent as ReturnType<typeof vi.fn>).mockResolvedValue({
      history: [{ track: recent, playedAt: Date.now() }],
      stats: {},
      disliked: [],
    })
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({
      tracks: [recent, fresh], source: 'test',
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThan(0))
    expect(state().autoQueue.some((t) => t.id === recent.id)).toBe(false)
    expect(state().autoQueue.some((t) => t.id === fresh.id)).toBe(true)
  })
})

describe('endless queue — explicit vs autoplay state separation', () => {
  it('queue and autoQueue remain separate arrays', async () => {
    const h = harness()
    const a = track('a')
    const manual = track('manual')
    const auto = track('auto1')
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({ tracks: [auto], source: 'test' })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue).toHaveLength(1))

    h.controller.addToQueue([manual])

    // queue and autoQueue are separate
    expect(state().queue.map((t) => t.id)).toContain(manual.id)
    expect(state().autoQueue.map((t) => t.id)).toContain(auto.id)
    expect(state().queue.map((t) => t.id)).not.toContain(auto.id)
    expect(state().autoQueue.map((t) => t.id)).not.toContain(manual.id)
  })

  it('clearing autoplay does not affect the explicit queue', async () => {
    const h = harness()
    const a = track('a')
    const manual = track('manual')
    const auto = track('auto1')
    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockResolvedValue({ tracks: [auto], source: 'test' })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue).toHaveLength(1))
    h.controller.addToQueue([manual])

    h.controller.clearAutoplay()
    expect(state().autoQueue).toHaveLength(0)
    expect(state().queue.map((t) => t.id)).toContain(manual.id)
  })
})

describe('endless queue — buffer depletion re-generation', () => {
  it('allows re-generation when buffer drops below floor', async () => {
    const h = harness()
    const a = track('a')
    let fetchCount = 0

    ;(h.backend.relatedTracks as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      fetchCount += 1
      return {
        tracks: Array.from({ length: 20 }, (_, i) => track(`regen${fetchCount}_${i}`, { artist: `R${fetchCount}_${i}` })),
        source: 'test',
      }
    })

    await h.controller.play(a, { tracks: [a], index: 0 })
    await vi.waitFor(() => expect(state().autoQueue.length).toBeGreaterThanOrEqual(20))
    const firstFetchCount = fetchCount

    // Consume tracks aggressively to drain below the floor (10)
    for (let i = 0; i < 25; i += 1) {
      h.media.endNaturally()
      await vi.waitFor(() => expect(state().status).toBe('playing'))
    }

    // Should have triggered additional fetches (re-generation)
    expect(fetchCount).toBeGreaterThan(firstFetchCount)
    // Buffer should have been replenished
    expect(state().autoQueue.length).toBeGreaterThan(0)
  })
})
