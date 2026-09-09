/**
 * YouTubeIframeAdapter — MELO's production playback provider.
 *
 * It drives the official YouTube IFrame Player API (embedded player) through
 * the same PlaybackAdapter contract used by every other provider:
 *
 *   Queue / PlaybackController  →  PlaybackAdapter  →  YouTube IFrame
 *
 * Nothing extracts, resolves or proxies media. The controller hands over a
 * Track; this adapter plays the YouTube video it identifies via the official
 * embeddable player, and reports transport state back exactly like the other
 * adapters do. This is the only file that knows the IFrame API exists.
 *
 * Presentation: the adapter owns one persistent stage node (`.yt-stage`,
 * appended to document.body, always at least 200×200px and always on-screen
 * while a track is loaded). The UI docks that node into the Now Playing
 * artwork slot — the player is never hidden, shrunk to nothing, moved
 * off-screen or covered, and it is never re-created on route changes (which
 * would reload the video). `stop()` destroys the player entirely, so no
 * player exists at all when nothing is loaded.
 */
import { ADAPTER_MIN_SURFACE, type PlaybackAdapter, type PlaybackEvent, type PlaybackSnapshot, type PlaybackStatus } from './adapter'
import type { Track } from '../bridge/types'

type Listener = (event: PlaybackEvent) => void

/** Official YT.PlayerState values. */
const YT_UNSTARTED = -1
const YT_ENDED = 0
const YT_PLAYING = 1
const YT_PAUSED = 2
const YT_BUFFERING = 3
const YT_CUED = 5

const POSITION_INTERVAL_MS = 250
const API_TIMEOUT_MS = 20_000
/** The embedded player's documented minimum viewport is 200×200. */
const STAGE_MIN = ADAPTER_MIN_SURFACE
/** Dock fallback used before the UI positions the stage: bottom-right. */
const STAGE_DEFAULT_SIZE = 216

export interface YTPlayer {
  playVideo(): void
  pauseVideo(): void
  stopVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  loadVideoById(options: { videoId: string; startSeconds?: number }): void
  setVolume(volume: number): void
  mute(): void
  unMute(): void
  setPlaybackRate(rate: number): void
  getDuration(): number
  getCurrentTime(): number
  getVideoLoadedFraction(): number
  getAvailablePlaybackRates(): number[]
  destroy(): void
}

export interface YTNamespace {
  Player: new (
    element: HTMLElement | string,
    options: Record<string, unknown>,
  ) => YTPlayer
  PlayerState: Record<string, number>
}

interface YTWindow {
  YT?: YTNamespace
  onYouTubeIframeAPIReady?: () => void
}

function ytWindow(): YTWindow {
  return window as unknown as YTWindow
}

let apiPromise: Promise<YTNamespace> | null = null

/** Loads the IFrame API once; resolves as soon as window.YT.Player exists. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise
  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const w = ytWindow()
    if (w.YT?.Player) {
      resolve(w.YT)
      return
    }
    const timer = setTimeout(() => {
      apiPromise = null
      reject(new Error('The YouTube player took too long to load.'))
    }, API_TIMEOUT_MS)
    const done = () => {
      if (w.YT?.Player) {
        clearTimeout(timer)
        resolve(w.YT)
      }
    }
    // The API calls this global when it is ready; preserve any existing hook.
    const previous = w.onYouTubeIframeAPIReady
    w.onYouTubeIframeAPIReady = () => {
      previous?.()
      done()
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.onerror = () => {
      clearTimeout(timer)
      apiPromise = null
      reject(new Error('The YouTube player could not be loaded.'))
    }
    document.head.appendChild(script)
    // Some blockers let the script tag fail silently; poll as a fallback.
    const poll = setInterval(() => {
      if (w.YT?.Player) {
        clearInterval(poll)
        done()
      }
    }, 100)
    setTimeout(() => clearInterval(poll), API_TIMEOUT_MS)
  })
  return apiPromise
}

function embedErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return 'This song can’t be played here.'
    case 5:
      return 'The YouTube player had a problem with this song.'
    case 100:
      return 'This song is no longer available.'
    case 101:
    case 150:
      return 'This song can’t be played outside YouTube — skipping it.'
    default:
      return 'Playback failed.'
  }
}

/** Rates the embedded player supports; used when the API won't enumerate. */
const FALLBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

export class YouTubeIframeAdapter implements PlaybackAdapter {
  readonly kind = 'youtube' as const
  private listeners = new Set<Listener>()
  private generation = 0
  private trackId: string | null = null
  private status: PlaybackStatus = 'idle'
  private error: string | null = null
  private player: YTPlayer | null = null
  private playerReady = false
  private stage: HTMLDivElement | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPosition = -1
  private duration = 0
  private volume = 0.9
  private muted = false
  private rate = 1
  private wantedAutoplay = true
  /** Generation for which ENDED was already emitted (dedupe replays). */
  private endedGen = -1

