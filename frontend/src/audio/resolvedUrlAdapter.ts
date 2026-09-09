import { backend } from '../bridge/backend'
import type { PlayableSource, Track } from '../bridge/types'
import type { PlaybackAdapter, PlaybackDiagnostic } from './adapter'
import { PlaybackEngine, type EngineEvent, type EngineSnapshot } from './engine'

type ResolveTrack = (track: Track) => Promise<PlayableSource>

/**
 * Desktop/default transport adapter. It contains all resolver-specific work so
 * the queue controller only ever hands an adapter a domain Track.
 */
export class ResolvedUrlPlaybackAdapter implements PlaybackAdapter {
  private fallbackDuration = 0

  constructor(
    readonly transport = new PlaybackEngine(),
    private readonly resolveTrack: ResolveTrack = (track) => backend().getPlayable(track),
  ) {}

  get currentGeneration(): number {
    return this.transport.currentGeneration
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    return this.transport.subscribe((event) => {
      if (event.type === 'state') {
        listener({ type: 'state', snapshot: this.snapshot() })
        return
      }
      listener(event)
    })
  }

  snapshot(): EngineSnapshot {
    const snapshot = this.transport.snapshot()
    return snapshot.duration > 0 || this.fallbackDuration <= 0
      ? snapshot
      : { ...snapshot, duration: this.fallbackDuration }
  }

  beginLoad(trackId: string): number {
    this.fallbackDuration = 0
    return this.transport.beginLoad(trackId)
  }

  async load(token: number, track: Track, startAt = 0, autoplay = true): Promise<boolean> {
    const source = await this.resolveTrack(track)
    if (!this.isCurrent(token)) return false
    this.fallbackDuration = source.duration > 0 ? source.duration : track.duration || 0
    return this.transport.load(token, source.url, startAt, autoplay)
  }

  fail(token: number, message: string): void {
    this.transport.fail(token, message)
  }

  isCurrent(token: number): boolean {
    return this.transport.isCurrent(token)
  }

  play(): Promise<void> {
    return this.transport.play()
  }

  pause(): void {
    this.transport.pause()
  }

  stop(): void {
    this.fallbackDuration = 0
    this.transport.stop()
  }

  seek(seconds: number): void {
    this.transport.seek(seconds)
  }

  restart(): void {
    this.transport.restart()
  }

  setVolume(volume: number): void {
    this.transport.setVolume(volume)
  }

  setMuted(muted: boolean): void {
    this.transport.setMuted(muted)
  }

  setRate(rate: number): void {
    this.transport.setRate(rate)
  }

  async prefetch(track: Track): Promise<void> {
    const prefetch = backend().prefetchPlayable
    if (prefetch) await prefetch(track)
  }

  invalidate(trackId: string): void {
    backend().invalidatePlayable?.(trackId)
  }

  async reportError(diagnostic: PlaybackDiagnostic): Promise<void> {
    await backend().reportPlaybackError?.(diagnostic)
  }

  dispose(): void {
    this.transport.dispose()
  }
}
