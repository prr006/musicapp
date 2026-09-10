/**
 * The playback engine boundary — the only contract the playback controller
 * knows about. Two implementations live behind it:
 *
 *   - PlaybackEngine (audio/engine.ts)   — an HTMLAudioElement; the desktop
 *     (Wails/WebView2) transport, where the Go side resolves an audio stream.
 *   - YTPlaybackAdapter (audio/ytPlayer.ts) — the official YouTube IFrame
 *     Player API; the web transport, where YouTube itself is the playback
 *     provider and no media is ever extracted, proxied or downloaded.
 *
 * Both emit the same events and honour the same generation-token discipline:
 * a load takes a token from beginLoad(); anything that arrives after a newer
 * token exists (a late event, a slow load) is discarded by the caller.
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
  /**
   * `fatal` marks a track the PROVIDER itself refuses to play (removed video,
   * embedding disabled, bad id). The controller skips exactly that candidate
   * and continues the queue. Ordinary transport errors are not fatal: the UI
   * surfaces them and the user decides.
   */
  | { type: 'error'; trackId: string | null; message: string; fatal?: boolean }

export type EngineListener = (event: EngineEvent) => void

/**
 * `el` is the underlying media element of the desktop engine; the YouTube
 * adapter has none (it drives the IFrame player) and reports null. Nothing
 * outside the engines themselves may assume it is non-null.
 */
export interface PlaybackEngineLike {
  readonly el: HTMLAudioElement | null
  /**
   * True when the engine needs the controller to resolve a playable stream
   * URL before load() (the desktop HTMLAudio transport). False for providers
   * that play their own media directly — the YouTube IFrame adapter — in
   * which case the controller hands load() the track's canonical provider
   * url and never consults a resolver.
   */
  readonly needsResolvedSource: boolean
  readonly currentGeneration: number
  debugHook: ((stage: string, info?: string) => void) | null
  snapshot(): EngineSnapshot
  readonly position: number
  subscribe(listener: EngineListener): () => void
  beginLoad(trackId: string): number
  load(token: number, url: string, startAt?: number, autoplay?: boolean): Promise<boolean>
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
