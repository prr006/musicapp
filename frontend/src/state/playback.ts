/**
 * The playback controller: the only place that decides what plays next.
 *
 * Responsibilities
 *  - own the engine <-> application-state wiring
 *  - guarantee that a track change clears every trace of the previous track
 *  - implement repeat / shuffle / autoplay rules exactly once each
 *
 * Stale-result protection: every play request takes a token from the engine.
 * A resolver answer, a lyrics answer or a media event is only applied when its
 * token is still current, so "play A then immediately play B" can never end
 * with A's audio, metadata, artwork or lyrics attached to B.
 */
import { PlaybackEngine } from '../audio/engine'
import { backend } from '../bridge/backend'
import type { RepeatMode, Track } from '../bridge/types'
import { dedupeTracks, moveItem, shuffleUpcoming } from '../lib/queue'
import { library, useLibraryStore } from './libraryStore'
import { lyrics } from './lyricsStore'
import { playerState, setPlayerState, usePlayerStore } from './playerStore'
import { positionChannel } from './positionChannel'
import { ui } from './uiStore'

export interface PlayContext {
  tracks?: Track[]
  index?: number
  label?: string
}

const SESSION_SAVE_DEBOUNCE = 1500
const PREVIOUS_RESTART_THRESHOLD = 3

export class PlaybackController {
  readonly engine: PlaybackEngine
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  private recordedForToken = new Set<number>()
  private autoplayRequestFor: string | null = null

  constructor(engine = new PlaybackEngine()) {
    this.engine = engine
    this.engine.subscribe((event) => this.onEngineEvent(event))
  }

  // ---------- engine events ----------

  private onEngineEvent(event: Parameters<Parameters<PlaybackEngine['subscribe']>[0]>[0]): void {
    switch (event.type) {
      case 'state': {
        const { status, duration, buffered, error, volume, muted, rate } = event.snapshot
        positionChannel.setDuration(duration)
        positionChannel.setBuffered(buffered)
        setPlayerState({ status, error, volume, muted, speed: rate })
        if (status === 'playing') {
          this.markPlayed()
          void this.ensureAutoplayContinuation()
        }
        this.queueSessionSave()
        break
      }
      case 'position':
        positionChannel.setPosition(event.position)
        break
      case 'ended':
        this.handleEnded(event.trackId)
        break
      case 'error':
        ui.toast(event.message, 'error')
        break
    }
  }

  /** Natural end of file: advance exactly once, honouring the repeat mode. */
  private handleEnded(trackId: string): void {
    const state = playerState()
    if (!state.current || state.current.id !== trackId) return
    if (state.repeat === 'one') {
      positionChannel.setPosition(0)
      this.engine.restart()
      return
    }
    void this.advance(1, { auto: true })
  }

  /** Tray tooltip / notification mirroring. Best-effort and never blocking. */
  private mirrorToDesktop(title: string, artist: string): void {
    void backend()
      .setNowPlaying(title, artist)
      .catch(() => {
        /* desktop mirroring is cosmetic; a failure must not affect playback */
      })
  }

  private markPlayed(): void {
    const token = this.engine.currentGeneration
    if (this.recordedForToken.has(token)) return
    const current = playerState().current
    if (!current) return
    this.recordedForToken.add(token)
    void library.recordPlay(current).catch(() => {
      /* history is best-effort; the error surfaces through the store */
    })
  }

  // ---------- transport ----------

  /** Play a track, optionally replacing the explicit queue with a context. */
  async play(track: Track, context: PlayContext = {}): Promise<void> {
    const tracks = context.tracks ? dedupeTracks(context.tracks) : null
    let queue = tracks ?? playerState().queue
    let index = -1
    if (tracks) {
      index = context.index ?? tracks.findIndex((t) => t.id === track.id)
      if (index < 0) index = 0
    } else {
      index = queue.findIndex((t) => t.id === track.id)
      if (index < 0) {
        queue = [...queue, track]
        index = queue.length - 1
      }
    }
    if (playerState().shuffle && tracks) {
      queue = shuffleUpcoming(queue, index)
    }
    setPlayerState({
      queue,
      index,
      contextLabel: context.label ?? playerState().contextLabel,
      playingFrom: 'queue',
    })
    await this.start(track)
  }