  constructor(api: YTNamespace | null = null) {
    if (api) this.pendingApi = Promise.resolve(api)
  }

  private pendingApi: Promise<YTNamespace> | null = null

  /** The dockable visual surface; null when no player has been created. */
  get videoSurface(): HTMLElement | null {
    return this.stage
  }

  private ensureStage(): HTMLDivElement {
    if (this.stage) return this.stage
    const stage = document.createElement('div')
    stage.className = 'yt-stage'
    stage.setAttribute('data-melo-player', 'youtube')
    stage.setAttribute('role', 'region')
    stage.setAttribute('aria-label', 'YouTube player')
    // Compliant presentation defaults: always visible, always ≥ 200×200,
    // parked bottom-right until the UI docks it into Now Playing.
    Object.assign(stage.style, {
      position: 'fixed',
      right: '20px',
      bottom: `${STAGE_DEFAULT_SIZE + 48}px`,
      width: `${STAGE_DEFAULT_SIZE}px`,
      height: `${STAGE_DEFAULT_SIZE}px`,
      minWidth: `${STAGE_MIN}px`,
      minHeight: `${STAGE_MIN}px`,
      zIndex: '75',
      overflow: 'hidden',
      borderRadius: '14px',
      background: 'var(--surface-3, #14141a)',
      boxShadow: 'var(--shadow-3, 0 12px 32px rgba(0,0,0,.45))',
      transition: 'left 220ms ease, top 220ms ease, width 220ms ease, height 220ms ease',
    })
    document.body.appendChild(stage)
    this.stage = stage
    return stage
  }

  private api(): Promise<YTNamespace> {
    if (!this.pendingApi) this.pendingApi = loadYouTubeApi()
    return this.pendingApi
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: PlaybackEvent): void {
    for (const l of [...this.listeners]) l(event)
  }

  private emitState(): void {
    this.emit({ type: 'state', snapshot: this.snapshot() })
  }

  private emitPosition(force = false): void {
    if (!this.player || !this.playerReady) return
    const pos = this.player.getCurrentTime()
    if (!force && Math.abs(pos - this.lastPosition) < 0.02) return
    this.lastPosition = pos
    this.emit({ type: 'position', position: pos, trackId: this.trackId })
  }

  private setStatus(status: PlaybackStatus): void {
    if (this.status === status) return
    this.status = status
    if (status === 'playing') this.startTimer()
    else this.stopTimer()
    this.emitState()
  }

