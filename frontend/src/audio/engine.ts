/**
 * PlaybackEngine — the one and only audio transport in MELO.
 *
 * It wraps a single HTMLAudioElement, which in a Wails build is WebView2's
 * native media pipeline. The element is the authority for position, duration,
 * buffering and end-of-file; nothing in the app simulates a playback clock.
 *
 * Every load takes a generation token. Anything that arrives late (a resolver
 * result, a media event from a previous source) is discarded, so a rapid
 * A -> B -> C switch can never resurrect an older track.
 */

export type EngineStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export interface EngineSnapshot {
  status: EngineStatus
  trackId: string | null
  duration: number
  buffered: number
  error: string | null
  volume: number
  muted: boolean
  rate: number
}

export type EngineEvent =
  | { type: 'state'; snapshot: EngineSnapshot }
  | { type: 'position'; position: number; trackId: string | null }
  | { type: 'ended'; trackId: string }
  | { type: 'error'; trackId: string | null; message: string }

type Listener = (event: EngineEvent) => void

const POSITION_INTERVAL_MS = 100

function mediaErrorMessage(el: HTMLAudioElement): string {
  // Numeric MediaError codes: 1 aborted, 2 network, 3 decode, 4 unsupported.
  switch (el.error?.code) {
    case 1:
      return 'Playback was interrupted.'
    case 2:
      return 'Lost connection to the audio stream.'
    case 3:
      return 'This audio stream could not be decoded.'
    case 4:
      return 'Couldn\u2019t load this song.'
    default:
      return 'Playback failed.'
  }
}

export class PlaybackEngine {
  readonly el: HTMLAudioElement
  private listeners = new Set<Listener>()
  private generation = 0
  private trackId: string | null = null
  private status: EngineStatus = 'idle'
  private error: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPosition = -1
  /** The chosen playback rate, reapplied on every load so next tracks inherit it. */
  private rate = 1

  constructor(el?: HTMLAudioElement) {
    this.el = el ?? new Audio()
    this.el.preload = 'auto'
    // No crossOrigin: the loopback stream is same-machine and we never read
    // pixel/PCM data from it, so requiring CORS mode would only add failures.
    this.bind()
  }

  private bind(): void {
    const el = this.el
    el.addEventListener('playing', () => this.setStatus('playing'))
    el.addEventListener('pause', () => {
      if (this.status === 'playing') this.setStatus('paused')
    })
    el.addEventListener('waiting', () => {
      if (this.status === 'playing') this.setStatus('loading')
    })
    el.addEventListener('canplay', () => {
      if (this.status === 'loading' && el.paused) this.setStatus('paused')
    })
    el.addEventListener('durationchange', () => this.emitState())
    el.addEventListener('progress', () => this.emitState())
    el.addEventListener('timeupdate', () => this.emitPosition())
    el.addEventListener('seeked', () => this.emitPosition(true))
    el.addEventListener('ended', () => {
      const id = this.trackId
      if (!id) return
      this.stopTimer()
      this.setStatus('paused')
      this.emit({ type: 'ended', trackId: id })
    })
    el.addEventListener('error', () => {
      if (!this.trackId) return // src cleared on stop(): not a real failure
      this.error = mediaErrorMessage(el)
      this.setStatus('error')
      this.emit({ type: 'error', trackId: this.trackId, message: this.error })
    })
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: EngineEvent): void {
    for (const l of [...this.listeners]) l(event)
  }

  private emitState(): void {
    this.emit({ type: 'state', snapshot: this.snapshot() })
  }

  private emitPosition(force = false): void {
    const pos = this.el.currentTime
    if (!force && Math.abs(pos - this.lastPosition) < 0.02) return
    this.lastPosition = pos
    this.emit({ type: 'position', position: pos, trackId: this.trackId })
  }

  private setStatus(status: EngineStatus): void {
    if (this.status === status) return
    this.status = status
    if (status === 'playing') this.startTimer()
    else this.stopTimer()
    this.emitState()
  }