  /** Starts a specific track: clears old state first, then resolves. */
  private async start(track: Track, startAt = 0): Promise<void> {
    const token = this.engine.beginLoad(track.id)
    this.recordedForToken.clear()
    positionChannel.reset()
    positionChannel.setDuration(track.duration || 0)
    setPlayerState({ current: track, status: 'loading', error: null })
    lyrics.loadFor(track, () => this.engine.isCurrent(token))
    this.mirrorToDesktop(track.title, track.artist)

    try {
      const source = await backend().getPlayable(track)
      if (!this.engine.isCurrent(token)) return // a newer track won the race
      if (source.duration > 0) positionChannel.setDuration(source.duration)
      await this.engine.load(token, source.url, startAt)
    } catch (err) {
      if (!this.engine.isCurrent(token)) return
      const message = err instanceof Error ? err.message : 'Couldn\u2019t load this song.'
      this.engine.fail(token, message)
      setPlayerState({ status: 'error', error: message })
    }
  }

  async toggle(): Promise<void> {
    const { status, current } = playerState()
    if (!current) return
    if (status === 'playing') {
      this.engine.pause()
      return
    }
    if (status === 'error') {
      await this.start(current, positionChannel.getPosition())
      return
    }
    await this.engine.play()
  }

  pause(): void {
    this.engine.pause()
  }

  async resume(): Promise<void> {
    await this.engine.play()
  }

  /** Manual stop: clears the transport and never advances the queue. */
  stop(): void {
    this.engine.stop()
    this.recordedForToken.clear()
    positionChannel.reset()
    setPlayerState({ current: null, status: 'idle', error: null, index: -1 })
    lyrics.clear()
    this.mirrorToDesktop('', '')
    this.queueSessionSave()
  }

  async next(): Promise<void> {
    await this.advance(1, { auto: false })
  }

  async previous(): Promise<void> {
    const state = playerState()
    if (!state.current) return
    if (positionChannel.getPosition() > PREVIOUS_RESTART_THRESHOLD) {
      this.seek(0)
      return
    }
    if (state.index > 0) {
      const track = state.queue[state.index - 1]
      setPlayerState({ index: state.index - 1 })
      await this.start(track)
      return
    }
    if (state.repeat === 'all' && state.queue.length > 0) {
      const index = state.queue.length - 1
      setPlayerState({ index })
      await this.start(state.queue[index])
      return
    }
    this.seek(0)
  }

  /** The single implementation of "move by one track". */
  private async advance(step: number, opts: { auto: boolean }): Promise<void> {
    const state = playerState()
    const { queue, index, repeat } = state

    if (state.playingFrom === 'autoplay') {
      const pos = state.autoQueue.findIndex((t) => t.id === state.current?.id)
      const nextAuto = state.autoQueue[pos + step]
      if (nextAuto) {
        await this.start(nextAuto)
        return
      }
      this.finish()
      return
    }

    const nextIndex = index + step
    if (nextIndex >= 0 && nextIndex < queue.length) {
      setPlayerState({ index: nextIndex })
      await this.start(queue[nextIndex])
      return
    }
    if (repeat === 'all' && queue.length > 0) {
      const wrapped = step > 0 ? 0 : queue.length - 1
      setPlayerState({ index: wrapped })
      await this.start(queue[wrapped])
      return
    }
    // Explicit queue exhausted: autoplay continues only if the user enabled it.
    const autoplay = useLibraryStore.getState().settings.autoplay
    if (step > 0 && autoplay && state.autoQueue.length > 0) {
      const next = state.autoQueue[0]
      setPlayerState({ playingFrom: 'autoplay' })
      await this.start(next)
      return
    }
    if (opts.auto) {
      this.finish()
      return
    }
    this.finish()
  }

