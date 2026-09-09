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
import { BrowserMediaSession } from '../audio/mediaSession'
import { backend, type RadioKind } from '../bridge/backend'
import type { RepeatMode, Track } from '../bridge/types'
import {
  appendDiscovery, buildDiscoveryBlock, DISCOVERY_RECENT_HISTORY,
  DISCOVERY_REFILL_THRESHOLD, DISCOVERY_TARGET, isUpcomingCandidate,
  prefetchCandidates, reconcileDiscovery, removeCandidate,
  selectNextTrack, type QueueSelection,
} from '../domain/queueEngine'
import { normalizeTitle } from '../lib/discovery'
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

/** Failed/empty same-anchor refills back off instead of retrying every position tick. */
const DISCOVERY_RETRY_DELAY = 15_000
const PREFETCH_LIMIT = 3

interface ActiveRadio {
  id: string
  kind: RadioKind
  seedId: string
  seed?: Partial<Track>
  ids: Set<string>
  titles: Set<string>
}

export class PlaybackController {
  readonly engine: PlaybackEngine
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  private recordedForToken = new Set<number>()
  private discoveryGen = 0
  private discoveryPromise: Promise<void> | null = null
  private discoveryWarned = false
  private discoveryRetryAt = 0
  private lastDiscoveryAnchor = ''
  private activeRadio: ActiveRadio | null = null
  private recentTracks: Track[] = []
  private rejectedTracks: Track[] = []
  private sleepTimer: ReturnType<typeof setTimeout> | null = null
  private readonly mediaSession: BrowserMediaSession
  private prefetchedTracks = new Set<string>()
  private prefetchingTracks = new Set<string>()
  private recoveredTrackId: string | null = null

  constructor(engine = new PlaybackEngine()) {
    this.engine = engine
    this.mediaSession = new BrowserMediaSession({
      play: () => void this.resume(),
      pause: () => this.pause(),
      next: () => void this.next(),
      previous: () => void this.previous(),
      seek: (position) => this.seek(position),
      position: () => positionChannel.getPosition(),
      duration: () => positionChannel.getDuration(),
      rate: () => this.engine.snapshot().rate,
    })
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
        this.mediaSession.setPlaybackState(status)
        this.mediaSession.updatePosition(status === 'playing')
        if (status === 'playing') {
          this.markPlayed()
          // Start or join a current-track refill as soon as playback is ready.
          // It only appends reconciled candidates and never clears either queue.
          void this.refillDiscovery().then(() => this.prefetchNext())
          void this.prefetchNext()
        }
        this.queueSessionSave()
        break
      }
      case 'position': {
        positionChannel.setPosition(event.position)
        this.mediaSession.updatePosition()
        const state = playerState()
        const duration = positionChannel.getDuration()
        const nearingEnd = duration > 0 && duration - event.position <= 45
        const retryDue = this.discoveryRetryAt > 0 && this.discoveryRetryAt <= Date.now()
        if (state.autoQueue.length <= DISCOVERY_REFILL_THRESHOLD && (nearingEnd || retryDue || state.autoQueue.length === 0)) {
          void this.refillDiscovery()
        }
        break
      }
      case 'ended':
        this.handleEnded(event.trackId)
        break
      case 'error': {
        const current = playerState().current
        if (event.recoverable && current && current.id === event.trackId && this.recoveredTrackId !== current.id) {
          this.recoveredTrackId = current.id
          backend().invalidatePlayable?.(current.id)
          void backend().reportPlaybackError?.({
            trackId: current.id,
            code: 'media_interrupted_retrying',
            recoverable: true,
          }).catch(() => {})
          ui.toast('Playback interrupted — refreshing the source…', 'info')
          const resumeAt = positionChannel.getPosition()
          void this.start(current, resumeAt, true)
          return
        }
        if (current) {
          void backend().reportPlaybackError?.({
            trackId: current.id,
            code: event.recoverable ? 'media_recovery_exhausted' : 'media_playback_failed',
            recoverable: false,
          }).catch(() => {})
        }
        ui.toast(event.message, 'error')
        break
      }
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

  /**
   * Plays a track. With a `context` (an album, playlist, library list or an
   * explicit "play all") the provided tracks become the user queue. Without a
   * context this is "play now": the chosen track alone becomes the session and
   * discovery rebuilds around it — a list of search results is never enqueued.
   */
  async play(track: Track, context: PlayContext = {}): Promise<void> {
    const previous = playerState()
    const freshSession = !previous.current && previous.queue.length === 0 && previous.autoQueue.length === 0
    // A deliberate selection re-anchors future discovery, but keeps the ready
    // buffer until replacements arrive. This avoids an empty Up Next on every click.
    this.reanchorDiscovery()
    this.activeRadio = null
    this.rejectedTracks = []
    if (freshSession) this.recentTracks = []
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
    await this.start(track)
  }

