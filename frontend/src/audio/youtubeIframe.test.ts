import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setBackend, type Backend } from '../bridge/backend'
import type { Track } from '../bridge/types'
import { defaultSettings } from '../lib/defaults'
import { useLibraryStore } from '../state/libraryStore'
import { useLyricsStore } from '../state/lyricsStore'
import { PlaybackController } from '../state/playback'
import { usePlayerStore } from '../state/playerStore'
import { positionChannel } from '../state/positionChannel'
import { useUIStore } from '../state/uiStore'
import type { EngineEvent } from './engine'
import { YouTubeIframePlaybackAdapter, type YTNamespace } from './youtubeIframe'

const states = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const

type PlayerOptions = ConstructorParameters<YTNamespace['Player']>[1]

class FakePlayer {
  static latest: FakePlayer
  options: PlayerOptions
  videoId = ''
  currentTime = 0
  duration = 240
  loadedFraction = 0.5
  volume = 100
  muted = false
  rate = 1
  loadVideoById = vi.fn((options: { videoId: string; startSeconds?: number }) => {
    this.videoId = options.videoId
    this.currentTime = options.startSeconds ?? 0
  })
  cueVideoById = vi.fn((options: { videoId: string; startSeconds?: number }) => {
    this.videoId = options.videoId
    this.currentTime = options.startSeconds ?? 0
  })
  playVideo = vi.fn()
  pauseVideo = vi.fn()
  stopVideo = vi.fn()
  seekTo = vi.fn((seconds: number) => { this.currentTime = seconds })
  setVolume = vi.fn((volume: number) => { this.volume = volume })
  getVolume = vi.fn(() => this.volume)
  mute = vi.fn(() => { this.muted = true })
  unMute = vi.fn(() => { this.muted = false })
  isMuted = vi.fn(() => this.muted)
  setPlaybackRate = vi.fn((rate: number) => { this.rate = rate })
  getPlaybackRate = vi.fn(() => this.rate)
  getCurrentTime = vi.fn(() => this.currentTime)
  getDuration = vi.fn(() => this.duration)
  getVideoLoadedFraction = vi.fn(() => this.loadedFraction)
  getVideoData = vi.fn(() => ({ video_id: this.videoId }))
  destroy = vi.fn()

  constructor(_element: HTMLElement, options: PlayerOptions) {
    FakePlayer.latest = this
    this.options = options
    queueMicrotask(() => options.events.onReady({ target: this, data: 0 }))
  }

  state(value: number): void {
    this.options.events.onStateChange({ target: this, data: value })
  }

  error(code: number): void {
    this.options.events.onError({ target: this, data: code })
  }

  rateChanged(rate: number): void {
    this.options.events.onPlaybackRateChange({ target: this, data: rate })
  }

  autoplayBlocked(): void {
    this.options.events.onAutoplayBlocked()
  }
}

const fakeAPI: YTNamespace = {
  Player: FakePlayer as unknown as YTNamespace['Player'],
  PlayerState: states,
}

