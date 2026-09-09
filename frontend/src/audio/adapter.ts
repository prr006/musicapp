/**
 * The PlaybackAdapter contract.
 *
 *   UI  →  Queue / PlaybackController  →  PlaybackAdapter  →  sound comes out
 *
 * The controller knows nothing about *where* audio comes from; an adapter
 * owns exactly one playback provider. Two ship in this repo:
 *
 *   - YouTubeIframeAdapter — the production provider. It drives the official
 *     YouTube IFrame Player API. It is the only place in the codebase that
 *     knows YouTube's player API exists.
 *   - HtmlAudioAdapter — a generic URL-based media element adapter. It exists
 *     for engine-level tests and any future direct-URL source. It is never
 *     used for YouTube playback: there is deliberately no resolver, stream
 *     proxy or media-extraction step anywhere in this app.
 *
 * A ClockAdapter (simulated transport, no audio) is used only by offline
 * browser development and end-to-end tests.
 *
 * Every load takes a generation token; a result or event that arrives late is
 * dropped so a rapid A → B → C switch can never resurrect an older track.
 */
import type { Track } from '../bridge/types'

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export interface PlaybackSnapshot {
  status: PlaybackStatus
  trackId: string | null
  duration: number
  buffered: number
  error: string | null
  volume: number
  muted: boolean
  rate: number
}

export type PlaybackEvent =
  | { type: 'state'; snapshot: PlaybackSnapshot }
  | { type: 'position'; position: number; trackId: string | null }
  | { type: 'ended'; trackId: string }
  | { type: 'error'; trackId: string | null; message: string }

export type PlaybackAdapterKind = 'youtube' | 'html-audio' | 'clock'

export interface PlaybackAdapter {
  /** Which provider this is; used for diagnostics only, never for behaviour. */
  readonly kind: PlaybackAdapterKind
  /**
   * The provider's visual surface, if it has one that must stay visible.
   * The YouTube IFrame adapter exposes its player stage here so the UI can
   * dock it into the Now Playing artwork slot; adapters without a visual
   * surface return null. The adapter owns this node — the UI only positions
   * it, never re-creates it.
   */
  readonly videoSurface: HTMLElement | null
  subscribe(listener: (event: PlaybackEvent) => void): () => void
  snapshot(): PlaybackSnapshot
  /**
   * Clears the current source immediately and returns the token that must be
   * presented to `load`. Called the instant the user picks a track so the
   * previous audio stops before the new one is requested.
   */
  beginLoad(trackId: string): number
  /**
   * Loads a track. Returns false when the token is stale (the caller lost the
   * race). The track — not a resolved URL — is the input: each adapter derives
   * its own playback source from it.
   */
  load(token: number, track: Track, startAt?: number, autoplay?: boolean): Promise<boolean>
  /** Marks the in-flight load as failed (used when loading itself errors). */
  fail(token: number, message: string): void
  isCurrent(token: number): boolean
  play(): Promise<void>
  pause(): void
  /** Stop is explicit: it clears the transport but never advances the queue. */
  stop(): void
  seek(seconds: number): void
  /** Restarts the current source from zero (used by Repeat One). */
  restart(): void
  setVolume(volume: number): void
  setMuted(muted: boolean): void
  setRate(rate: number): void
  position: number
  currentGeneration: number
  dispose(): void
}

export interface AdapterChoice {
  adapter: PlaybackAdapter
  /** True when the preferred provider was unavailable and a fallback was used. */
  degraded: boolean
}

export const ADAPTER_MIN_SURFACE = 200

/**
 * A no-op adapter used until the real provider has been chosen (the choice is
 * asynchronous — see audio/select.ts). It keeps every controller call safe
 * before boot finishes; it can never play anything.
 */
export class NullAdapter implements PlaybackAdapter {
  readonly kind = 'html-audio' as const
  readonly videoSurface: HTMLElement | null = null
  private volume = 0.9
  private muted = false
  private rate = 1
  subscribe(): () => void {
    return () => {}
  }
  snapshot(): PlaybackSnapshot {
    return {
      status: 'idle', trackId: null, duration: 0, buffered: 0, error: null,
      volume: this.volume, muted: this.muted, rate: this.rate,
    }
  }
  beginLoad(): number {
    return 0
  }
  async load(): Promise<boolean> {
    return false
  }
  fail(): void {}
  isCurrent(): boolean {
    return false
  }
  async play(): Promise<void> {}
  pause(): void {}
  stop(): void {}
  seek(): void {}
  restart(): void {}
  setVolume(volume: number): void {
    this.volume = volume
  }
  setMuted(muted: boolean): void {
    this.muted = muted
  }
  setRate(rate: number): void {
    this.rate = rate
  }
  get position(): number {
    return 0
  }
  get currentGeneration(): number {
    return 0
  }
  dispose(): void {}
}