  /** Reached the end of everything: stop cleanly without clearing the queue. */
  private finish(): void {
    this.engine.stop()
    setPlayerState({ status: 'idle' })
    positionChannel.setPosition(0)
    this.queueSessionSave()
  }

  async playQueueIndex(index: number): Promise<void> {
    const state = playerState()
    const track = state.queue[index]
    if (!track) return
    setPlayerState({ index, playingFrom: 'queue' })
    await this.start(track)
  }

  seek(seconds: number): void {
    this.engine.seek(seconds)
    positionChannel.setPosition(seconds)
    this.queueSessionSave()
  }

  seekBy(delta: number): void {
    this.seek(positionChannel.getPosition() + delta)
  }

  setVolume(volume: number): void {
    this.engine.setVolume(volume)
    setPlayerState({ volume, muted: volume === 0 ? playerState().muted : false })
    if (volume > 0) this.engine.setMuted(false)
    void library.saveSettings({ volume, muted: this.engine.snapshot().muted })
  }

  toggleMute(): void {
    const muted = !playerState().muted
    this.engine.setMuted(muted)
    setPlayerState({ muted })
    void library.saveSettings({ muted })
  }

  setSpeed(speed: number): void {
    this.engine.setRate(speed)
    setPlayerState({ speed })
  }

  // ---------- queue management ----------

  setQueue(tracks: Track[], label = ''): void {
    setPlayerState({ queue: dedupeTracks(tracks), index: -1, contextLabel: label })
    this.queueSessionSave()
  }

  addToQueue(tracks: Track[]): void {
    const state = playerState()
    const existing = new Set(state.queue.map((t) => t.id))
    const additions = dedupeTracks(tracks).filter((t) => !existing.has(t.id))
    if (additions.length === 0) {
      ui.toast('Already in the queue')
      return
    }
    setPlayerState({ queue: [...state.queue, ...additions] })
    ui.toast(additions.length === 1 ? `Added “${additions[0].title}” to the queue` : `Added ${additions.length} songs to the queue`)
    this.queueSessionSave()
  }

  playNext(tracks: Track[]): void {
    const state = playerState()
    const additions = dedupeTracks(tracks).filter((t) => t.id !== state.current?.id)
    if (additions.length === 0) return
    const remaining = state.queue.filter((t, i) => i <= state.index || !additions.some((a) => a.id === t.id))
    const insertAt = Math.max(state.index + 1, 0)
    const next = [...remaining.slice(0, insertAt), ...additions, ...remaining.slice(insertAt)]
    setPlayerState({ queue: next })
    ui.toast(additions.length === 1 ? `“${additions[0].title}” plays next` : `${additions.length} songs play next`)
    this.queueSessionSave()
  }

  removeFromQueue(index: number): void {
    const state = playerState()
    if (index < 0 || index >= state.queue.length) return
    if (index === state.index) return // never yank the playing track from under itself
    const queue = state.queue.filter((_, i) => i !== index)
    const newIndex = index < state.index ? state.index - 1 : state.index
    setPlayerState({ queue, index: newIndex })
    this.queueSessionSave()
  }

  reorderQueue(from: number, to: number): void {
    const state = playerState()
    const queue = moveItem(state.queue, from, to)
    if (queue === state.queue) return
    let index = state.index
    if (from === state.index) index = to
    else if (from < state.index && to >= state.index) index -= 1
    else if (from > state.index && to <= state.index) index += 1
    setPlayerState({ queue, index })
    this.queueSessionSave()
  }

  clearUpcoming(): void {
    const state = playerState()
    if (state.index < 0) {
      setPlayerState({ queue: [] })
    } else {
      setPlayerState({ queue: state.queue.slice(0, state.index + 1) })
    }
    this.queueSessionSave()
  }

  toggleShuffle(): void {
    const state = playerState()
    const shuffle = !state.shuffle
    const queue = shuffle ? shuffleUpcoming(state.queue, state.index) : state.queue
    setPlayerState({ shuffle, queue })
    this.queueSessionSave()
  }

