import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    const loaded = adapter.load(token, 'Kx7B-XvmFtE', 12)
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
    const loaded = adapter.load(token, '9ssQKlLxBdQ')
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
    const loaded = adapter.load(token, 'J1aVXLHQRd4')
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
    const loaded = adapter.load(token, 'Kx7B-XvmFtE').then((value) => {
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
    const loaded = adapter.load(token, 'Kx7B-XvmFtE')
    await flushPromises()
    player.error(code)

    await expect(loaded).resolves.toBe(false)
    expect(adapter.snapshot()).toMatchObject({ status: 'error', error: expect.stringContaining(message) })
    expect(errors).toHaveLength(1)
  })

  it('cancels stale loads and ignores late state events from a rapid track switch', async () => {
    const { adapter, player } = await mountedAdapter()
    const firstToken = adapter.beginLoad('track:first')
    const first = adapter.load(firstToken, 'Kx7B-XvmFtE')
    await flushPromises()
    const secondToken = adapter.beginLoad('track:second')
    await expect(first).resolves.toBe(false)
    const second = adapter.load(secondToken, '9ssQKlLxBdQ')
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
    const loaded = adapter.load(token, 'Kx7B-XvmFtE', 8, false)
    await flushPromises()
    expect(player.cueVideoById).toHaveBeenCalledWith({ videoId: 'Kx7B-XvmFtE', startSeconds: 8 })
    player.state(states.CUED)
    await expect(loaded).resolves.toBe(true)
    expect(adapter.snapshot().status).toBe('paused')
  })
})
