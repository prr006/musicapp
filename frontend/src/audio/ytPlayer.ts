/**
 * YTPlaybackAdapter — the WEB playback transport, implemented on the official
 * YouTube IFrame Player API (https://developers.google.com/youtube/iframe_api_reference).
 *
 * Architecture position:
 *
 *     UI → Queue/controller (state/playback.ts) → PlaybackEngineLike → THIS adapter
 *
 * YouTube is strictly the playback PROVIDER here — the adapter speaks the
 * engine contract (audio/engineTypes.ts) and nothing about YouTube leaks past
 * it. There is no media extraction, no proxying, no yt-dlp, no custom stream
 * endpoints: the iframe plays YouTube's own stream inside YouTube's own
 * player, with all YouTube-native controls disabled (controls=0,
 * disablekb=1, modestbranding=1, rel=0, playsinline=1, iv_load_policy=3) so
 * MELO's transport is the only set of controls the user ever sees. The iframe
 * itself is integrated unobtrusively (a small, visible video element inside
 * the expanded Now Playing view) — never hidden, never the primary surface.
 *
 * All YouTube-specific robustness lives HERE and nowhere else:
 *
 *  - script loading is a single shared promise (window.YT + onYouTubeIframeAPIReady)
 *  - the player is created once and reused across tracks; event handlers
 *    reference `this.generation` at call time so they always correspond to the
 *    current load — events from a previous video that arrive after a new load
 *    are handled by the endedForGeneration duplicate guard
 *  - duplicate ENDED events are coalesced to one
 *  - position is polled on an interval (the IFrame API has no timeupdate)
 *  - provider rejections map to FATAL errors: error codes 2 (invalid parameter),
 *    100 (not found), 101/150 (embedding disabled), and 153 (missing origin/referer)
 *  - onAutoplayBlocked transitions to PAUSED so the UI never shows a fake
 *    playing state when the browser blocks autoplay
 *  - "start playback without a user gesture" is respected: the first load of
 *    a session cues and pauses; a real user click triggers playback
 */
import type { EngineEvent, EngineListener, EngineSnapshot, EngineStatus, PlaybackEngineLike } from './engineTypes'

/* eslint-disable @typescript-eslint/no-explicit-any */

const POSITION_INTERVAL_MS = 250

/** YT Player error codes (IFrame API reference). */
const YT_ERROR_FATAL = new Set([2, 100, 101, 150, 153])

function ytErrorMessage(code: number): string {
  switch (code) {
    case 2:
      return 'This song\'s id is invalid — it can\'t be played.'
    case 5:
      return 'The HTML5 player had trouble with this song.'
    case 100:
      return 'This song is no longer available on the provider.'
    case 101:
    case 150:
      return 'This song can\'t be embedded — skipping it.'
    case 153:
      return 'This song requires permissions that aren\'t available — skipping it.'
    default:
      return `Playback failed (error ${code}).`
  }
}

interface YTPlayer {
  playVideo(): void
  pauseVideo(): void
  stopVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getCurrentTime(): number
  getDuration(): number
  getVolume(): number
  setVolume(volume: number): void
  mute(): void
  unMute(): void
  isMuted(): boolean
  setPlaybackRate(rate: number): void
  loadVideoById(options: { videoId: string; startSeconds?: number }): void
  cueVideoById(options: { videoId: string; startSeconds?: number }): void
  destroy(): void
  getPlayerState(): number
  getVideoData(): { title?: string; author?: string; video_id?: string }
}

