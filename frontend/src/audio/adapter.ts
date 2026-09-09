import type { Track } from '../bridge/types'
import type { EngineEvent, EngineSnapshot } from './engine'

export interface PlaybackDiagnostic {
  trackId: string
  code: string
  recoverable: boolean
}

/**
 * The transport boundary shared by the existing queue/playback controller.
 * Implementations own source preparation and media only; they never select or
 * mutate queue entries.
 */
export interface PlaybackAdapter {
  readonly currentGeneration: number

  subscribe(listener: (event: EngineEvent) => void): () => void
  snapshot(): EngineSnapshot
  beginLoad(trackId: string): number
  load(token: number, track: Track, startAt?: number, autoplay?: boolean): Promise<boolean>
  fail(token: number, message: string): void
  isCurrent(token: number): boolean
  play(): Promise<void>
  pause(): void
  stop(): void
  seek(seconds: number): void
  restart(): void
  setVolume(volume: number): void
  setMuted(muted: boolean): void
  setRate(rate: number): void
  prefetch?(track: Track): Promise<void>
  invalidate?(trackId: string): void
  reportError?(diagnostic: PlaybackDiagnostic): Promise<void>
  dispose(): void
}
