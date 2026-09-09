import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../bridge/types'
import { YouTubeIframeAdapter, type YTNamespace, type YTPlayer } from './youtubeAdapter'

function track(id: string): Track {
  return {
    id: `yt:${id}`,
    sourceId: id,
    source: 'youtube',
    url: `https://www.youtube.com/watch?v=${id}`,
    title: `Song ${id}`,
    artist: 'Artist',
    album: '',
    artwork: '',
    duration: 180,
    explicit: false,
  }
}

/**
 * A faithful stand-in for the YT.Player the IFrame API creates. It records
 * every command and lets tests fire the same events the real player emits.
 */
class FakeYTPlayer implements YTPlayer {
  static instances: FakeYTPlayer[] = []
  element: HTMLElement
  options: Record<string, unknown>
  videoId: string | null = null
  loadCalls: { videoId: string; startSeconds?: number }[] = []
  playCalls = 0
  pauseCalls = 0
  seekCalls: { seconds: number; allowSeekAhead: boolean }[] = []
  volumeCalls: number[] = []
  muteCalls = 0
  unMuteCalls = 0
  rateCalls: number[] = []
  destroyed = false
  currentTime = 0
  loadedFraction = 0
  duration = 0
  availableRates = [0.5, 1, 1.25, 1.5, 2]

  constructor(element: HTMLElement, options: Record<string, unknown>) {
    this.element = element
    this.options = options
    this.videoId = (options.videoId as string) ?? null
    FakeYTPlayer.instances.push(this)
  }

  private handler(name: string): (event: { data: number }) => void {
    return (this.options.events as Record<string, (e: { data: number }) => void>)[name]
  }

  ready(): void {
    this.duration = 180
    this.handler('onReady')({ data: 0 })
  }

  state(data: number): void {
    this.handler('onStateChange')({ data })
  }

  error(code: number): void {
    this.handler('onError')({ data: code })
  }

  playVideo(): void {
    this.playCalls += 1
  }

  pauseVideo(): void {
    this.pauseCalls += 1
  }

  stopVideo(): void {}

  seekTo(seconds: number, allowSeekAhead: boolean): void {
    this.seekCalls.push({ seconds, allowSeekAhead })
    this.currentTime = seconds
  }

  loadVideoById(options: { videoId: string; startSeconds?: number }): void {
    this.loadCalls.push(options)
    this.videoId = options.videoId
  }

  setVolume(volume: number): void {
    this.volumeCalls.push(volume)
  }

  mute(): void {
    this.muteCalls += 1
  }

  unMute(): void {
    this.unMuteCalls += 1
  }

  setPlaybackRate(rate: number): void {
    this.rateCalls.push(rate)
  }

  getDuration(): number {
    return this.duration
  }

  getCurrentTime(): number {
    return this.currentTime
  }

  getVideoLoadedFraction(): number {
    return this.loadedFraction
  }

  getAvailablePlaybackRates(): number[] {
    return this.availableRates
  }

  destroy(): void {
    this.destroyed = true
    this.element.remove()
  }
}

function makeApi(): YTNamespace {
  return {
    Player: FakeYTPlayer as unknown as YTNamespace['Player'],
    PlayerState: {},
  }
}