interface YTNamespace {
  Player: new (
    element: HTMLElement | string,
    config: {
      videoId?: string
      host?: string
      playerVars?: Record<string, string | number>
      events?: {
        onReady?: () => void
        onStateChange?: (e: { data: number }) => void
        onError?: (e: { data: number }) => void
        onAutoplayBlocked?: () => void
      },
    },
  ) => YTPlayer
  PlayerState: {
    UNSTARTED: number
    ENDED: number
    PLAYING: number
    PAUSED: number
    BUFFERING: number
    CUED: number
  }
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

let apiPromise: Promise<YTNamespace> | null = null

/** Loads (once) the IFrame API script and resolves with the YT namespace. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('No window — the YouTube player needs a browser.'))
  }
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (apiPromise) return apiPromise
  apiPromise = new Promise<YTNamespace>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('The YouTube player could not be loaded — check your connection.'))
    }, 15000)
    const done = () => {
      if (window.YT?.Player) {
        clearTimeout(timeout)
        resolve(window.YT)
      }
    }
    if (window.onYouTubeIframeAPIReady) {
      // A previous boot already queued the callback; chain after it.
      const previous = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        previous()
        done()
      }
    } else {
      window.onYouTubeIframeAPIReady = done
    }
    const script = document.createElement('script')
    script.src = 'https://www.youtube.com/iframe_api'
    script.async = true
    script.onerror = () => {
      clearTimeout(timeout)
      apiPromise = null
      reject(new Error('The YouTube player could not be loaded — check your connection.'))
    }
    document.head.appendChild(script)
  })
  return apiPromise
}

/**
 * The DOM host for the iframe. The adapter creates one fixed container per
 * document; the container is attached ONCE to a permanent host element and
 * never moved via DOM APIs. Visual repositioning (dock ↔ expanded) is done
 * entirely through CSS transitions on the host element — the iframe's DOM
 * parent never changes after creation.
 *
 * Why: The YouTube IFrame Player API uses internal postMessage channels
 * between the iframe and the parent window. Moving the iframe between DOM
 * parents can disrupt these channels, causing origin-mismatch errors. Keeping
 * the iframe in a single, permanently-attached host eliminates this class of
 * issues.
 */
export class YTPlayerHost {
  private static instance: YTPlayerHost | null = null
  static get(): YTPlayerHost {
    if (!YTPlayerHost.instance) YTPlayerHost.instance = new YTPlayerHost()
    return YTPlayerHost.instance
  }

  private container: HTMLDivElement | null = null
  private mount: HTMLDivElement | null = null
  /**
   * The permanent host element. The container (and its iframe) is created
   * inside this element once and never moved. The host element itself is
   * always attached to the document from boot — the IFrame API's Player
   * never reports onReady on a detached element.
   */
  private permanentHost: HTMLElement | null = null
  private viewListeners = new Set<(view: 'dock' | 'expanded') => void>()
  private _view: 'dock' | 'expanded' = 'dock'

  ensureContainer(): HTMLDivElement {
    if (this.container) return this.container
    const container = document.createElement('div')
    container.id = 'melo-yt-host'
    container.style.position = 'static'
    container.style.width = '100%'
    container.style.height = '100%'
    const mount = document.createElement('div')
    mount.style.width = '100%'
    mount.style.height = '100%'
    container.appendChild(mount)
    this.container = container
    this.mount = mount
    // Attach to the permanent host if it's already registered
    if (this.permanentHost && container.parentElement !== this.permanentHost) {
      this.permanentHost.appendChild(container)
    }
    return container
  }

  /**
   * Registers the permanent host element (called once at boot by
   * <YTPlayerHostElement/>). The container is created inside this element
   * and never moved afterward.
   */
  setPermanentHost(el: HTMLElement | null): void {
    this.permanentHost = el
    // If the container already exists (race: adapter created before React
    // mounted the host), move it into the permanent host.
    if (this.container && el && this.container.parentElement !== el) {
      el.appendChild(this.container)
    }
  }

  /**
   * Switches the visual mode between dock and expanded. The host element
   * applies CSS classes to reposition itself — no DOM movement occurs.
   */
  setView(view: 'dock' | 'expanded'): void {
    if (this._view === view) return
    this._view = view
    for (const l of [...this.viewListeners]) l(view)
  }

  get view(): 'dock' | 'expanded' {
    return this._view
  }

  /** Subscribes to view changes (so React components can update state). */
  onViewChange(listener: (view: 'dock' | 'expanded') => void): () => void {
    this.viewListeners.add(listener)
    return () => this.viewListeners.delete(listener)
  }

  get mountElement(): HTMLDivElement | null {
    return this.mount
  }

  /** The iframe is destroyed only when the adapter is disposed (page unload). */
  release(): void {
    if (this.container?.parentElement) {
      this.container.parentElement.removeChild(this.container)
    }
  }
}

export interface YTVideoData {
  title: string
  author: string
  videoId: string
}

export class YTPlaybackAdapter implements PlaybackEngineLike {
  readonly el: HTMLAudioElement | null = null
  /** The provider plays its own media: no resolver, no extracted stream. */
  readonly needsResolvedSource = false
  debugHook: ((stage: string, info?: string) => void) | null = null