  /**
   * Plays a discovered (autoplay) track as the new current track without
   * dropping the user's explicit queue — their manual choices keep outranking
   * discovery. Discovery then rebuilds around the newly chosen track.
   */
  async playDiscovered(track: Track): Promise<void> {
    // Clicking an autoplay item stays inside the same discovery/radio session.
    setPlayerState({
      autoQueue: playerState().autoQueue.filter((candidate) => candidate.id !== track.id),
      playingFrom: 'autoplay',
    })
    await this.start(track)
  }

  /** Starts a specific track: clears old state first, then resolves. */
  private async start(track: Track, startAt = 0, recovering = false): Promise<void> {
    if (!recovering) this.recoveredTrackId = null
    const token = this.engine.beginLoad(track.id)
    this.recordedForToken.clear()
    positionChannel.reset()
    positionChannel.setDuration(track.duration || 0)
    setPlayerState({ current: track, status: 'loading', error: null })
    this.rememberTrack(track)
    this.pruneDiscoveryQueue()
    this.mediaSession.setTrack(track)
    this.mediaSession.setPlaybackState('loading')
    lyrics.loadFor(track, () => this.engine.isCurrent(token))
    this.mirrorToDesktop(track.title, track.artist)

    try {
      const source = await backend().getPlayable(track)
      if (!this.engine.isCurrent(token)) return // a newer track won the race
      if (source.duration > 0) positionChannel.setDuration(source.duration)
      await this.engine.load(token, source.url, startAt)
    } catch (err) {
      if (!this.engine.isCurrent(token)) return
      if (await this.skipUnplayableTrack(track)) return
      const message = err instanceof Error ? err.message : 'Couldn\u2019t load this song.'
      this.engine.fail(token, message)
      setPlayerState({ status: 'error', error: message })
    }
  }

