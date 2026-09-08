import type { Track } from '../bridge/types'

export interface MediaSessionActions {
  play(): void
  pause(): void
  next(): void
  previous(): void
  seek(position: number): void
  position(): number
  duration(): number
  rate(): number
}

/** Browser/OS media controls. Every call is capability-checked because Firefox
 * and embedded webviews expose different subsets of the Media Session API. */
export class BrowserMediaSession {
  private session: MediaSession | null
  private actions: MediaSessionActions
  private lastPositionUpdate = 0

  constructor(actions: MediaSessionActions) {
    this.actions = actions
    this.session = typeof navigator !== 'undefined' && 'mediaSession' in navigator ? navigator.mediaSession : null
    this.bind()
  }

  private bind(): void {
    if (!this.session) return
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler) => {
      try {
        this.session?.setActionHandler(action, handler)
      } catch {
        // Unsupported actions throw in some Chromium/WebView versions.
      }
    }
    set('play', () => this.actions.play())
    set('pause', () => this.actions.pause())
    set('nexttrack', () => this.actions.next())
    set('previoustrack', () => this.actions.previous())
    set('seekto', (details) => {
      if (typeof details.seekTime === 'number') this.actions.seek(details.seekTime)
    })
    set('seekforward', (details) => this.actions.seek(this.actions.position() + (details.seekOffset ?? 10)))
    set('seekbackward', (details) => this.actions.seek(this.actions.position() - (details.seekOffset ?? 10)))
  }

  setTrack(track: Track | null): void {
    if (!this.session) return
    if (!track) {
      this.session.metadata = null
      this.session.playbackState = 'none'
      return
    }
    const artwork = track.artwork
      ? [{ src: track.artwork, sizes: '512x512' }]
      : []
    try {
      this.session.metadata = new MediaMetadata({
        title: track.title,
        artist: track.artist || 'Unknown artist',
        album: track.album,
        artwork,
      })
    } catch {
      // Metadata is cosmetic; transport handlers remain usable.
    }
  }

  setPlaybackState(status: 'idle' | 'loading' | 'playing' | 'paused' | 'error'): void {
    if (!this.session) return
    try {
      this.session.playbackState = status === 'playing' ? 'playing' : status === 'idle' ? 'none' : 'paused'
    } catch {
      // Firefox currently supports only parts of the API.
    }
  }

  updatePosition(force = false): void {
    if (!this.session?.setPositionState) return
    const now = Date.now()
    if (!force && now - this.lastPositionUpdate < 1000) return
    const duration = this.actions.duration()
    const position = this.actions.position()
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return
    try {
      this.session.setPositionState({
        duration,
        position: Math.max(0, Math.min(position, duration)),
        playbackRate: Math.max(0.25, this.actions.rate()),
      })
      this.lastPositionUpdate = now
    } catch {
      // Position support is optional and may reject while metadata is loading.
    }
  }
}
