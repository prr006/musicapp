import type { EngineEvent, EngineSnapshot } from './engine'

export type PlaybackSourceMode = 'resolved-url' | 'youtube-video-id'

/**
 * The transport boundary shared by the existing queue/playback controller.
 * Implementations own media only; they never select or mutate queue entries.
 */
export interface PlaybackAdapter {
  readonly sourceMode: PlaybackSourceMode
  readonly currentGeneration: number

  subscribe(listener: (event: EngineEvent) => void): () => void
  snapshot(): EngineSnapshot
  beginLoad(trackId: string): number
  load(token: number, source: string, startAt?: number, autoplay?: boolean): Promise<boolean>
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
  dispose(): void
}