  private startTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.emitPosition()
      this.pollDuration()
    }, POSITION_INTERVAL_MS)
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** Duration is only known once the player has loaded the video. */
  private pollDuration(): void {
    if (!this.player || !this.playerReady) return
    const d = this.player.getDuration()
    if (Number.isFinite(d) && d > 0 && Math.abs(d - this.duration) > 0.5) {
      this.duration = d
      this.emitState()
    }
  }

  snapshot(): PlaybackSnapshot {
    let buffered = 0
    try {
      if (this.player && this.playerReady && this.duration > 0) {
        buffered = this.player.getVideoLoadedFraction() * this.duration
      }
    } catch {
      buffered = 0
    }
    return {
      status: this.status,
      trackId: this.trackId,
      duration: this.duration,
      buffered,
      error: this.error,
      volume: this.volume,
      muted: this.muted,
      rate: this.rate,
    }
  }

  get position(): number {
    try {
      return this.player && this.playerReady ? this.player.getCurrentTime() : 0
    } catch {
      return 0
    }
  }

  get currentGeneration(): number {
    return this.generation
  }

  beginLoad(trackId: string): number {
    this.generation += 1
    this.stopTimer()
    if (this.player && this.playerReady) {
      try {
        this.player.pauseVideo()
      } catch {
        /* player may be mid-teardown */
      }
    }
    this.trackId = trackId
    this.error = null
    this.duration = 0
    this.lastPosition = -1
    this.setStatus('loading')
    this.emitPosition(true)
    return this.generation
  }

  async load(token: number, track: Track, startAt = 0, autoplay = true): Promise<boolean> {
    if (token !== this.generation) return false
    const videoId = track.sourceId
    if (!videoId) {
      this.fail(token, 'This track has no playable source.')
      return false
    }
    this.wantedAutoplay = autoplay
    let api: YTNamespace
    try {
      api = await this.api()
    } catch (err) {
      this.fail(token, err instanceof Error ? err.message : 'The YouTube player could not be loaded.')
      return false
    }
    if (token !== this.generation) return false

    if (!this.player) {
      const stage = this.ensureStage()
      const mount = document.createElement('div')
      stage.appendChild(mount)
      this.player = new api.Player(mount, {
        width: '100%',
        height: '100%',
        videoId,
        playerVars: {
          autoplay: autoplay ? 1 : 0,
          controls: 0, // MELO's own transport is the player UI
          rel: 0,
          playsinline: 1,
          enablejsapi: 1,
          disablekb: 1,
          iv_load_policy: 3,
          modestbranding: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: () => {
            this.playerReady = true
            this.applyVolumeState()
            this.applyRate()
            if (startAt > 0) this.seek(startAt)
            if (this.wantedAutoplay && token === this.generation) this.play()
            this.pollDuration()
            this.emitState()
          },
          onStateChange: (event: { data: number }) => this.onPlayerState(event.data),
          onError: (event: { data: number }) => {
            if (!this.trackId) return
            const message = embedErrorMessage(event.data)
            this.error = message
            this.setStatus('error')
            this.emit({ type: 'error', trackId: this.trackId, message })
          },
        },
      })
      return true
    }

    this.player.loadVideoById({ videoId, startSeconds: startAt > 0 ? startAt : 0 })
    if (!autoplay) {
      // loadVideoById autoplays by default; pause as soon as it starts.
      setTimeout(() => {
        if (token === this.generation && this.player && this.playerReady) {
          try {
            this.player.pauseVideo()
          } catch {
            /* not ready yet */
          }
        }
      }, 60)
    }
    return true
  }

  private onPlayerState(state: number): void {
    switch (state) {
      case YT_PLAYING:
        this.setStatus('playing')
        this.pollDuration()
        break
      case YT_PAUSED:
        this.setStatus('paused')
        break
      case YT_BUFFERING:
        if (this.status !== 'idle') this.setStatus('loading')
        break
      case YT_CUED:
        if (this.status === 'loading') this.setStatus('paused')
        break
      case YT_ENDED: {
        if (this.endedGen === this.generation) break
        this.endedGen = this.generation
        const id = this.trackId
        this.stopTimer()
        this.setStatus('paused')
        if (id) this.emit({ type: 'ended', trackId: id })
        break
      }
      case YT_UNSTARTED:
      default:
        break
    }
  }

  fail(token: number, message: string): void {
    if (token !== this.generation) return
    this.error = message
    this.setStatus('error')
    this.emit({ type: 'error', trackId: this.trackId, message })
  }

  isCurrent(token: number): boolean {
    return token === this.generation
  }

  private applyVolumeState(): void {
    if (!this.player || !this.playerReady) return
    try {
      this.player.setVolume(Math.round(this.volume * 100))
      if (this.muted) this.player.mute()
      else this.player.unMute()
    } catch {
      /* player may not accept commands yet */
    }
  }

  private applyRate(): void {
    if (!this.player || !this.playerReady) return
    let rates: number[] = FALLBACK_RATES
    try {
      const available = this.player.getAvailablePlaybackRates()
      if (Array.isArray(available) && available.length > 0) rates = available
    } catch {
      /* keep fallback */
    }
    const clamped = rates.reduce((best, r) =>
      Math.abs(r - this.rate) < Math.abs(best - this.rate) ? r : best, rates[0])
    try {
      this.player.setPlaybackRate(clamped)
    } catch {
      /* player may not accept commands yet */
    }
  }

  async play(): Promise<void> {
    if (!this.player) return
    try {
      this.player.playVideo()
    } catch {
      /* not ready; onReady will start it */
    }
  }

  pause(): void {
    if (!this.player) return
    try {
      this.player.pauseVideo()
    } catch {
      /* not ready */
    }
    if (this.status !== 'error') this.setStatus('paused')
  }

  /**
   * Stop is explicit: it clears the transport but never advances the queue.
   * The embedded player is destroyed so no hidden, idle player remains —
   * while a player exists it is always visible.
   */
  stop(): void {
    this.generation += 1
    this.stopTimer()
    this.destroyPlayer()
    this.trackId = null
    this.error = null
    this.duration = 0
    this.lastPosition = -1
    this.setStatus('idle')
    this.emitPosition(true)
  }

  private destroyPlayer(): void {
    if (this.player) {
      try {
        this.player.destroy()
      } catch {
        /* iframe may already be gone */
      }
      this.player = null
      this.playerReady = false
    }
    if (this.stage) {
      this.stage.remove()
      this.stage = null
    }
  }

  seek(seconds: number): void {
    if (!this.player || !this.playerReady) return
    const duration = this.duration > 0 ? this.duration : Infinity
    const target = Math.max(0, Math.min(seconds, duration))
    try {
      this.player.seekTo(target, true)
    } catch {
      return
    }
    this.emitPosition(true)
  }

  restart(): void {
    this.seek(0)
    void this.play()
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    this.applyVolumeState()
    this.emitState()
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.applyVolumeState()
    this.emitState()
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.25, Math.min(3, rate))
    this.applyRate()
    this.emitState()
  }

  dispose(): void {
    this.stopTimer()
    this.listeners.clear()
    this.destroyPlayer()
  }
}
