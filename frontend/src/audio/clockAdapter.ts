/**
 * ClockAdapter — an offline browser transport (no audio, no fake video).
 *
 * Browser deployments sometimes run where YouTube cannot be reached (CI,
 * sandboxes, offline machines). Rather than faking a YouTube player, this
 * adapter simulates the *transport* honestly: no audio, no fake video
 * surface — a clock that advances while "playing" and ends at the track's
 * duration. It exercises exactly the same controller, queue, recommender and
 * history code paths as the real adapters.
 *
 * When the YouTube IFrame API is reachable (the packaged app, or any
 * networked browser), the YouTube adapter is used instead and this one never
 * runs.
 */
import type { PlaybackAdapter, PlaybackEvent, PlaybackSnapshot, PlaybackStatus } from './adapter'
import type { Track } from '../bridge/types'

type Listener = (event: PlaybackEvent) => void

const TICK_MS = 250

export class ClockAdapter implements PlaybackAdapter {
  readonly kind = 'clock' as const
  readonly videoSurface: HTMLElement | null = null
  private listeners = new Set<Listener>()
  private generation = 0
  private trackId: string | null = null
  private status: PlaybackStatus = 'idle'
  private error: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private pos = 0
  private duration = 0
  private volume = 0.9
  private muted = false
  private rate = 1

  constructor() {
    this.installDevHook()
  }

  /** E2E-only controls (gated to dev builds); see scripts/e2e.mjs. */
  private installDevHook(): void {
    if (!import.meta.env.DEV) return
    const hook = {
      // Simulates the track reaching its natural end.
      finishTrack: (): void => {
        if (!this.trackId || this.status === 'idle' || this.status === 'error') return
        this.pos = this.duration
        this.emit({ type: 'position', position: this.pos, trackId: this.trackId })
        this.stopTimer()
        this.status = 'paused'
        const id = this.trackId
        this.emit({ type: 'ended', trackId: id })
        this.emitState()
      },
      // Read-only transport snapshot for test assertions.
      state: (): { trackId: string | null; status: string; position: number; duration: number } => ({
        trackId: this.trackId,
        status: this.status,
        position: this.pos,
        duration: this.duration,
      }),
    }
    ;(window as unknown as Record<string, unknown>).__meloDev = hook
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
      this.pos = Math.min(this.duration, this.pos + (TICK_MS / 1000) * this.rate)
      this.emit({ type: 'position', position: this.pos, trackId: this.trackId })
      if (this.duration > 0 && this.pos >= this.duration) {
        const id = this.trackId
        this.stopTimer()
        this.status = 'paused'
        if (id) this.emit({ type: 'ended', trackId: id })
        this.emitState()
      }
    }, TICK_MS)
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  snapshot(): PlaybackSnapshot {
    return {
      status: this.status,
      trackId: this.trackId,
      duration: this.duration,
      buffered: this.duration,
      error: this.error,
      volume: this.volume,
      muted: this.muted,
      rate: this.rate,
    }
  }

  get position(): number {
    return this.pos
  }

  get currentGeneration(): number {
    return this.generation
  }

  beginLoad(trackId: string): number {
    this.generation += 1
    this.stopTimer()
    this.trackId = trackId
    this.error = null
    this.pos = 0
    this.duration = 0
    this.setStatus('loading')
    this.emit({ type: 'position', position: 0, trackId })
    return this.generation
  }

  async load(token: number, track: Track, startAt = 0, autoplay = true): Promise<boolean> {
    if (token !== this.generation) return false
    this.duration = track.duration > 0 ? track.duration : 180
    this.pos = Math.max(0, Math.min(startAt, this.duration))
    this.emitState()
    if (autoplay) this.setStatus('playing')
    else this.setStatus('paused')
    return token === this.generation
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

  async play(): Promise<void> {
    if (!this.trackId) return
    this.setStatus('playing')
  }

  pause(): void {
    if (!this.trackId) return
    this.setStatus('paused')
  }

  stop(): void {
    this.generation += 1
    this.stopTimer()
    this.trackId = null
    this.error = null
    this.pos = 0
    this.duration = 0
    this.setStatus('idle')
    this.emit({ type: 'position', position: 0, trackId: null })
  }

  seek(seconds: number): void {
    if (!this.trackId) return
    this.pos = Math.max(0, Math.min(seconds, this.duration || Infinity))
    this.emit({ type: 'position', position: this.pos, trackId: this.trackId })
  }

  restart(): void {
    this.seek(0)
    void this.play()
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    this.emitState()
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.emitState()
  }

  setRate(rate: number): void {
    this.rate = Math.max(0.25, Math.min(3, rate))
    this.emitState()
  }

  dispose(): void {
    this.stopTimer()
    this.listeners.clear()
    if (import.meta.env.DEV) {
      delete (window as unknown as Record<string, unknown>).__meloDev
    }
  }
}