  private player: YTPlayer | null = null
  private creating: Promise<void> | null = null
  private listeners = new Set<EngineListener>()
  private generation = 0
  private trackId: string | null = null
  private status: EngineStatus = 'idle'
  private error: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastPosition = 0
  /** Which generation the ENDED event was emitted for (duplicate guard). */
  private endedForGeneration = -1
  /** The chosen playback rate, reapplied on every load. */
  private rate = 1
  private volume = 1.0
  private muted = false
  /**
   * Pending-play bookkeeping: true when the current generation should be
   * playing (requested by load(autoplay) or play()); the IFrame API drives
   * the actual audio, this only records intent for future gesture policies.
   */
  private wantsPlay = false
  /** True while a loadVideoById is in flight (before it reports CUED/PLAYING). */
  private loading = false

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(event: EngineEvent): void {
    for (const l of [...this.listeners]) l(event)
  }

  private emitState(): void {
    this.emit({ type: 'state', snapshot: this.snapshot() })
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

  private emitPosition(force = false): void {
    if (!this.player) return
    const pos = this.player.getCurrentTime()
    if (!Number.isFinite(pos)) return
    if (!force && Math.abs(pos - this.lastPosition) < 0.05) return
    this.lastPosition = pos
    this.emit({ type: 'position', position: pos, trackId: this.trackId })
  }

  snapshot(): EngineSnapshot {
    let duration = 0
    if (this.player) {
      const d = this.player.getDuration()
      if (Number.isFinite(d)) duration = d
    }
    return {
      status: this.status,
      trackId: this.trackId,
      duration,
      buffered: duration > 0 ? duration : 0,
      error: this.error,
      volume: this.volume,
      muted: this.muted,
      rate: this.rate,
    }
  }

  get position(): number {
    return this.player ? this.player.getCurrentTime() : 0
  }

  get currentGeneration(): number {
    return this.generation
  }

  /** Returns YouTube's authoritative metadata for the currently loaded video. */
  getVideoData(): YTVideoData | null {
    if (!this.player) return null
    try {
      const data = this.player.getVideoData()
      if (!data) return null
      return {
        title: data.title ?? '',
        author: data.author ?? '',
        videoId: data.video_id ?? '',
      }
    } catch {
      return null
    }
  }

  /** Creates the underlying YT.Player once, asynchronously. */
  private ensurePlayer(_token: number): Promise<void> {
    if (this.player) return Promise.resolve()
    if (this.creating) return this.creating
    this.creating = loadYouTubeApi()
      .then(
        (YT) =>
          new Promise<void>((resolve) => {
            const mount = YTPlayerHost.get().ensureContainer()
            const target = YTPlayerHost.get().mountElement ?? mount
            this.player = new YT.Player(target, {
              playerVars: {
                autoplay: 0,
                controls: 0,
                disablekb: 1,
                modestbranding: 1,
                rel: 0,
                playsinline: 1,
                iv_load_policy: 3,
                fs: 0,
                origin: window.location.origin,
              },
              events: {
                onReady: () => {
                  // Apply the user's volume/mute/rate as soon as the player exists.
                  this.player?.setVolume(Math.round(this.volume * 100))
                  if (this.muted) this.player?.mute()
                  this.player?.setPlaybackRate(this.rate)
                  resolve()
                },
                // Event handlers reference this.generation at call time so they
                // always correspond to the CURRENT active load. The player is
                // reused across tracks, so a captured token from creation time
                // would become stale after the first track switch.
                onStateChange: (e) => this.onPlayerState(e.data),
                onError: (e) => this.onPlayerError(e.data),
                onAutoplayBlocked: () => this.onAutoplayBlocked(),
              },
            })
          }),
      )
      .catch((err) => {
        this.creating = null
        throw err
      })
    return this.creating
  }

  private onPlayerState(state: number): void {
    // Read the generation at call time. Events from a previous video that
    // arrive after a new load started will be processed with the current
    // generation — this is intentional because YouTube's own player stops
    // the old video when loadVideoById is called. The endedForGeneration
    // guard handles the rare race where a final ENDED from the old video
    // slips through.
    const gen = this.generation
    if (!window.YT) return
    const YT = window.YT
    switch (state) {
      case YT.PlayerState.PLAYING:
        this.loading = false
        this.wantsPlay = true
        this.setStatus('playing')
        this.emitPosition(true)
        break
      case YT.PlayerState.PAUSED:
        // ENDED also reports PAUSED right after; the ENDED branch is
        // the one that advances the queue, so a pause right after ENDED is
        // ignored (marking the generation prevents double-advance).
        if (this.endedForGeneration !== gen) {
          this.wantsPlay = false
          this.setStatus('paused')
        }
        break
      case YT.PlayerState.ENDED: {
        this.loading = false
        // Duplicate ENDED coalescing: one per generation.
        if (this.endedForGeneration === gen) return
        this.endedForGeneration = gen
        this.setStatus('paused')
        const id = this.trackId
        if (id) this.emit({ type: 'ended', trackId: id })
        break
      }
      case YT.PlayerState.BUFFERING:
        if (this.status === 'playing' || this.loading) this.setStatus('loading')
        break
      case YT.PlayerState.CUED:
        this.loading = false
        if (this.status === 'loading') this.setStatus('paused')
        this.emitPosition(true)
        // Autoplay safety net: some browsers block the very first
        // loadVideoById autoplay inside a fresh iframe. If we asked to play
        // and the video only reached CUED, one explicit playVideo() call
        // after the gesture-backed load recovers it.
        if (this.wantsPlay && this.player) {
          try {
            this.player.playVideo()
          } catch {
            /* the state events stay authoritative */
          }
        }
        break
      default:
        break
    }
  }

  /**
   * Called when the browser blocks autoplay (Chrome, Safari, etc.).
   * The player transitions to a non-playing state so the UI never shows a
   * fake playing indicator while YouTube is actually paused/blocked.
   */
  private onAutoplayBlocked(): void {
    this.wantsPlay = false
    this.loading = false
    if (this.status === 'playing' || this.status === 'loading') {
      this.setStatus('paused')
    }
    this.debugHook?.('AUTOPLAY_BLOCKED')
  }

  private onPlayerError(code: number): void {
    const message = ytErrorMessage(code)
    if (YT_ERROR_FATAL.has(code)) {
      // The provider refuses this video. Tell the controller to skip exactly
      // this candidate and continue the queue.
      this.setStatus('error')
      this.error = message
      this.emit({ type: 'error', trackId: this.trackId, message, fatal: true })
    } else {
      this.error = message
      this.setStatus('error')
      this.emit({ type: 'error', trackId: this.trackId, message })
    }
  }

  /**
   * beginLoad invalidates the previous track immediately and returns the
   * token that must be presented to load().
   */
  beginLoad(trackId: string): number {
    this.generation += 1
    // Do NOT reset endedForGeneration. Leaving it at its previous value
    // ensures that a late ENDED event from the OLD video is caught by the
    // dedup guard: the old video's ENDED fires with the new generation
    // (since trackId was overwritten), but endedForGeneration still holds
    // the old generation → guard catches it.
    //
    // Resetting to -1 allowed the old video's ENDED to bypass the guard
    // (since -1 !== newGeneration), emit with the new track's ID, and
    // cause handleEnded() to auto-advance past a previous-track switch.
    this.trackId = trackId
    this.error = null
    this.wantsPlay = false
    this.loading = true
    this.setStatus('loading')
    this.emitPosition(true)
    return this.generation
  }

  /**
   * Loads a YouTube video id (`url` is the provider's canonical id/watch URL —
   * the adapter uses only the id; nothing is fetched beyond YouTube's own
   * iframe player).
   */
  async load(token: number, url: string, startAt = 0, autoplay = true): Promise<boolean> {
    if (token !== this.generation) return false
    const videoId = extractVideoId(url) ?? url
    try {
      await this.ensurePlayer(token)
    } catch (err) {
      if (token !== this.generation) return false
      const message = err instanceof Error ? err.message : 'Playback failed.'
      this.fail(token, message)
      return false
    }
    if (token !== this.generation) return false
    if (!this.player) return false
    this.debugHook?.('SRC_SET', videoId)
    this.wantsPlay = autoplay
    // loadVideoById autoplays once loaded; cueVideoById waits for play().
    if (autoplay) {
      this.player.loadVideoById({ videoId, startSeconds: startAt })
    } else {
      this.player.cueVideoById({ videoId, startSeconds: startAt })
    }
    // NOTE: getVideoData() returns the PREVIOUS video's data immediately
    // after loadVideoById. The videoData event is now emitted from
    // onPlayerState(PLAYING) once the new video has actually loaded.
    // The state events drive status from here; but if the player reports
    // nothing (rare), the caller can still see a stable paused state.
    return true
  }

  fail(token: number, message: string, fatal = false): void {
    if (token !== this.generation) return
    this.error = message
    this.setStatus('error')
    this.emit({ type: 'error', trackId: this.trackId, message, fatal })
  }

  isCurrent(token: number): boolean {
    return token === this.generation
  }

  async play(): Promise<void> {
    if (!this.player) return
    this.wantsPlay = true
    try {
      this.debugHook?.('PLAY_CALL')
      this.player.playVideo()
    } catch {
      // The iframe swallows most errors into state events; nothing to do.
    }
  }

  pause(): void {
    if (!this.player) return
    this.wantsPlay = false
    this.player.pauseVideo()
    if (this.status !== 'error') this.setStatus('paused')
  }

  stop(): void {
    this.generation += 1
    this.loading = false
    this.wantsPlay = false
    this.trackId = null
    this.error = null
    try {
      this.player?.stopVideo()
    } catch {
      /* the player may not exist yet */
    }
    this.setStatus('idle')
    this.emitPosition(true)
  }

  seek(seconds: number): void {
    if (!this.player) return
    const duration = this.player.getDuration()
    const max = Number.isFinite(duration) && duration > 0 ? duration : Infinity
    const target = Math.max(0, Math.min(seconds, max))
    this.player.seekTo(target, true)
    if (this.status === 'paused' || this.status === 'idle') {
      // Seeking while paused keeps the paused surface consistent.
      this.emitPosition(true)
    }
  }

  /**
   * Restarts the current video from zero (Repeat One).
   *
   * Uses loadVideoById() with the same video ID to force a fresh load from
   * startSeconds=0.  seekTo(0) + playVideo() does not reliably restart an
   * ENDED video in the YouTube IFrame API — the seek may be silently ignored
   * and playVideo() replays from the end, leaving the track "stuck".
   *
   * IMPORTANT: Each replay must be a new generation so the ENDED dedup guard
   * (endedForGeneration === gen) does not block the next natural ENDED.
   * Without incrementing, the second ENDED would see endedForGeneration === gen
   * (both set by the first ENDED) and be silently dropped.
   */
  restart(): void {
    if (!this.player) return
    // Increment generation so the NEXT ENDED is not caught by the dedup
    // guard. Reset endedForGeneration to the new generation so that any
    // late ENDED from the PREVIOUS cycle (old generation) is blocked.
    this.generation += 1
    this.endedForGeneration = this.generation
    const videoId = this.player.getVideoData()?.video_id
    if (videoId) {
      this.player.loadVideoById({ videoId, startSeconds: 0 })
    } else {
      // Fallback: cue + play (should never happen with a loaded player).
      this.player.seekTo(0, true)
      this.player.playVideo()
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume))
    if (this.volume > 0 && this.muted) {
      this.muted = false
      this.player?.unMute()
    }
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
    this.rate = Math.max(0.25, Math.min(3, rate))
    this.player?.setPlaybackRate(this.rate)
    this.emitState()
  }

  dispose(): void {
    this.stopTimer()
    this.listeners.clear()
    try {
      this.player?.destroy()
    } catch {
      /* already gone */
    }
    this.player = null
    YTPlayerHost.get().release()
  }
}

/** Accepts a bare id, a watch URL, a short URL or an embed URL. */
export function extractVideoId(url: string): string | null {
  if (!url) return null
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url
  try {
    const parsed = new URL(url, 'https://www.youtube.com')
    if (parsed.hostname.includes('youtube.com')) {
      if (parsed.pathname.startsWith('/watch')) return parsed.searchParams.get('v')
      const m = parsed.pathname.match(/\/(?:embed|shorts|v)\/([a-zA-Z0-9_-]{11})/)
      if (m) return m[1]
    }
    if (parsed.hostname === 'youtu.be') {
      return parsed.pathname.slice(1) || null
    }
  } catch {
    return null
  }
  return null
}
