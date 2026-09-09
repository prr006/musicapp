/**
 * The playback controller: the only place that decides what plays next.
 *
 *   UI  →  this controller (queue + transport)  →  PlaybackAdapter  →  sound
 *
 * Responsibilities
 *  - own the adapter ↔ application-state wiring
 *  - guarantee that a track change clears every trace of the previous track
 *  - implement repeat / shuffle / autoplay rules exactly once each
 *  - keep the explicit user queue strictly ahead of autoplay, always
 *  - record what actually happened to each listen (played / completed /
 *    skipped) so the listening profile — and through it the recommender —
 *    learns from real behaviour
 *
 * Autoplay is maintained by the recommender (state/recommender.ts), which
 * owns a rolling buffer of recommendations that refills as tracks are
 * consumed. The controller only consumes from it, never rewrites it.
 *
 * Stale-result protection: every play request takes a token from the adapter.
 * An adapter answer, a lyrics answer or a media event is only applied when
 * its token is still current, so "play A then immediately play B" can never
 * end with A's audio, metadata, artwork or lyrics attached to B.
 */
import type { PlaybackAdapter, PlaybackEvent } from '../audio/adapter'
import { NullAdapter } from '../audio/adapter'
import { backend } from '../bridge/backend'
import type { RepeatMode, Track } from '../bridge/types'
import { dedupeTracks, moveItem, shuffleUpcoming } from '../lib/queue'
import { library, useLibraryStore } from './libraryStore'
import { lyrics } from './lyricsStore'
import { playerState, setPlayerState, usePlayerStore } from './playerStore'
import { positionChannel } from './positionChannel'
import { recommender } from './recommender'
import { ui } from './uiStore'

export interface PlayContext {
  tracks?: Track[]
  index?: number
  label?: string
}

const SESSION_SAVE_DEBOUNCE = 1500
const PREVIOUS_RESTART_THRESHOLD = 3
/** A manual advance before this much of the track counts as a skip. */
const SKIP_THRESHOLD_SEC = 30
const SKIP_THRESHOLD_RATIO = 0.3
/** Completed means: reached the end, or within this many seconds of it. */
const COMPLETION_TOLERANCE_SEC = 6

/** One entry in this session's "what actually played" history. */
interface PlayedEntry {
  track: Track
  from: 'queue' | 'autoplay'
  index: number
}

type ListenOutcome = 'completed' | 'skipped' | 'abandoned' | 'stopped'

export class PlaybackController {
  adapter: PlaybackAdapter
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  private unsubscribeAdapter: (() => void) | null = null
  /** Adapter generations that reached 'playing' and were recorded to history. */
  private playedTokens = new Set<number>()
  /** Adapter generation that already kicked off a recommendation refill. */
  private refillGen = 0
  /** Outcome of the current listen, set by ended/next/stop before advancing. */
  private pendingOutcome: ListenOutcome | null = null
  /** What actually played this session, for Previous during autoplay. */
  private playStack: PlayedEntry[] = []
  /** Consecutive load/play failures — autoplay skips a few, then gives up. */
  private consecutiveErrors = 0
  private errorSkipTimer: ReturnType<typeof setTimeout> | null = null

  constructor(adapter: PlaybackAdapter = new NullAdapter()) {
    this.adapter = adapter
    this.bindAdapter(adapter)
  }

  /** Attaches the real adapter once the environment chose one (see main.tsx). */
  attachAdapter(adapter: PlaybackAdapter): void {
    if (adapter === this.adapter) return
    this.unsubscribeAdapter?.()
    const previous = this.adapter
    this.adapter = adapter
    this.bindAdapter(adapter)
    // Carry over the transport settings the user already had.
    const snap = previous.snapshot()
    adapter.setVolume(snap.volume)
    adapter.setMuted(snap.muted)
    adapter.setRate(snap.rate)
  }

  private bindAdapter(adapter: PlaybackAdapter): void {
    this.unsubscribeAdapter = adapter.subscribe((event) => this.onAdapterEvent(event))
  }

  // ---------- adapter events ----------

