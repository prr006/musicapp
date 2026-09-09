import type { PlaybackAdapter } from './adapter'
import type { EngineEvent, EngineSnapshot, EngineStatus } from './engine'

type Listener = (event: EngineEvent) => void

export const YOUTUBE_IFRAME_EVENT_MAP = {
  '-1': 'loading',
  '0': 'ended',
  '1': 'playing',
  '2': 'paused',
  '3': 'loading',
  '5': 'cued',
  onAutoplayBlocked: 'autoplay-blocked',
  onError: 'error',
} as const

interface YTPlayerState {
  UNSTARTED: -1
  ENDED: 0
  PLAYING: 1
  PAUSED: 2
  BUFFERING: 3
  CUED: 5
}

interface YTVideoData {
  video_id?: string
}

interface YTPlayer {
  loadVideoById(options: { videoId: string; startSeconds?: number }): void
  cueVideoById(options: { videoId: string; startSeconds?: number }): void
  playVideo(): void
  pauseVideo(): void
  stopVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  setVolume(volume: number): void
  getVolume(): number
  mute(): void
  unMute(): void
  isMuted(): boolean
  setPlaybackRate(rate: number): void
  getPlaybackRate(): number
  getCurrentTime(): number
  getDuration(): number
  getVideoLoadedFraction(): number
  getVideoData(): YTVideoData
  destroy(): void
}

interface YTPlayerEvent {
  target: YTPlayer
  data: number
}

interface YTPlayerOptions {
  width: string | number
  height: string | number
  videoId?: string
  playerVars: Record<string, string | number>
  events: {
    onReady(event: YTPlayerEvent): void
    onStateChange(event: YTPlayerEvent): void
    onError(event: YTPlayerEvent): void
    onPlaybackRateChange(event: YTPlayerEvent): void
    onPlaybackQualityChange(event: YTPlayerEvent): void
    onApiChange(): void
    onAutoplayBlocked(): void
  }
}

export interface YTNamespace {
  Player: new (element: HTMLElement, options: YTPlayerOptions) => YTPlayer
  PlayerState: YTPlayerState
}

interface YTWindow extends Window {
  YT?: YTNamespace
  onYouTubeIframeAPIReady?: () => void
}

const PLAY_START_TIMEOUT_MS = 30_000
const POSITION_INTERVAL_MS = 250
let apiPromise: Promise<YTNamespace> | null = null

function loadYouTubeIframeAPI(): Promise<YTNamespace> {
  const current = (window as YTWindow).YT
  if (current?.Player) return Promise.resolve(current)
  if (apiPromise) return apiPromise

  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const ytWindow = window as YTWindow
    const previous = ytWindow.onYouTubeIframeAPIReady
    ytWindow.onYouTubeIframeAPIReady = () => {
      previous?.()
      if (ytWindow.YT?.Player) resolve(ytWindow.YT)
      else reject(new Error('The YouTube player API did not initialize.'))
    }

    const existing = document.querySelector<HTMLScriptElement>('script[data-melo-youtube-iframe-api]')
    if (existing) {
      existing.addEventListener('error', () => reject(new Error('Could not load the YouTube player API.')), { once: true })
      return
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.dataset.meloYoutubeIframeApi = 'true'
    script.addEventListener('error', () => reject(new Error('Could not load the YouTube player API.')), { once: true })
    document.head.appendChild(script)
  })
  return apiPromise
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

function embedErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return 'YouTube rejected this video ID.'
    case 5:
      return 'YouTube could not play this video in an HTML5 player.'
    case 100:
      return 'This YouTube video is private, removed, or unavailable.'
    case 101:
    case 150:
      return 'The owner does not allow this video to be embedded.'
    case 153:
      return 'YouTube could not identify the embedding site. Check the origin and referrer policy.'
    default:
      return `YouTube playback failed (error ${code}).`
  }
}

interface PendingLoad {
  token: number
  autoplay: boolean
  resolve(value: boolean): void
  timer: ReturnType<typeof setTimeout> | null
}

/**
 * Spike-only web transport backed by one visible official YT.Player. The queue
 * controller remains authoritative; this adapter translates provider events to
 * the existing MELO engine event model.
 */
export class YouTubeIframePlaybackAdapter implements PlaybackAdapter {
  readonly sourceMode = 'youtube-video-id' as const
  private listeners = new Set<Listener>()
  private generation = 0
  private mountGeneration = 0
  private player: YTPlayer | null = null
  private playerPromise: Promise<YTPlayer> | null = null
  private host: HTMLElement | null = null
  private trackId: string | null = null
  private videoId: string | null = null
  private status: EngineStatus = 'idle'
  private error: string | null = null
  private volume = 1
  private muted = false
  private rate = 1
  private position = 0
  private duration = 0
  private buffered = 0
  private positionTimer: ReturnType<typeof setInterval> | null = null
  private pending: PendingLoad | null = null
  private endedForCycle = false

  constructor(private readonly loadAPI: () => Promise<YTNamespace> = loadYouTubeIframeAPI) {}