  cycleRepeat(): void {
    const order: RepeatMode[] = ['off', 'all', 'one']
    const current = playerState().repeat
    const repeat = order[(order.indexOf(current) + 1) % order.length]
    setPlayerState({ repeat })
    this.queueSessionSave()
  }

  setRepeat(repeat: RepeatMode): void {
    setPlayerState({ repeat })
    this.queueSessionSave()
  }

  async playAll(tracks: Track[], label: string, shuffle = false): Promise<void> {
    const list = dedupeTracks(tracks)
    if (list.length === 0) return
    if (shuffle) {
      const order = shuffleUpcoming(list, -1)
      setPlayerState({ shuffle: true })
      await this.play(order[0], { tracks: order, index: 0, label })
      return
    }
    await this.play(list[0], { tracks: list, index: 0, label })
  }

  // ---------- autoplay ----------

  /**
   * Autoplay is a separate list built from real provider data for the current
   * artist. It is only consulted after the explicit queue is exhausted.
   */
  private async ensureAutoplayContinuation(): Promise<void> {
    const state = playerState()
    const settings = useLibraryStore.getState().settings
    if (!settings.autoplay || !state.current) return
    const remaining = state.queue.length - 1 - state.index
    if (remaining > 1 || state.autoQueue.length > 0) return
    const seed = state.current
    if (this.autoplayRequestFor === seed.id) return
    this.autoplayRequestFor = seed.id
    try {
      const query = seed.artist || seed.title
      const res = await backend().search(query, 'songs')
      const known = new Set([...state.queue.map((t) => t.id), seed.id])
      const candidates = dedupeTracks([...(res.songs ?? []), ...(res.videos ?? [])])
        .filter((t) => !known.has(t.id))
        .slice(0, 20)
      if (candidates.length === 0) return
      setPlayerState({ autoQueue: candidates })
    } catch {
      // Autoplay is optional: a provider failure must not disturb playback.
      setPlayerState({ autoQueue: [] })
    }
  }

  clearAutoplay(): void {
    this.autoplayRequestFor = null
    setPlayerState({ autoQueue: [] })
  }

  // ---------- session ----------

  private queueSessionSave(): void {
    if (this.sessionTimer) clearTimeout(this.sessionTimer)
    this.sessionTimer = setTimeout(() => void this.saveSession(), SESSION_SAVE_DEBOUNCE)
  }

  async saveSession(): Promise<void> {
    const state = playerState()
    if (!useLibraryStore.getState().settings.restoreSession) return
    try {
      await backend().saveSession({
        queue: state.queue,
        autoQueue: state.autoQueue,
        index: state.index,
        position: positionChannel.getPosition(),
        shuffle: state.shuffle,
        repeat: state.repeat,
        speed: state.speed,
        savedAt: Date.now(),
      })
    } catch {
      /* session persistence is best-effort and never blocks playback */
    }
  }

  /** Restores a saved session without starting playback unless asked to. */
  async restoreSession(session: {
    queue: Track[]
    autoQueue: Track[]
    index: number
    position: number
    shuffle: boolean
    repeat: RepeatMode
    speed: number
  }, autoResume: boolean): Promise<void> {
    const queue = session.queue ?? []
    const index = Math.min(Math.max(session.index, -1), queue.length - 1)
    setPlayerState({
      queue,
      autoQueue: session.autoQueue ?? [],
      index,
      shuffle: !!session.shuffle,
      repeat: session.repeat ?? 'off',
      speed: session.speed || 1,
      current: index >= 0 ? queue[index] ?? null : null,
    })
    if (index >= 0 && queue[index]) {
      positionChannel.setDuration(queue[index].duration || 0)
      positionChannel.setPosition(session.position || 0)
      if (autoResume) {
        await this.start(queue[index], session.position || 0)
      }
    }
  }
}

export const playback = new PlaybackController()

/** Convenience hook for components that only need a couple of fields. */
export const usePlayer = usePlayerStore
