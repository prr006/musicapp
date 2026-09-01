/**
 * A controllable stand-in for the browser's media element. jsdom has no media
 * pipeline, so tests drive this fake through the same event contract WebView2
 * emits (playing / pause / timeupdate / ended / error).
 */
export class FakeMedia extends EventTarget {
  preload = ''
  crossOrigin: string | null = null
  volume = 1
  muted = false
  playbackRate = 1
  duration = NaN
  currentTime = 0
  paused = true
  error: MediaError | null = null
  loadCount = 0
  playCount = 0
  failNextPlay: string | null = null
  private _src = ''

  get src(): string {
    return this._src
  }

  set src(value: string) {
    this._src = value
  }

  removeAttribute(name: string): void {
    if (name === 'src') this._src = ''
  }

  load(): void {
    this.loadCount += 1
    this.currentTime = 0
  }

  async play(): Promise<void> {
    this.playCount += 1
    if (this.failNextPlay) {
      const message = this.failNextPlay
      this.failNextPlay = null
      throw new Error(message)
    }
    if (!this._src) throw new Error('no source')
    this.paused = false
    this.dispatchEvent(new Event('playing'))
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    this.dispatchEvent(new Event('pause'))
  }

  get buffered() {
    return {
      length: 1,
      end: () => (Number.isFinite(this.duration) ? this.duration : 0),
      start: () => 0,
    }
  }

  // ----- test helpers -----

  setDuration(seconds: number): void {
    this.duration = seconds
    this.dispatchEvent(new Event('durationchange'))
    this.dispatchEvent(new Event('loadedmetadata'))
  }

  tick(seconds: number): void {
    this.currentTime = seconds
    this.dispatchEvent(new Event('timeupdate'))
  }

  endNaturally(): void {
    this.currentTime = Number.isFinite(this.duration) ? this.duration : this.currentTime
    this.paused = true
    this.dispatchEvent(new Event('ended'))
  }

  failWith(code: number): void {
    this.error = { code } as MediaError
    this.dispatchEvent(new Event('error'))
  }

  asElement(): HTMLAudioElement {
    return this as unknown as HTMLAudioElement
  }
}