  /** Called by the visible React surface. The host is never hidden or detached while in use. */
  mount(host: HTMLElement): () => void {
    if (this.host === host && this.playerPromise) return () => this.unmount(host)
    this.unmount(this.host)
    this.host = host
    host.replaceChildren()
    const target = document.createElement('div')
    target.className = 'youtube-iframe-target'
    host.appendChild(target)
    const mountToken = ++this.mountGeneration

    this.playerPromise = this.loadAPI().then((yt) => new Promise<YTPlayer>((resolve, reject) => {
      if (mountToken !== this.mountGeneration || this.host !== host) {
        reject(new Error('YouTube player mount was superseded.'))
        return
      }
      new yt.Player(target, {
        width: '100%',
        height: '100%',
        playerVars: {
          playsinline: 1,
          controls: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: (event) => {
            if (mountToken !== this.mountGeneration || this.host !== host) {
              event.target.destroy()
              reject(new Error('YouTube player mount was superseded.'))
              return
            }
            this.player = event.target
            this.applySettings()
            resolve(event.target)
          },
          onStateChange: (event) => this.onPlayerState(event.data, yt.PlayerState),
          onError: (event) => this.onPlayerError(event.data),
          onPlaybackRateChange: (event) => {
            this.rate = Math.max(0.25, Math.min(2, finite(event.data, this.rate)))
            this.emitState()
          },
          // Quality and API-module changes have no counterpart in MELO's
          // transport state. They are intentionally observed as no-ops.
          onPlaybackQualityChange: () => {},
          onApiChange: () => {},
          onAutoplayBlocked: () => this.onAutoplayBlocked(),
        },
      })
    }))
    // React StrictMode intentionally mounts twice in development. Consume the
    // superseded mount rejection; active loads still receive real API failures.
    void this.playerPromise.catch(() => {})
    return () => this.unmount(host)
  }