  private startTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.emitPosition(), POSITION_INTERVAL_MS)
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  snapshot(): EngineSnapshot {
    const el = this.el
    let buffered = 0
    try {
      if (el.buffered.length > 0) buffered = el.buffered.end(el.buffered.length - 1)
    } catch {
      buffered = 0
    }
    return {
      status: this.status,
      trackId: this.trackId,
      duration: Number.isFinite(el.duration) ? el.duration : 0,
      buffered,
      error: this.error,
      volume: el.volume,
      muted: el.muted,
      rate: el.playbackRate,
    }
  }

  get position(): number {
    return this.el.currentTime
  }

  get currentGeneration(): number {
    return this.generation
  }

  /**
   * beginLoad clears the current source immediately and returns the token that
   * must be presented to `load`. Call it the instant the user picks a track so
   * the previous audio stops before the new one is resolved.
   */
  beginLoad(trackId: string): number {
    this.generation += 1
    this.hardStop()
    this.trackId = trackId
    this.error = null
    this.setStatus('loading')
    this.emitPosition(true)
    return this.generation
  }

  /** Returns false when the token is stale, meaning the caller lost the race. */
  async load(token: number, url: string, startAt = 0, autoplay = true): Promise<boolean> {
    if (token !== this.generation) return false
    const el = this.el
    el.src = url
    el.load()
    // Browsers normally keep playbackRate across source changes, but the rate
    // is a player setting, not a property of the stream — reapply it so every
    // track inherits the chosen speed deterministically.
    el.playbackRate = this.rate
    if (startAt > 0) {
      const seek = () => {
        if (token !== this.generation) return
        try {
          el.currentTime = startAt
        } catch {
          /* not seekable yet; the media element will clamp on its own */
        }
      }
      el.addEventListener('loadedmetadata', seek, { once: true })
    }
    if (!autoplay) {
      this.setStatus('paused')
      return true
    }
    try {
      await el.play()
    } catch (err) {
      if (token !== this.generation) return false
      const message = err instanceof Error ? err.message : 'Playback failed.'
      this.error = message
      this.setStatus('error')
      this.emit({ type: 'error', trackId: this.trackId, message })
      return false
    }
    return token === this.generation
  }

  /** Marks the in-flight load as failed (used when the resolver errors). */
  fail(token: number, message: string): void {
    if (token !== this.generation) return
    this.error = message
    this.setStatus('error')
    this.emit({ type: 'error', trackId: this.trackId, message })
  }

  isCurrent(token: number): boolean {
    return token === this.generation
  }

  async play(): Promise<void> {
    if (!this.el.src) return
    try {
      await this.el.play()
    } catch (err) {
      this.error = err instanceof Error ? err.message : 'Playback failed.'
      this.setStatus('error')
    }
  }

  pause(): void {
    if (!this.el.src) return
    this.el.pause()
    if (this.status !== 'error') this.setStatus('paused')
  }

  /** Stop is explicit: it clears the transport but never advances the queue. */
  stop(): void {
    this.generation += 1
    this.hardStop()
    this.trackId = null
    this.error = null
    this.setStatus('idle')
    this.emitPosition(true)
  }

  private hardStop(): void {
    const el = this.el
    this.stopTimer()
    try {
      el.pause()
    } catch {
      /* element may not be ready */
    }
    el.removeAttribute('src')
    try {
      el.load() // aborts any in-flight network activity for the old track
    } catch {
      /* jsdom has no media pipeline */
    }
    this.lastPosition = -1
  }

  seek(seconds: number): void {
    if (!this.el.src) return
    const duration = Number.isFinite(this.el.duration) ? this.el.duration : Infinity
    const target = Math.max(0, Math.min(seconds, duration))
    try {
      this.el.currentTime = target
    } catch {
      return
    }
    this.emitPosition(true)
  }

  /** Restarts the current source from zero (used by Repeat One). */
  restart(): void {
    this.seek(0)
    void this.play()
  }

  setVolume(volume: number): void {
    this.el.volume = Math.max(0, Math.min(1, volume))
    this.emitState()
  }

  setMuted(muted: boolean): void {
    this.el.muted = muted
    this.emitState()
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.25, Math.min(3, rate))
    this.el.playbackRate = this.rate
    this.emitState()
  }

  dispose(): void {
    this.stopTimer()
    this.listeners.clear()
    this.hardStop()
  }
}