  private onAdapterEvent(event: PlaybackEvent): void {
    switch (event.type) {
      case 'state': {
        const { status, duration, buffered, error, volume, muted, rate } = event.snapshot
        positionChannel.setDuration(duration)
        positionChannel.setBuffered(buffered)
        setPlayerState({ status, error, volume, muted, speed: rate })
        if (status === 'playing') {
          this.consecutiveErrors = 0
          this.markPlayed()
          // Refill recommendations once per track (generation), not on every
          // state emission — otherwise duration/buffered updates would keep
          // re-fetching the same anchors.
          if (this.refillGen !== this.adapter.currentGeneration) {
            this.refillGen = this.adapter.currentGeneration
            void recommender.ensureBuffered()
          }
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
        this.maybeSkipBrokenTrack()
        break
    }
  }

  /**
   * A track that cannot play (unavailable, embedding disabled…) must not stop
   * the music: skip to the next track automatically, a few times in a row at
   * most, so a genuinely broken session still surfaces its error.
   */
  private maybeSkipBrokenTrack(): void {
    const state = playerState()
    if (!state.current || state.status !== 'error') return
    this.consecutiveErrors += 1
    if (this.consecutiveErrors > 3) return
    const hasUpcoming =
      state.playingFrom === 'autoplay'
        ? state.index + 1 < state.queue.length || state.autoQueue.length > 0
        : state.index + 1 < state.queue.length ||
          (useLibraryStore.getState().settings.autoplay && true)
    if (!hasUpcoming) return
    if (this.errorSkipTimer) clearTimeout(this.errorSkipTimer)
    this.errorSkipTimer = setTimeout(() => {
      this.errorSkipTimer = null
      if (playerState().status === 'error') void this.next()
    }, 1500)
  }

  /** Natural end of file: advance exactly once, honouring the repeat mode. */
  private handleEnded(trackId: string): void {
    const state = playerState()
    if (!state.current || state.current.id !== trackId) return
    if (state.repeat === 'one') {
      this.pendingOutcome = 'completed'
      this.finalizeCurrentPlay()
      positionChannel.setPosition(0)
      this.adapter.restart()
      return
    }
    this.pendingOutcome = 'completed'
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

  /** Records the 'start' of a listen once playback is actually running. */
  private markPlayed(): void {
    const token = this.adapter.currentGeneration
    if (this.playedTokens.has(token)) return
    const current = playerState().current
    if (!current) return
    this.playedTokens.add(token)
    void library
      .recordPlayEvent(current, { phase: 'start' })
      .catch(() => {
        /* history is best-effort; the error surfaces through the store */
      })
  }

  /**
   * Records how the current listen ended. Skips count against the track;
   * completed listens give it (and its artist/style) full weight.
   */
  private finalizeCurrentPlay(): void {
    const outcome = this.pendingOutcome ?? 'abandoned'
    this.pendingOutcome = null
    const token = this.adapter.currentGeneration
    if (!this.playedTokens.has(token)) return // never actually played
    const track = playerState().current
    if (!track) return
    const listened = positionChannel.getPosition()
    const duration = positionChannel.getDuration() || track.duration || 0
    const completed =
      outcome === 'completed' ||
      (duration > 0 && listened > 0 && listened >= duration - COMPLETION_TOLERANCE_SEC)
    const skipped = outcome === 'skipped'
    void library
      .recordPlayEvent(track, {
        phase: 'end',
        listenedSec: Math.max(0, Math.round(listened)),
        completed,
        skipped,
      })
      .catch(() => {
        /* history is best-effort */
      })
  }

  // ---------- transport ----------

  /**
   * Plays a track. With a `context` (an album, playlist, library list or an
   * explicit "play all") the provided tracks become the user queue. Without a
   * context this is "play now": the chosen track alone becomes the session
   * and autoplay continues around it — a list of search results is never
   * enqueued. The autoplay buffer is preserved and simply re-ranked around
   * the new anchor: the user's upcoming recommendations are never thrown
   * away.
   */
  async play(track: Track, context: PlayContext = {}): Promise<void> {
    const tracks = context.tracks ? dedupeTracks(context.tracks) : null
    let queue: Track[]
    let index: number
    if (tracks) {
      queue = tracks
      index = context.index ?? tracks.findIndex((t) => t.id === track.id)
      if (index < 0) index = 0
      if (playerState().shuffle) queue = shuffleUpcoming(queue, index)
    } else {
      // Play now: this single track replaces the session.
      queue = [track]
      index = 0
    }
    setPlayerState({
      queue,
      index,
      contextLabel: context.label ?? '',
      playingFrom: 'queue',
    })
    this.playStack = []
    await this.start(track)
  }

  /**
   * Plays an autoplay track the user picked directly. It is removed from the
   * buffer (it is playing now) and the rest of the buffer is re-ranked
   * around it — everything else stays queued.
   */
  async playDiscovered(track: Track): Promise<void> {
    recommender.removeById(track.id)
    setPlayerState({ playingFrom: 'autoplay' })
    await this.start(track)
  }

  /** Starts a specific track: clears old state first, then loads. */
  private async start(track: Track, startAt = 0): Promise<void> {
    // Close out the previous listen before anything else changes.
    this.finalizeCurrentPlay()
    // The track that is starting is by definition not "upcoming" anymore,
    // wherever it came from.
    recommender.removeById(track.id)
    const token = this.adapter.beginLoad(track.id)
    this.refillGen = 0
    positionChannel.reset()
    positionChannel.setDuration(track.duration || 0)
    setPlayerState({ current: track, status: 'loading', error: null })
    this.pushPlayed(track)
    lyrics.loadFor(track, () => this.adapter.isCurrent(token))
    this.mirrorToDesktop(track.title, track.artist)

    try {
      await this.adapter.load(token, track, startAt)
    } catch (err) {
      if (!this.adapter.isCurrent(token)) return
      const message = err instanceof Error ? err.message : 'Couldn\u2019t load this song.'
      this.adapter.fail(token, message)
      setPlayerState({ status: 'error', error: message })
    }
    // Whatever moved the anchor (explicit pick, queue advance, autoplay), the
    // recommendations re-rank around it — upcoming tracks are preserved, only
    // their order adapts.
    recommender.reAnchor()
  }

  async toggle(): Promise<void> {
    const { status, current } = playerState()
    if (!current) return
    if (status === 'playing') {
      this.adapter.pause()
      return
    }
    if (status === 'error') {
      await this.start(current, positionChannel.getPosition())
      return
    }
    await this.adapter.play()
  }

  pause(): void {
    this.adapter.pause()
  }

  async resume(): Promise<void> {
    await this.adapter.play()
  }

  /** Manual stop: clears the transport and never advances the queue. */
  stop(): void {
    this.pendingOutcome = 'stopped'
    this.finalizeCurrentPlay()
    this.adapter.stop()
    this.playedTokens.clear()
    this.playStack = []
    positionChannel.reset()
    setPlayerState({ current: null, status: 'idle', error: null, index: -1 })
    lyrics.clear()
    this.mirrorToDesktop('', '')
    this.queueSessionSave()
  }

  async next(): Promise<void> {
    this.noteManualAdvance()
    await this.advance(1, { auto: false })
  }

  /** A manual Next early in the track is a skip; the profile should know. */
  private noteManualAdvance(): void {
    const state = playerState()
    if (!state.current) return
    const listened = positionChannel.getPosition()
    const duration = positionChannel.getDuration() || state.current.duration || 0
    const limit = Math.min(SKIP_THRESHOLD_SEC, duration > 0 ? duration * SKIP_THRESHOLD_RATIO : SKIP_THRESHOLD_SEC)
    this.pendingOutcome = listened < limit ? 'skipped' : 'abandoned'
  }

  async previous(): Promise<void> {
    const state = playerState()
    if (!state.current) return
    if (positionChannel.getPosition() > PREVIOUS_RESTART_THRESHOLD) {
      this.seek(0)
      return
    }
    // While autoplaying (or at the queue head), Previous walks back through
    // what actually played this session.
    if (state.playingFrom === 'autoplay' || state.index <= 0) {
      const entry = this.popPlayed(state.current.id)
      if (entry) {
        if (entry.from === 'queue') setPlayerState({ index: entry.index, playingFrom: 'queue' })
        else setPlayerState({ playingFrom: 'autoplay' })
        await this.start(entry.track)
        return
      }
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
  private async advance(step: number, _opts: { auto: boolean }): Promise<void> {
    const state = playerState()
    const { queue, index, repeat } = state

    if (state.playingFrom === 'autoplay') {
      // Tracks the user queued manually while autoplaying take priority over
      // recommendations, so automatic continuation can never reorder them.
      if (step > 0 && index + 1 < queue.length) {
        setPlayerState({ index: index + 1, playingFrom: 'queue' })
        await this.start(queue[index + 1])
        return
      }
      const started = await this.startNextRecommendation()
      if (started) return
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
    if (step > 0 && useLibraryStore.getState().settings.autoplay) {
      const started = await this.startNextRecommendation()
      if (started) return
    }
    this.finish()
  }

  /**
   * Shifts the next recommendation and starts it. When the buffer is empty a
   * refill is forced once; afterwards the per-track refill keeps it topped up
   * so playback can continue indefinitely.
   */
  private async startNextRecommendation(): Promise<boolean> {
    if (playerState().autoQueue.length === 0) {
      await recommender.ensureBuffered({ force: true })
    }
    const state = playerState()
    if (state.autoQueue.length === 0) return false
    const [next, ...rest] = state.autoQueue
    setPlayerState({ autoQueue: rest, playingFrom: 'autoplay' })
    await this.start(next)
    return true
  }

  /** Reached the end of everything: stop cleanly without clearing the queue. */
  private finish(): void {
    // No next track exists; close out the listen that just ended.
    this.finalizeCurrentPlay()
    this.adapter.stop()
    setPlayerState({ status: 'idle' })
    positionChannel.setPosition(0)
    this.queueSessionSave()
  }

  async playQueueIndex(index: number): Promise<void> {
    const state = playerState()
    const track = state.queue[index]
    if (!track) return
    // An explicit choice re-anchors the recommendations around it, keeping
    // every already-generated upcoming track.
    setPlayerState({ index, playingFrom: 'queue' })
    await this.start(track)
  }

  // ---------- played-stack (Previous during autoplay) ----------

  private pushPlayed(track: Track): void {
    const state = playerState()
    this.playStack.push({ track, from: state.playingFrom, index: state.index })
    if (this.playStack.length > 100) this.playStack.shift()
  }

  /** Pops back to the most recent entry that isn't `currentId`. */
  private popPlayed(currentId: string): PlayedEntry | null {
    while (this.playStack.length > 0) {
      const entry = this.playStack.pop()!
      if (entry.track.id !== currentId) return entry
    }
    return null
  }

  // ---------- seek / volume / rate ----------

  seek(seconds: number): void {
    this.adapter.seek(seconds)
  }

  seekBy(delta: number): void {
    this.seek(positionChannel.getPosition() + delta)
  }

  setVolume(volume: number): void {
    this.adapter.setVolume(volume)
    setPlayerState({ volume, muted: volume === 0 ? playerState().muted : false })
    if (volume > 0) this.adapter.setMuted(false)
    void library.saveSettings({ volume, muted: this.adapter.snapshot().muted })
  }

  toggleMute(): void {
    const muted = !playerState().muted
    this.adapter.setMuted(muted)
    setPlayerState({ muted })
    void library.saveSettings({ muted })
  }

  setSpeed(speed: number): void {
    this.adapter.setRate(speed)
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
    // A track the user queued by hand plays from Up Next; it must not also
    // sit in the autoplay buffer and play twice.
    for (const t of additions) recommender.removeById(t.id)
    setPlayerState({ queue: [...state.queue, ...additions] })
    ui.toast(
      additions.length === 1
        ? `Added “${additions[0].title}” to the queue`
        : `Added ${additions.length} songs to the queue`,
    )
    this.queueSessionSave()
  }

  playNext(tracks: Track[]): void {
    const state = playerState()
    const additions = dedupeTracks(tracks).filter((t) => t.id !== state.current?.id)
    if (additions.length === 0) return
    const remaining = state.queue.filter(
      (t, i) => i <= state.index || !additions.some((a) => a.id === t.id),
    )
    const insertAt = Math.max(state.index + 1, 0)
    const next = [...remaining.slice(0, insertAt), ...additions, ...remaining.slice(insertAt)]
    for (const t of additions) recommender.removeById(t.id)
    setPlayerState({ queue: next })
    ui.toast(
      additions.length === 1
        ? `“${additions[0].title}” plays next`
        : `${additions.length} songs play next`,
    )
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

  /** Removes a single track from the autoplay buffer. */
  removeFromAutoQueue(index: number): void {
    const state = playerState()
    if (index < 0 || index >= state.autoQueue.length) return
    setPlayerState({ autoQueue: state.autoQueue.filter((_, i) => i !== index) })
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

  // ---------- autoplay / recommendations ----------

  /** Empties the recommendation buffer without touching the autoplay setting. */
  clearAutoplay(): void {
    recommender.clear()
    this.queueSessionSave()
  }

  /** Called when the autoplay setting changes. */
  setAutoplay(enabled: boolean): void {
    if (enabled) {
      void recommender.ensureBuffered({ force: true })
    } else {
      this.clearAutoplay()
    }
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
        current: state.current,
        playingFrom: state.playingFrom,
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
  async restoreSession(
    session: {
      queue: Track[]
      autoQueue: Track[]
      index: number
      current?: Track | null
      playingFrom?: 'queue' | 'autoplay'
      position: number
      shuffle: boolean
      repeat: RepeatMode
      speed: number
    },
    autoResume: boolean,
  ): Promise<void> {
    const queue = session.queue ?? []
    const index = Math.min(Math.max(session.index, -1), queue.length - 1)
    const playingFrom = session.playingFrom === 'autoplay' ? 'autoplay' : 'queue'
    // Older sessions have no `current`; an empty object (Go's zero Track)
    // must not count as one either.
    const saved = session.current?.id ? session.current : null
    const current = saved ?? (index >= 0 ? (queue[index] ?? null) : null)
    setPlayerState({
      queue,
      autoQueue: session.autoQueue ?? [],
      index,
      playingFrom,
      shuffle: !!session.shuffle,
      repeat: session.repeat ?? 'off',
      speed: session.speed || 1,
      current,
    })
    if (current) {
      positionChannel.setDuration(current.duration || 0)
      positionChannel.setPosition(session.position || 0)
      if (autoResume) {
        await this.start(current, session.position || 0)
      }
    }
  }
}

export const playback = new PlaybackController()

/** Convenience hook for components that only need a couple of fields. */
export const usePlayer = usePlayerStore