  private unmount(host: HTMLElement | null): void {
    if (!host || this.host !== host) return
    this.mountGeneration += 1
    this.cancelPending()
    this.stopPositionTimer()
    try {
      this.player?.destroy()
    } catch {
      // The API may already have removed a superseded iframe.
    }
    this.player = null
    this.playerPromise = null
    this.host = null
    host.replaceChildren()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event)
  }

  private setStatus(status: EngineStatus): void {
    if (this.status === status) return
    this.status = status
    if (status === 'playing') this.startPositionTimer()
    else this.stopPositionTimer()
    this.emit({ type: 'state', snapshot: this.snapshot() })
  }

  private emitState(): void {
    this.emit({ type: 'state', snapshot: this.snapshot() })
  }

  private updatePosition(force = false): void {
    if (this.player) {
      this.position = finite(this.player.getCurrentTime())
      this.duration = finite(this.player.getDuration(), this.duration)
      this.buffered = this.duration * Math.max(0, Math.min(1, finite(this.player.getVideoLoadedFraction())))
    }
    if (force || this.status === 'playing') {
      this.emit({ type: 'position', position: this.position, trackId: this.trackId })
    }
  }

  private startPositionTimer(): void {
    if (this.positionTimer) return
    this.updatePosition(true)
    this.positionTimer = setInterval(() => this.updatePosition(), POSITION_INTERVAL_MS)
  }

  private stopPositionTimer(): void {
    if (!this.positionTimer) return
    clearInterval(this.positionTimer)
    this.positionTimer = null
  }

  private playerEventMatchesCurrent(): boolean {
    const eventVideoId = this.player?.getVideoData().video_id
    return !eventVideoId || !this.videoId || eventVideoId === this.videoId
  }

  private onPlayerState(state: number, states: YTPlayerState): void {
    if (!this.trackId || !this.playerEventMatchesCurrent()) return
    this.updatePosition(true)
    switch (state) {
      case states.UNSTARTED:
      case states.BUFFERING:
        this.setStatus('loading')
        break
      case states.PLAYING:
        this.error = null
        this.endedForCycle = false
        this.setStatus('playing')
        this.completePending(true)
        break
      case states.PAUSED:
        this.setStatus('paused')
        break
      case states.CUED:
        if (this.pending && !this.pending.autoplay) {
          this.setStatus('paused')
          this.completePending(true)
        }
        break
      case states.ENDED: {
        if (this.endedForCycle) break
        this.endedForCycle = true
        const trackId = this.trackId
        this.setStatus('paused')
        this.emit({ type: 'ended', trackId })
        break
      }
      default:
        break
    }
  }

  private onAutoplayBlocked(): void {
    if (!this.trackId) return
    if (this.pending?.timer) {
      clearTimeout(this.pending.timer)
      this.pending.timer = null
    }
    this.setStatus('paused')
    this.emit({ type: 'autoplay-blocked', trackId: this.trackId })
    // Keep the load pending. Clicking the visible native player can still emit
    // PLAYING and complete the existing transactional track selection.
  }

  private onPlayerError(code: number): void {
    if (!this.trackId || !this.playerEventMatchesCurrent()) return
    const message = embedErrorMessage(code)
    this.error = message
    this.setStatus('error')
    this.completePending(false)
    this.emit({ type: 'error', trackId: this.trackId, message, recoverable: false })
  }

  private applySettings(): void {
    if (!this.player) return
    this.player.setVolume(Math.round(this.volume * 100))
    if (this.muted) this.player.mute()
    else this.player.unMute()
    this.player.setPlaybackRate(this.rate)
  }

  private cancelPending(): void {
    if (!this.pending) return
    if (this.pending.timer) clearTimeout(this.pending.timer)
    this.pending.resolve(false)
    this.pending = null
  }

  private completePending(value: boolean): void {
    if (!this.pending) return
    const pending = this.pending
    this.pending = null
    if (pending.timer) clearTimeout(pending.timer)
    pending.resolve(value)
  }

  snapshot(): EngineSnapshot {
    return {
      status: this.status,
      trackId: this.trackId,
      duration: this.duration,
      buffered: this.buffered,
      error: this.error,
      volume: this.volume,
      muted: this.muted,
      rate: this.rate,
    }
  }

  get currentGeneration(): number {
    return this.generation
  }

  beginLoad(trackId: string): number {
    this.generation += 1
    this.cancelPending()
    this.stopPositionTimer()
    this.trackId = null
    this.videoId = null
    try {
      this.player?.stopVideo()
    } catch {
      // The iframe may still be initializing.
    }
    this.trackId = trackId
    this.endedForCycle = false
    this.position = 0
    this.duration = 0
    this.buffered = 0
    this.error = null
    this.setStatus('loading')
    this.updatePosition(true)
    return this.generation
  }

  async load(token: number, videoId: string, startAt = 0, autoplay = true): Promise<boolean> {
    if (!this.isCurrent(token)) return false
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      this.error = 'YouTube rejected this video ID.'
      return false
    }
    const playerPromise = this.playerPromise
    if (!playerPromise) {
      this.error = 'The visible YouTube player is not mounted.'
      return false
    }
    let player = this.player
    if (!player) {
      try {
        player = await playerPromise
      } catch (error) {
        if (!this.isCurrent(token)) return false
        this.error = error instanceof Error ? error.message : 'Could not initialize YouTube playback.'
        this.setStatus('error')
        return false
      }
    }
    if (!this.isCurrent(token)) return false

    this.videoId = videoId
    this.error = null
    const result = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending || this.pending.token !== token) return
        this.error = autoplay
          ? 'YouTube playback did not start. Use the visible player to allow playback.'
          : 'YouTube did not cue this video.'
        this.setStatus('error')
        this.completePending(false)
      }, PLAY_START_TIMEOUT_MS)
      this.pending = { token, autoplay, resolve, timer }
    })

    if (autoplay) player.loadVideoById({ videoId, startSeconds: Math.max(0, startAt) })
    else player.cueVideoById({ videoId, startSeconds: Math.max(0, startAt) })
    return result
  }

  fail(token: number, message: string): void {
    if (!this.isCurrent(token)) return
    this.error = message
    this.setStatus('error')
  }

  isCurrent(token: number): boolean {
    return token === this.generation
  }

  async play(): Promise<void> {
    this.player?.playVideo()
  }

  pause(): void {
    this.player?.pauseVideo()
  }

  stop(): void {
    this.generation += 1
    this.cancelPending()
    this.stopPositionTimer()
    this.trackId = null
    this.videoId = null
    this.endedForCycle = false
    try {
      this.player?.stopVideo()
    } catch {
      // The iframe may already be gone.
    }
    this.position = 0
    this.duration = 0
    this.buffered = 0
    this.error = null
    this.setStatus('idle')
    this.updatePosition(true)
  }

  seek(seconds: number): void {
    const target = Math.max(0, Math.min(seconds, this.duration || Number.POSITIVE_INFINITY))
    this.player?.seekTo(target, true)
    this.position = target
    this.updatePosition(true)
  }

  restart(): void {
    this.seek(0)
    void this.play()
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    this.player?.setVolume(Math.round(this.volume * 100))
    this.emitState()
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    if (muted) this.player?.mute()
    else this.player?.unMute()
    this.emitState()
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.25, Math.min(2, rate))
    this.player?.setPlaybackRate(this.rate)
    this.emitState()
  }

  dispose(): void {
    this.unmount(this.host)
    this.listeners.clear()
  }
}

export function youtubeIframeSpikeEnabled(): boolean {
  if (typeof window === 'undefined') return false
  const wails = (window as unknown as { go?: { main?: { App?: unknown } } }).go?.main?.App
  if (wails) return false
  const requested = new URLSearchParams(window.location.search).get('player')
  return requested === 'youtube' || import.meta.env.VITE_MELO_YOUTUBE_IFRAME_SPIKE === '1'
}

export function createYouTubeIframeAdapter(): YouTubeIframePlaybackAdapter {
  return new YouTubeIframePlaybackAdapter()
}

export function isYouTubeIframeAdapter(adapter: PlaybackAdapter): adapter is YouTubeIframePlaybackAdapter {
  return adapter.sourceMode === 'youtube-video-id'
}