function track(sourceId: string, extra: Partial<Track> = {}): Track {
  return {
    id: `yt:${sourceId}`, sourceId, source: 'youtube', url: '', title: sourceId,
    artist: 'Artist', album: 'Album', artwork: '', duration: 240, explicit: false,
    ...extra,
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

async function mountedAdapter() {
  const adapter = new YouTubeIframePlaybackAdapter(async () => fakeAPI)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const unmount = adapter.mount(host)
  await Promise.resolve()
  await Promise.resolve()
  return { adapter, host, player: FakePlayer.latest, unmount }
}

function queueBackend(radioTracks: Track[]): Backend {
  return {
    isNative: false,
    getState: vi.fn(),
    getDiagnostics: vi.fn(),
    search: vi.fn().mockResolvedValue({ query: '', songs: [], videos: [], albums: [], artists: [], provider: 'test' }),
    radio: vi.fn(async (_kind, seedId) => ({
      id: 'iframe-radio', kind: 'song', seedId, tracks: radioTracks, generatedAt: Date.now(),
    })),
    getPlayable: vi.fn().mockRejectedValue(new Error('resolver must not be called by the IFrame adapter')),
    getLyrics: vi.fn(async ({ trackId }) => ({
      trackId, source: 'test', synced: false, lines: [], plain: '', instrumental: false,
      offset: 0, matchedTitle: '', matchedArtist: '',
    })),
    saveSettings: vi.fn(async (settings) => settings),
    setLiked: vi.fn(async () => []),
    recordPlay: vi.fn(async () => []),
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
}

describe('YouTubeIframePlaybackAdapter', () => {
  beforeEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('mounts one visible-player target and maps load, buffering, playing, pause and position', async () => {
    const { adapter, host, player } = await mountedAdapter()
    const events: EngineEvent[] = []
    adapter.subscribe((event) => events.push(event))

    const token = adapter.beginLoad('track:believer')
    const loaded = adapter.load(token, track('Kx7B-XvmFtE'), 12)
    await flushPromises()
    expect(player.loadVideoById).toHaveBeenCalledWith({ videoId: 'Kx7B-XvmFtE', startSeconds: 12 })
    expect(host.querySelector('.youtube-iframe-target')).not.toBeNull()

    player.state(states.BUFFERING)
    expect(adapter.snapshot().status).toBe('loading')
    player.state(states.PLAYING)
    await expect(loaded).resolves.toBe(true)
    expect(adapter.snapshot()).toMatchObject({ status: 'playing', trackId: 'track:believer', duration: 240, buffered: 120 })

    player.currentTime = 36
    player.state(states.PAUSED)
    expect(adapter.snapshot().status).toBe('paused')
    expect(events).toContainEqual({ type: 'position', position: 36, trackId: 'track:believer' })
  })

  it('maps play, pause, seek, volume, mute and playback rate to YT.Player', async () => {
    const { adapter, player } = await mountedAdapter()
    const token = adapter.beginLoad('track:thunder')
    const loaded = adapter.load(token, track('9ssQKlLxBdQ'))
    await flushPromises()
    player.state(states.PLAYING)
    await loaded

    await adapter.play()
    adapter.pause()
    adapter.seek(73)
    adapter.setVolume(0.42)
    adapter.setMuted(true)
    adapter.setRate(1.5)

    expect(player.playVideo).toHaveBeenCalled()
    expect(player.pauseVideo).toHaveBeenCalled()
    expect(player.seekTo).toHaveBeenCalledWith(73, true)
    expect(player.setVolume).toHaveBeenLastCalledWith(42)
    expect(player.mute).toHaveBeenCalled()
    expect(player.setPlaybackRate).toHaveBeenLastCalledWith(1.5)
    expect(adapter.snapshot()).toMatchObject({ volume: 0.42, muted: true, rate: 1.5 })
    player.rateChanged(1.25)
    expect(adapter.snapshot().rate).toBe(1.25)
  })

  it('emits natural ended exactly once until playback begins a new cycle', async () => {
    const { adapter, player } = await mountedAdapter()
    const ended = vi.fn()
    adapter.subscribe((event) => {
      if (event.type === 'ended') ended(event.trackId)
    })
    const token = adapter.beginLoad('track:demons')
    const loaded = adapter.load(token, track('J1aVXLHQRd4'))
    await flushPromises()
    player.state(states.PLAYING)
    await loaded

    player.state(states.ENDED)
    player.state(states.ENDED)
    expect(ended).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledWith('track:demons')

    adapter.restart()
    player.state(states.PLAYING)
    player.state(states.ENDED)
    expect(ended).toHaveBeenCalledTimes(2)
  })

  it('keeps an autoplay-blocked load provisional until native player interaction starts it', async () => {
    const { adapter, player } = await mountedAdapter()
    const events: EngineEvent[] = []
    adapter.subscribe((event) => events.push(event))
    const token = adapter.beginLoad('track:believer')
    let settled = false
    const loaded = adapter.load(token, track('Kx7B-XvmFtE')).then((value) => {
      settled = true
      return value
    })
    await flushPromises()

    player.autoplayBlocked()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(adapter.snapshot().status).toBe('paused')
    expect(events).toContainEqual({ type: 'autoplay-blocked', trackId: 'track:believer' })

    player.state(states.PLAYING)
    await expect(loaded).resolves.toBe(true)
  })

  it.each([
    [2, 'rejected this video ID'],
    [5, 'HTML5 player'],
    [100, 'private, removed, or unavailable'],
    [101, 'does not allow this video to be embedded'],
    [150, 'does not allow this video to be embedded'],
    [153, 'origin and referrer policy'],
  ])('maps YouTube error %i to a sanitized failed load', async (code, message) => {
    const { adapter, player } = await mountedAdapter()
    const errors: EngineEvent[] = []
    adapter.subscribe((event) => {
      if (event.type === 'error') errors.push(event)
    })
    const token = adapter.beginLoad('track:error')
    const loaded = adapter.load(token, track('Kx7B-XvmFtE'))
    await flushPromises()
    player.error(code)

    await expect(loaded).resolves.toBe(false)
    expect(adapter.snapshot()).toMatchObject({ status: 'error', error: expect.stringContaining(message) })
    expect(errors).toHaveLength(1)
  })

  it('cancels stale loads and ignores late state events from a rapid track switch', async () => {
    const { adapter, player } = await mountedAdapter()
    const firstToken = adapter.beginLoad('track:first')
    const first = adapter.load(firstToken, track('Kx7B-XvmFtE'))
    await flushPromises()
    const secondToken = adapter.beginLoad('track:second')
    await expect(first).resolves.toBe(false)
    const second = adapter.load(secondToken, track('9ssQKlLxBdQ'))
    await flushPromises()

    player.videoId = 'Kx7B-XvmFtE'
    player.state(states.PLAYING)
    expect(adapter.snapshot().status).toBe('loading')

    player.videoId = '9ssQKlLxBdQ'
    player.state(states.PLAYING)
    await expect(second).resolves.toBe(true)
    expect(adapter.snapshot()).toMatchObject({ status: 'playing', trackId: 'track:second' })
  })

  it('cues without autoplay and commits only after CUED', async () => {
    const { adapter, player } = await mountedAdapter()
    const token = adapter.beginLoad('track:cued')
    const loaded = adapter.load(token, track('Kx7B-XvmFtE'), 8, false)
    await flushPromises()
    expect(player.cueVideoById).toHaveBeenCalledWith({ videoId: 'Kx7B-XvmFtE', startSeconds: 8 })
    player.state(states.CUED)
    await expect(loaded).resolves.toBe(true)
    expect(adapter.snapshot().status).toBe('paused')
  })

  it('keeps the canonical queue and fake YT.Player aligned through a realistic mutable flow', async () => {
    const { adapter, player } = await mountedAdapter()
    const seed = track('Kx7B-XvmFtE', { title: 'Believer' })
    const thunder = track('9ssQKlLxBdQ', { title: 'Thunder' })
    const demons = track('J1aVXLHQRd4', { title: 'Demons' })
    const radioactive = track('3Yb2-CWjrME', { title: 'Radioactive' })
    const later = track('n5lmg1MX_sE', { title: 'Believer Remix' })
    const radioTracks = [
      radioactive,
      track('gOsM-DYAEhY', { title: 'Whatever It Takes' }),
      track('0I647GU3Jsc', { title: 'Natural' }),
      track('I-QfPUz1es8', { title: 'Bad Liar' }),
      track('TO-_3tck2tg', { title: 'Bones' }),
      track('D9G1VOjN_84', { title: 'Enemy' }),
      track('7j7twuejxvU', { title: 'Sharks' }),
      track('w5tWYmIOWGk', { title: 'On Top of the World' }),
      track('k3zimSRKqNw', { title: 'Follow You' }),
    ]
    const be = queueBackend(radioTracks)
    setBackend(be)
    usePlayerStore.setState({
      queue: [], autoQueue: [], index: -1, current: null, status: 'idle', error: null,
      shuffle: false, repeat: 'off', volume: 0.9, muted: false, speed: 1,
      playingFrom: 'queue', contextLabel: '', sleepTimerEndsAt: null,
    })
    useLibraryStore.setState({
      ...useLibraryStore.getState(), settings: { ...defaultSettings(), autoplay: false },
      liked: [], history: [], ready: true, loadError: null,
    })
    useLyricsStore.setState({ trackId: null, status: 'idle', result: null, error: null })
    useUIStore.setState({ toasts: [] })
    positionChannel.reset()
    const controller = new PlaybackController(adapter)
    const state = () => usePlayerStore.getState()
    const expectPlayerMatchesUI = () => {
      expect(state().current?.sourceId).toBe(player.videoId)
    }
    const confirm = async (action: Promise<void>, expected: Track) => {
      await vi.waitFor(() => expect(player.videoId).toBe(expected.sourceId))
      // The queue/current transaction is still provisional until provider PLAYING.
      player.state(states.PLAYING)
      await action
      await vi.waitFor(() => expect(state().current?.id).toBe(expected.id))
      expectPlayerMatchesUI()
    }

    try {
      await confirm(controller.play(seed), seed)
      controller.addToQueue([thunder, demons, radioactive])
      expect(state().current?.id).toBe(seed.id)
      expectPlayerMatchesUI()

      await confirm(controller.next(), thunder)
      expect(state()).toMatchObject({ index: 1, playingFrom: 'queue' })

      player.state(states.ENDED)
      player.state(states.ENDED)
      await vi.waitFor(() => expect(player.videoId).toBe(demons.sourceId))
      // A duplicate old ENDED cannot skip the newly loading track.
      expect(state().current?.id).toBe(thunder.id)
      player.state(states.PLAYING)
      await vi.waitFor(() => expect(state().current?.id).toBe(demons.id))
      expect(state().index).toBe(2)
      expectPlayerMatchesUI()

      controller.removeFromQueue(3)
      controller.addToQueue([later])
      expect(state().current?.id).toBe(demons.id)
      expect(state().queue.map((candidate) => candidate.id)).toEqual([seed.id, thunder.id, demons.id, later.id])
      expectPlayerMatchesUI()
      controller.clearUpcoming()

      useLibraryStore.setState({ settings: { ...defaultSettings(), autoplay: true } })
      await confirm(controller.startRadio('song', seed.sourceId, seed), radioTracks[0])
      expect(state().playingFrom).toBe('autoplay')
      for (const expected of radioTracks.slice(1, 4)) {
        player.state(states.ENDED)
        await confirm(Promise.resolve(), expected)
      }

      const beforeMutation = state().current
      controller.removeFromAutoQueue(1)
      controller.addToQueue([later])
      expect(state().current).toEqual(beforeMutation)
      expectPlayerMatchesUI()

      player.state(states.ENDED)
      await confirm(Promise.resolve(), later)
      expect(state().playingFrom).toBe('queue')

      const unavailable = track('YI1XZfBTWGc', { title: 'Unavailable embed' })
      const fallback = track('6I2y_UbVz4U', { title: 'Fallback candidate' })
      controller.addToQueue([unavailable, fallback])
      player.state(states.ENDED)
      await vi.waitFor(() => expect(player.videoId).toBe(unavailable.sourceId))
      player.error(101)
      await vi.waitFor(() => expect(player.videoId).toBe(fallback.sourceId))
      player.state(states.PLAYING)
      await vi.waitFor(() => expect(state().current?.id).toBe(fallback.id))
      expect(state().queue.map((candidate) => candidate.id)).not.toContain(unavailable.id)
      expectPlayerMatchesUI()

      controller.setRepeat('one')
      player.currentTime = 42
      player.state(states.ENDED)
      expect(player.seekTo).toHaveBeenLastCalledWith(0, true)
      expect(player.playVideo).toHaveBeenCalled()
      player.state(states.ENDED)
      expect(state().current?.id).toBe(fallback.id)
      player.state(states.PLAYING)
      expectPlayerMatchesUI()

      const rapidA = track('ktvTqknDobU', { title: 'Rapid A' })
      const rapidB = track('D9G1VOjN_84', { title: 'Rapid B' })
      const first = controller.play(rapidA)
      const second = controller.play(rapidB)
      await expect(first).resolves.toBeUndefined()
      await confirm(second, rapidB)
      expect(be.getPlayable).not.toHaveBeenCalled()
    } finally {
      adapter.dispose()
    }
  })
})