describe('YouTubeIframeAdapter', () => {
  let adapter: YouTubeIframeAdapter
  let api: YTNamespace

  beforeEach(() => {
    FakeYTPlayer.instances = []
    api = makeApi()
    adapter = new YouTubeIframeAdapter(api)
  })

  afterEach(() => {
    adapter.dispose()
    document.body.innerHTML = ''
  })

  it('plays a track by its YouTube video id, reusing one player', async () => {
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    expect(FakeYTPlayer.instances).toHaveLength(1)
    const player = FakeYTPlayer.instances[0]
    expect(player.videoId).toBe('a')
    player.ready()
    expect(player.options.videoId).toBe('a')

    // Second track: same player, loadVideoById.
    const token2 = adapter.beginLoad('yt:b')
    await adapter.load(token2, track('b'))
    expect(FakeYTPlayer.instances).toHaveLength(1)
    expect(player.loadCalls).toEqual([{ videoId: 'b', startSeconds: 0 }])
  })

  it('creates a compliant, always-visible stage of at least 200×200', async () => {
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    const stage = adapter.videoSurface
    expect(stage).not.toBeNull()
    expect(stage!.parentElement).toBe(document.body)
    expect(stage!.style.minWidth).toBe('200px')
    expect(stage!.style.minHeight).toBe('200px')
    const width = Number.parseFloat(stage!.style.width)
    const height = Number.parseFloat(stage!.style.height)
    expect(width).toBeGreaterThanOrEqual(200)
    expect(height).toBeGreaterThanOrEqual(200)
    // Never hidden, never off-screen, never display:none while a track plays.
    expect(stage!.style.display).not.toBe('none')
    expect(stage!.style.visibility).not.toBe('hidden')
    expect(stage!.style.position).toBe('fixed')
    const left = Number.parseFloat(stage!.style.left)
    const top = Number.parseFloat(stage!.style.top)
    expect(Number.isNaN(left) || left >= 0).toBe(true)
    expect(Number.isNaN(top) || top >= 0).toBe(true)
  })

  it('exposes no video surface before anything is loaded', () => {
    expect(adapter.videoSurface).toBeNull()
  })

  it('maps player states to transport states and emits ended once', async () => {
    const ended: string[] = []
    adapter.subscribe((e) => {
      if (e.type === 'ended') ended.push(e.trackId)
    })
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    const player = FakeYTPlayer.instances[0]
    player.ready()
    player.state(1) // PLAYING
    expect(adapter.snapshot().status).toBe('playing')
    player.state(2) // PAUSED
    expect(adapter.snapshot().status).toBe('paused')
    player.state(0) // ENDED
    expect(ended).toEqual(['yt:a'])
    expect(adapter.snapshot().status).toBe('paused')
    player.state(0) // a duplicate ENDED must not double-advance
    expect(ended).toEqual(['yt:a'])
  })

  it('maps embed errors to actionable messages', async () => {
    const errors: string[] = []
    adapter.subscribe((e) => {
      if (e.type === 'error') errors.push(e.message)
    })
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    const player = FakeYTPlayer.instances[0]
    player.ready()
    player.error(101) // embedding disabled
    expect(errors[0]).toMatch(/outside YouTube/i)
    expect(adapter.snapshot().status).toBe('error')
  })

  it('refuses a stale load token', async () => {
    const stale = adapter.beginLoad('yt:a')
    const fresh = adapter.beginLoad('yt:b')
    const okStale = await adapter.load(stale, track('a'))
    expect(okStale).toBe(false)
    await adapter.load(fresh, track('b'))
    expect(FakeYTPlayer.instances[0].videoId).toBe('b')
  })

  it('applies volume (0-100), mute and clamped rate once ready', async () => {
    adapter.setVolume(0.4)
    adapter.setMuted(true)
    adapter.setRate(1.1)
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    const player = FakeYTPlayer.instances[0]
    player.ready()
    expect(player.volumeCalls[0]).toBe(40)
    expect(player.muteCalls).toBe(1)
    // 1.1 is not an available rate; the nearest (1) is used.
    expect(player.rateCalls[0]).toBe(1)
  })

  it('seek clamps to the known duration', async () => {
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    const player = FakeYTPlayer.instances[0]
    player.ready()
    adapter.seek(9999)
    expect(player.seekCalls[player.seekCalls.length - 1].seconds).toBe(180)
  })

  it('stop destroys the player and its stage — no hidden idle player remains', async () => {
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    const player = FakeYTPlayer.instances[0]
    player.ready()
    const stage = adapter.videoSurface
    adapter.stop()
    expect(player.destroyed).toBe(true)
    expect(adapter.videoSurface).toBeNull()
    expect(document.body.contains(stage)).toBe(false)
  })

  it('reports duration and buffered fraction from the player', async () => {
    const token = adapter.beginLoad('yt:a')
    await adapter.load(token, track('a'))
    const player = FakeYTPlayer.instances[0]
    player.ready()
    player.state(1)
    player.duration = 240
    player.loadedFraction = 0.5
    await vi.waitFor(() => expect(adapter.snapshot().duration).toBe(240))
    expect(adapter.snapshot().buffered).toBeCloseTo(120)
  })
})