  /**
   * Rejects only the failed candidate, refills discovery, then continues through
   * the canonical explicit-first selection order. A resolver error is surfaced
   * only when no alternative remains.
   */
  private async skipUnplayableTrack(track: Track): Promise<boolean> {
    const state = playerState()
    const source = state.playingFrom
    this.rememberRejected(track)
    this.prefetchedTracks.delete(track.id)
    this.prefetchingTracks.delete(track.id)
    backend().invalidatePlayable?.(track.id)
    void backend().reportPlaybackError?.({
      trackId: track.id,
      code: 'unplayable_candidate_skipped',
      recoverable: true,
    }).catch(() => {})

    const remaining = removeCandidate(state, track.id, source)
    setPlayerState(remaining)
    this.queueSessionSave()
    await this.refillDiscovery(true)
    const selection = selectNextTrack(playerState(), useLibraryStore.getState().settings.autoplay)
    if (!selection) return false
    await this.playSelection(selection)
    return true
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
    this.mediaSession.setTrack(null)
    this.setSleepTimer(null)
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
  private async advance(step: number, _opts: { auto: boolean }): Promise<void> {
    if (step < 0) return
    const autoplay = useLibraryStore.getState().settings.autoplay
    let selection = selectNextTrack(playerState(), autoplay)

    // Keep the last visible discovery items in place while a low-water refill
    // completes; only shift the selected item after append/reconciliation.
    if (selection?.source === 'autoplay' && playerState().autoQueue.length <= DISCOVERY_REFILL_THRESHOLD) {
      await this.refillDiscovery()
      selection = selectNextTrack(playerState(), autoplay)
    }

    // Normal refills happen before this point. This is the bounded final safety
    // net when playback catches an in-flight request at the end of the buffer.
    if (!selection && autoplay) {
      await this.refillDiscovery(true)
      selection = selectNextTrack(playerState(), autoplay)
    }
    if (!selection) {
      this.finish()
      return
    }
    await this.playSelection(selection)
  }

  private async playSelection(selection: QueueSelection): Promise<void> {
    if (selection.source === 'queue') {
      setPlayerState({ index: selection.queueIndex ?? playerState().index, playingFrom: 'queue' })
    } else {
      const state = playerState()
      setPlayerState({
        autoQueue: state.autoQueue[0]?.id === selection.track.id ? state.autoQueue.slice(1) : state.autoQueue,
        playingFrom: 'autoplay',
      })
    }
    await this.start(selection.track)
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
    // Explicit priority changes without destroying the prepared radio buffer.
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
    this.pruneDiscoveryQueue()
    void this.refillDiscovery().then(() => this.prefetchNext())
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
    this.pruneDiscoveryQueue()
    void this.refillDiscovery().then(() => this.prefetchNext())
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
    this.pruneDiscoveryQueue()
    void this.refillDiscovery().then(() => this.prefetchNext())
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

  /** Removes a single track from the discovery (autoplay) list. */
  removeFromAutoQueue(index: number): void {
    const state = playerState()
    if (index < 0 || index >= state.autoQueue.length) return
    setPlayerState({ autoQueue: state.autoQueue.filter((_, i) => i !== index) })
    void this.refillDiscovery().then(() => this.prefetchNext())
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

  /** Starts a named radio session while preserving the user's explicit queue.
   * Hosted builds ask the radio API; desktop falls back to the existing search
   * provider so the same controls remain useful in Wails. */
  async startRadio(kind: RadioKind, seedId: string, seed?: Partial<Track>): Promise<void> {
    let tracks: Track[] = []
    let sessionID = `${kind}:${seedId}`
    try {
      const radio = backend().radio
      if (radio) {
        const session = await radio(kind, seedId, seed)
        sessionID = session.id || sessionID
        tracks = dedupeTracks(session.tracks ?? [])
      } else {
        const query = [seed?.artist, seed?.title, seed?.album, seedId].filter(Boolean).join(' ')
        const result = await backend().search(query, 'songs')
        tracks = dedupeTracks([...(result.songs ?? []), ...(result.videos ?? [])])
      }
    } catch {
      ui.toast("Couldn't start radio — your current queue is unchanged", 'error')
      return
    }
    const { added: fresh } = appendDiscovery(
      [],
      tracks,
      this.discoveryBlock(false, false),
      DISCOVERY_TARGET + 1,
    )
    if (fresh.length === 0) {
      ui.toast('No radio suggestions are available right now', 'error')
      return
    }

    // A successful radio command is the one intentional discovery replacement.
    this.resetDiscovery()
    this.activeRadio = {
      id: sessionID,
      kind,
      seedId,
      seed,
      ids: new Set<string>(),
      titles: new Set<string>(),
    }
    this.markRadioSeen(fresh)
    const [first, ...rest] = fresh
    setPlayerState({
      autoQueue: rest.slice(0, DISCOVERY_TARGET),
      playingFrom: 'autoplay',
      contextLabel: `${kind[0].toUpperCase()}${kind.slice(1)} Radio`,
    })
    await this.start(first)
  }

  /**
   * Resolve several tracks in canonical play order before they are needed. The
   * web adapter caches/coalesces tickets; desktop may omit this optimization.
   * A proven-unplayable upcoming candidate is removed without disturbing any
   * other explicit or discovery ordering, then the buffer is refilled.
   */
  private async prefetchNext(): Promise<void> {
    const prefetch = backend().prefetchPlayable
    if (!prefetch) return
    const candidates = prefetchCandidates(
      playerState(),
      useLibraryStore.getState().settings.autoplay,
      PREFETCH_LIMIT,
    )
    const wanted = new Set(candidates.map((track) => track.id))
    for (const id of this.prefetchedTracks) {
      if (!wanted.has(id)) this.prefetchedTracks.delete(id)
    }

    await Promise.all(candidates.map(async (track) => {
      if (this.prefetchedTracks.has(track.id) || this.prefetchingTracks.has(track.id)) return
      this.prefetchingTracks.add(track.id)
      try {
        await prefetch(track)
        this.prefetchedTracks.add(track.id)
      } catch {
        const state = playerState()
        const source = isUpcomingCandidate(state, track.id)
        if (source) {
          this.rememberRejected(track)
          backend().invalidatePlayable?.(track.id)
          const remaining = removeCandidate(state, track.id, source)
          setPlayerState(remaining)
          void backend().reportPlaybackError?.({
            trackId: track.id,
            code: 'prefetch_candidate_skipped',
            recoverable: true,
          }).catch(() => {})
          this.queueSessionSave()
          await this.refillDiscovery(true)
        }
      } finally {
        this.prefetchingTracks.delete(track.id)
      }
    }))

    const next = prefetchCandidates(
      playerState(),
      useLibraryStore.getState().settings.autoplay,
      PREFETCH_LIMIT,
    )
    if (next.some((track) => !this.prefetchedTracks.has(track.id) && !this.prefetchingTracks.has(track.id))) {
      await this.prefetchNext()
    }
  }

  /** Pause automatically after a fixed number of minutes. Passing null clears
   * the active timer. */
  setSleepTimer(minutes: number | null): void {
    if (this.sleepTimer) {
      clearTimeout(this.sleepTimer)
      this.sleepTimer = null
    }
    if (!minutes || minutes <= 0) {
      setPlayerState({ sleepTimerEndsAt: null })
      return
    }
    const endsAt = Date.now() + minutes * 60_000
    setPlayerState({ sleepTimerEndsAt: endsAt })
    this.sleepTimer = setTimeout(() => {
      this.sleepTimer = null
      this.pause()
      setPlayerState({ sleepTimerEndsAt: null })
      ui.toast('Sleep timer finished')
    }, minutes * 60_000)
  }

  // ---------- autoplay / discovery ----------

  /**
   * Keeps several upcoming discovery tracks ahead of the listener. It is the
   * background continuation that makes playback endless: when the discovery
   * count drops below DISCOVERY_TARGET it fetches more, anchored on the current
   * track (artist first, then the normalized title) so the radio drifts as
   * playback moves on — it never reuses the original search-results array.
   *
   * Concurrency and staleness are guarded: only one fetch runs at a time
   * (discoveryPromise) and every response is validated against discoveryGen, so
   * a slow response — or one superseded by an intentional track change — can
   * never pollute the new track's discovery queue.
   */
  private refillDiscovery(force = false): Promise<void> {
    if (!useLibraryStore.getState().settings.autoplay) return Promise.resolve()
    const state = playerState()
    if (!state.current || state.autoQueue.length >= DISCOVERY_TARGET) return Promise.resolve()

    const anchorID = state.current.id
    if (!force && this.lastDiscoveryAnchor === anchorID && this.discoveryRetryAt > Date.now()) {
      return Promise.resolve()
    }

    if (this.discoveryPromise) {
      const pending = this.discoveryPromise
      return pending.then(() => {
        const latest = playerState()
        if (!useLibraryStore.getState().settings.autoplay || !latest.current || latest.autoQueue.length >= DISCOVERY_TARGET) {
          return
        }
        // A request for A may finish after playback advances to B. Append any
        // useful A results, then always give B its own anchored top-up.
        if (latest.current.id !== anchorID || this.lastDiscoveryAnchor !== latest.current.id) {
          return this.refillDiscovery(force)
        }
      })
    }

    let promise: Promise<void>
    promise = this.doDiscoveryFetch(anchorID).finally(() => {
      if (this.discoveryPromise === promise) this.discoveryPromise = null
    })
    this.discoveryPromise = promise
    return promise
  }

  private discoveryBlock(includeAutoplay = true, includeRadio = true) {
    return buildDiscoveryBlock({
      state: playerState(),
      history: useLibraryStore.getState().history,
      recent: [...this.recentTracks, ...this.rejectedTracks],
      radioSeen: includeRadio ? this.activeRadio : null,
      includeAutoplay,
    })
  }

  private rememberTrack(track: Track): void {
    const key = normalizeTitle(track.title)
    this.recentTracks = [
      track,
      ...this.recentTracks.filter((candidate) => (
        candidate.id !== track.id && (!key || normalizeTitle(candidate.title) !== key)
      )),
    ].slice(0, DISCOVERY_RECENT_HISTORY)
  }

  private rememberRejected(track: Track): void {
    const key = normalizeTitle(track.title)
    this.rejectedTracks = [
      track,
      ...this.rejectedTracks.filter((candidate) => (
        candidate.id !== track.id && (!key || normalizeTitle(candidate.title) !== key)
      )),
    ].slice(0, DISCOVERY_RECENT_HISTORY)
  }

  private markRadioSeen(tracks: Track[]): void {
    if (!this.activeRadio) return
    for (const track of tracks) {
      this.activeRadio.ids.add(track.id)
      const title = normalizeTitle(track.title)
      if (title) this.activeRadio.titles.add(title)
    }
  }

  private pruneDiscoveryQueue(): void {
    const state = playerState()
    if (state.autoQueue.length === 0) return
    const next = reconcileDiscovery(state.autoQueue, this.discoveryBlock(false, false), DISCOVERY_TARGET)
    if (next.length !== state.autoQueue.length || next.some((track, index) => track.id !== state.autoQueue[index]?.id)) {
      setPlayerState({ autoQueue: next })
    }
  }

  private async doDiscoveryFetch(anchorID: string): Promise<void> {
    const gen = this.discoveryGen
    const state = playerState()
    const current = state.current
    if (!current || current.id !== anchorID) return

    this.lastDiscoveryAnchor = anchorID
    const needed = Math.max(0, DISCOVERY_TARGET - state.autoQueue.length)
    if (needed === 0) return

    const block = this.discoveryBlock()
    const candidates: Track[] = []
    let failed = false
    const collect = (tracks: Track[]): void => {
      const { added } = appendDiscovery(candidates, dedupeTracks(tracks), block, needed)
      for (const track of added) {
        candidates.push(track)
        block.ids.add(track.id)
        const title = normalizeTitle(track.title)
        if (title) block.titles.add(title)
      }
    }

    const radio = backend().radio
    if (radio) {
      const requests: Array<{ kind: RadioKind; seedId: string; seed?: Partial<Track> }> = []
      if (this.activeRadio) requests.push(this.activeRadio)
      if (!this.activeRadio || this.activeRadio.seedId !== (current.sourceId || current.id)) {
        requests.push({ kind: 'song', seedId: current.sourceId || current.id, seed: current })
      }
      for (const request of requests) {
        if (candidates.length >= needed) break
        try {
          const session = await radio(request.kind, request.seedId, request.seed)
          collect(session.tracks ?? [])
          failed = false
        } catch {
          failed = true
        }
      }
    }

    // A valid but short radio batch is supplemented only to the bounded target.
    // Search results themselves never become or replace either queue.
    if (candidates.length < needed) {
      const artist = (current.artist || '').split(',')[0].trim()
      const queries = [...new Set([`${artist} ${current.title}`.trim(), artist].filter(Boolean))]
      for (const query of queries) {
        if (candidates.length >= needed) break
        try {
          const result = await backend().search(query, 'songs')
          collect([...(result.songs ?? []), ...(result.videos ?? [])])
          failed = false
        } catch {
          failed = true
        }
      }
    }

    // Manual context changes invalidate stale work. Ordinary transitions do not:
    // a slightly late result remains useful after reconciliation with latest state.
    if (gen !== this.discoveryGen) return
    const latest = playerState()
    if (!useLibraryStore.getState().settings.autoplay || !latest.current) return

    const { queue, added } = appendDiscovery(
      latest.autoQueue,
      candidates,
      this.discoveryBlock(),
      DISCOVERY_TARGET,
    )
    if (added.length > 0) {
      setPlayerState({ autoQueue: queue })
      this.markRadioSeen(added)
      const remaining = queue.length
      this.discoveryRetryAt = remaining <= DISCOVERY_REFILL_THRESHOLD ? Date.now() + DISCOVERY_RETRY_DELAY : 0
      this.discoveryWarned = false
      return
    }

    if (latest.autoQueue.length < DISCOVERY_TARGET) {
      this.discoveryRetryAt = Date.now() + DISCOVERY_RETRY_DELAY
    }
    if (failed && !this.discoveryWarned) {
      this.discoveryWarned = true
      ui.toast("Couldn't load more suggestions — will retry", 'error')
    }
  }

  /** Empties the discovery list without touching the autoplay setting. */
  clearAutoplay(): void {
    this.resetDiscovery()
  }

  private reanchorDiscovery(): void {
    this.discoveryGen += 1
    this.discoveryWarned = false
    this.discoveryRetryAt = 0
    this.lastDiscoveryAnchor = ''
    this.discoveryPromise = null
    this.prefetchedTracks.clear()
  }

  private resetDiscovery(): void {
    this.reanchorDiscovery()
    this.activeRadio = null
    setPlayerState({ autoQueue: [] })
  }

  /** Called when the autoplay setting changes. */
  setAutoplay(enabled: boolean): void {
    if (enabled) {
      void this.refillDiscovery()
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
    this.reanchorDiscovery()
    this.activeRadio = null
    this.rejectedTracks = []
    setPlayerState({
      queue,
      autoQueue: session.autoQueue ?? [],
      index,
      shuffle: !!session.shuffle,
      repeat: session.repeat ?? 'off',
      speed: session.speed || 1,
      current: index >= 0 ? queue[index] ?? null : null,
      playingFrom: 'queue',
    })
    this.recentTracks = []
    if (index >= 0 && queue[index]) this.rememberTrack(queue[index])
    this.pruneDiscoveryQueue()
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
