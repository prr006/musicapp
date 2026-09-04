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
import type { PlayableSource, RepeatMode, Track } from '../bridge/types'
import {
  buildRadioBatch, canonicalSongKey, DIVERSITY, identityKeyOf,
  MAX_RADIO_DURATION, MIN_RADIO_DURATION, poolConcentration, radioSeedFromTrack,
  splitArtists, verifiedSeedContext, W_DRIFT_SOURCE, W_TASTE_SOURCE,
  type CandidatePool, type RadioContext, type RadioKind, type RadioSeed,
} from '../lib/radio'
import { tasteSnapshot, type TasteSnapshot } from '../lib/taste'
import { dedupeTracks, moveItem, shuffleUpcoming } from '../lib/queue'
import { library, useLibraryStore } from './libraryStore'
import { lyrics } from './lyricsStore'
import { playerState, setPlayerState, usePlayerStore } from './playerStore'
import { positionChannel } from './positionChannel'
import { timerChannel } from './timerChannel'
import { ui } from './uiStore'

export interface PlayContext {
  tracks?: Track[]
  index?: number
  label?: string
}

const SESSION_SAVE_DEBOUNCE = 1500
/**
 * Pre-resolution bounds: a resolver answer may be reused for a few minutes
 * (streams expire), at most a couple of entries are kept, and the prefetch
 * itself waits until the current track is actually listenable. Audio bytes
 * are never pre-downloaded — only the URL is obtained early.
 */
const PLAYABLE_TTL_MS = 5 * 60_000
const PLAYABLE_CACHE_MAX = 3
const PREFETCH_DELAY_MS = 1500

// ---- click-to-play diagnostics ([play-latency]) ----
//
// Opt-in via localStorage.setItem('melo:play-latency', '1') (or the
// MELO_PLAY_LATENCY env var for the Go-side resolver lines). Completely silent
// otherwise — these exist to time the real click → first-audio path:
// CLICK → PLAY_REQUEST → RESOLVE_START/END → SRC_SET → PLAY_CALL → CANPLAY →
// FIRST_PLAYING → TOTAL.
function latencyOn(): boolean {
  try {
    return localStorage.getItem('melo:play-latency') === '1'
  } catch {
    return false
  }
}
function playLatency(stage: string, info = ''): void {
  if (!latencyOn()) return
  // eslint-disable-next-line no-console
  console.debug(`[play-latency] ${stage}${info ? ' ' + info : ''}`)
}
const PREVIOUS_RESTART_THRESHOLD = 3

/** Discovery (autoplay) keeps at least this many upcoming tracks ready. */
const DISCOVERY_TARGET = 8
/** Hard bound on the autoplay list: radio stays lightweight and fresh. */
const DISCOVERY_MAX = 20
/** Upper bound for how many candidates one discovery fetch may add. */
const DISCOVERY_BATCH = 20
/** A listen counts as "significant" after this many seconds (or half the song). */
const SIGNIFICANT_LISTEN_SECONDS = 30
/**
 * A radio whose identity is a catalog (an artist or an album): the only
 * radios allowed to use artist/album text search as a fallback. Song Radio
 * (`kind: 'track'`) is deliberately excluded — see catalogFallbackQueries.
 */
export type CatalogRadioSeed = RadioSeed & { kind: 'artist' } | RadioSeed & { kind: 'album' }

/** Narrows a seed to the catalog radios (compiler-enforced at the call site). */
function isCatalogRadio(seed: RadioSeed): seed is CatalogRadioSeed {
  return seed.kind === 'artist' || seed.kind === 'album'
}

/** How much of the listening session feeds the radio context. */
const SESSION_WINDOW = 12
/**
 * How much of the autoplay list survives a track transition before a fresh,
 * newly-anchored batch is appended: the listener's visible upcoming list
 * stays stable while the deep, never-heard tail makes room for candidates
 * generated from the NEW current track and session.
 */
const DISCOVERY_KEEP_ON_TRANSITION = 8
/**
 * Bounded same-anchor retry budget, counted in FAILED generations: with 2,
 * an anchor gets its initial attempt plus exactly one automatic retry when
 * the provider genuinely failed. A generation that COMPLETED — even with
 * zero candidates — never re-fetches the same anchor: an empty or low
 * autoplay list is not a reason to request identical recommendations again.
 */
const MAX_ANCHOR_RETRIES = 2
/** Broadening fetch budget per refill: session drift anchors + taste anchors. */
const MAX_DRIFT_ANCHORS_PER_REFILL = 2
const MAX_TASTE_ANCHORS_PER_REFILL = 1

/** Seconds after which a listen counts as significant: 30s or half the song. */
function significantAt(track: Track): number {
  if (track.duration > 0) return Math.min(SIGNIFICANT_LISTEN_SECONDS, track.duration / 2)
  return SIGNIFICANT_LISTEN_SECONDS
}

export class PlaybackController {
  readonly engine: PlaybackEngine
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
  /** Wall-clock sleep timer tick (1 Hz). Owned here so it survives rerenders. */
  private sleepTimerTick: ReturnType<typeof setInterval> | null = null
  /**
   * Resolver answers for the IMMEDIATE next track, keyed by track id. This is
   * pre-resolution only (a URL obtained early); audio bytes are never
   * pre-downloaded. Bounded to a couple of entries and a short TTL.
   */
  private playableCache = new Map<string, { source: PlayableSource; at: number }>()
  /** Track ids with a prefetch in flight, so the same URL is never resolved twice. */
  private prefetchInFlight = new Set<string>()
  private prefetchTimer: ReturnType<typeof setTimeout> | null = null
  private recordedForToken = new Set<number>()
  /** Tokens whose listen crossed the "significant" threshold. */
  private significantForToken = new Set<number>()
  /** Tokens that reached the natural end (or were recorded as skipped). */
  private concludedForToken = new Set<number>()
  private discoveryGen = 0
  private discoveryPromise: Promise<void> | null = null
  private discoveryWarned = false
  /** Engine generation that has already kicked off a discovery refill. */
  private discoveryRefillGen = 0
  /**
   * The track id the last discovery generation was anchored on. A refill
   * only re-anchors when the current track differs — re-starting the same
   * track (seek, repeat-one) is not a meaningful transition.
   */
  private discoveryAnchorId: string | null = null
  /** Anchor ids whose discovery generation COMPLETED (any yield, incl. empty). */
  private discoveryAnchorsDone = new Set<string>()
  /** Failed attempts per anchor id — a failed generation may retry, bounded. */
  private discoveryAnchorRetries = new Map<string, number>()
  /** An explicit artist/album seed from Start Radio; holds until playback moves on. */
  private explicitSeed: RadioSeed | null = null
  /**
   * The listening session: tracks actually played recently, most recent first
   * (bounded). This is the drift context — if the listener moves from anime
   * OSTs into phonk, these entries carry the radio along without any
   * hard-coded genre transition.
   */
  private sessionRecent: Track[] = []
  /** Anchor track ids whose recommendation feed was already fetched this session. */
  private sessionAnchorsTried = new Set<string>()

  /** Click-to-play timing stamps for the load currently in flight. */
  private latencyClickAt = 0
  private latencyResolveStartAt = 0
  private latencyResolveEndAt = 0
  private latencyTotalLoggedFor = -1

  constructor(engine = new PlaybackEngine()) {
    this.engine = engine
    this.engine.subscribe((event) => this.onEngineEvent(event))
    // Handoff stages come straight from the media element so the timeline is
    // real, not reconstructed. A localStorage read per stage is negligible:
    // stages fire a handful of times per track.
    this.engine.debugHook = (stage, info) => {
      if (stage === 'SRC_SET') {
        playLatency('SRC_SET', info ?? '')
      } else if (stage === 'FIRST_PLAYING') {
        playLatency('FIRST_PLAYING')
        this.logLatencyTotal('FIRST_PLAYING')
      } else {
        playLatency(stage)
      }
    }
    // Disliked tracks disappear from the current autoplay list immediately;
    // the next batch also excludes them via the ranking context.
    useLibraryStore.subscribe((state, prev) => {
      if (state.disliked === prev.disliked) return
      const disliked = new Set(state.disliked.map((t) => t.id))
      const auto = playerState().autoQueue
      if (auto.some((t) => disliked.has(t.id))) {
        setPlayerState({ autoQueue: auto.filter((t) => !disliked.has(t.id)) })
        this.queueSessionSave()
      }
    })
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
          this.logLatencyTotal('STATUS_PLAYING') // no-op unless FIRST_PLAYING hasn't already logged
          this.markPlayed()
          // Refill discovery once per track (generation), not on every state
          // emission — otherwise duration/buffered updates would keep
          // re-searching the same anchor query. When the track that started
          // playing is a NEW anchor (a different song became current), the
          // radio re-anchors: the next few upcoming tracks are kept and a
          // fresh batch is generated from the new current track + session.
          if (this.discoveryRefillGen !== this.engine.currentGeneration) {
            this.discoveryRefillGen = this.engine.currentGeneration
            const current = playerState().current
            const isTransition = !!current && current.id !== this.discoveryAnchorId
            if (isTransition) {
              this.radioDebug(
                `ON TRACK TRANSITION old=${this.discoveryAnchorId ?? 'none'} new=${current?.id} ` +
                `reason=${playerState().playingFrom === 'autoplay' ? 'autoplay' : 'user queue/manual'}`,
              )
            }
            void this.refillDiscovery(isTransition)
          }
          // Warm the immediate next track (URL + artwork) in the background.
          this.scheduleNextPrefetch()
        }
        this.queueSessionSave()
        break
      }
      case 'position':
        positionChannel.setPosition(event.position)
        this.checkSignificant()
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
    this.recordConclusion('completed')
    // Sleep timer "end of track": the natural completion IS the deadline. The
    // completed event above is the real, ladder-earned history entry — no
    // fabricated one — and playback simply does not advance.
    if (state.sleepTimer?.mode === 'endOfTrack') {
      this.clearSleepTimer()
      positionChannel.setPosition(0)
      this.seek(0)
      this.engine.pause()
      this.queueSessionSave()
      return
    }
    if (state.repeat === 'one') {
      positionChannel.setPosition(0)
      this.engine.restart()
      return
    }
    void this.advance(1, { auto: true })
  }

  /** Tray tooltip / notification mirroring. Best-effort and never blocking. */
  private mirrorToDesktop(title: string, artist: string): void {
    try {
      void backend()
        .setNowPlaying(title, artist)
        .catch(() => {
          /* desktop mirroring is cosmetic; a failure must not affect playback */
        })
    } catch {
      /* same guarantee for backends that are not fully wired (tests) */
    }
  }

  private markPlayed(): void {
    const token = this.engine.currentGeneration
    if (this.recordedForToken.has(token)) return
    const current = playerState().current
    if (!current) return
    this.recordedForToken.add(token)
    this.radioDebug(`PLAY CURRENT=${current.id}`)
    this.rememberInSession(current)
    void library.recordPlayEvent(current, 'play_started').catch(() => {
      /* history is best-effort; the error surfaces through the store */
    })
  }

  /** Records a played track in the bounded session profile. */
  private rememberInSession(track: Track): void {
    if (this.sessionRecent[0]?.id === track.id) return
    this.sessionRecent = [track, ...this.sessionRecent.filter((t) => t.id !== track.id)].slice(0, SESSION_WINDOW)
  }

  /** Starts a fresh session context (new radio / stop). */
  private resetSessionContext(): void {
    this.sessionRecent = []
    this.sessionAnchorsTried = new Set()
  }

  /**
   * PLAYED_SIGNIFICANTLY: the listen crossed the "real listen" threshold
   * (30 seconds or half the song, whichever comes first). Recorded at most
   * once per track — never per position tick.
   */
  private checkSignificant(): void {
    const token = this.engine.currentGeneration
    if (this.significantForToken.has(token)) return
    if (!this.recordedForToken.has(token)) return // never started playing
    const current = playerState().current
    if (!current) return
    if (positionChannel.getPosition() < significantAt(current)) return
    this.significantForToken.add(token)
    void library.recordPlayEvent(current, 'played_significantly').catch(() => {})
  }

  /**
   * COMPLETED (natural end) or SKIPPED (manual next before a real listen).
   * Recorded at most once per track; both count as "concluded".
   */
  private recordConclusion(event: 'completed' | 'skipped'): void {
    const token = this.engine.currentGeneration
    if (this.concludedForToken.has(token)) return
    if (!this.recordedForToken.has(token)) return // nothing was really played
    this.concludedForToken.add(token)
    const current = playerState().current
    if (!current) return
    void library.recordPlayEvent(current, event).catch(() => {})
  }

  /**
   * A manual "next" before the significant threshold is a skip — a weaker
   * negative signal than an explicit dislike (see the radio ranker).
   */
  private recordSkipIfEarly(): void {
    const current = playerState().current
    if (!current) return
    if (positionChannel.getPosition() < significantAt(current)) {
      this.recordConclusion('skipped')
    }
  }

  // ---------- transport ----------

  /**
   * Plays a track. With a `context` (an album, playlist, library list or an
   * explicit "play all") the provided tracks become the user queue. Without a
   * context this is "play now": the chosen track alone becomes the session and
   * discovery rebuilds around it — a list of search results is never enqueued.
   */
  async play(track: Track, context: PlayContext = {}): Promise<void> {
    // Any explicit choice supersedes discovery: stale continuations are dropped
    // and rebuilt from the new listening context as needed.
    this.markLatencyClick('CLICK', `track=${track.id} sourceId=${track.sourceId}`)
    this.resetDiscovery()
    this.explicitSeed = null
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
    this.markLatencyClick('CLICK', `track=${track.id} sourceId=${track.sourceId} via=autoplay`)
    this.resetDiscovery()
    setPlayerState({ playingFrom: 'autoplay' })
    await this.start(track)
  }

  /**
   * START RADIO: replaces the session with the selected track as the radio
   * seed and builds a fresh autoplay queue around it. Sibling search results
   * are never enqueued — the queue contains exactly the chosen track, and
   * everything after it is MELO-generated.
   *
   * `kind` anchors the first batch tighter: 'artist'/'album' seeds keep the
   * radio on the artist/album the user started from until playback drifts on.
   */
  async startRadio(track: Track, opts: { kind?: RadioKind; label?: string } = {}): Promise<void> {
    const kind = opts.kind ?? 'track'
    this.markLatencyClick('CLICK', `track=${track.id} sourceId=${track.sourceId} via=radio:${kind}`)
    this.resetDiscovery()
    this.resetSessionContext()
    this.explicitSeed = radioSeedFromTrack(track, kind)
    const label =
      opts.label ??
      (kind === 'artist'
        ? `Artist radio · ${track.artist.split(',')[0]?.trim() || track.artist}`
        : kind === 'album' && track.album
          ? `Album radio · ${track.album}`
          : `Radio · ${track.title}`)
    setPlayerState({ queue: [track], index: 0, contextLabel: label, playingFrom: 'queue' })
    await this.start(track)
  }

  /** Records the user-intent instant (the click handler calls play()
   *  synchronously, so this is the honest CLICK stamp) and arms a fresh TOTAL. */
  private markLatencyClick(stage: string, info: string): void {
    if (!latencyOn()) return
    this.latencyClickAt = performance.now()
    this.latencyTotalLoggedFor = -1
    playLatency(stage, info)
  }

  /** Starts a specific track: clears old state first, then resolves. */
  private async start(track: Track, startAt = 0): Promise<void> {
    playLatency('PLAY_REQUEST', `track=${track.id} startAt=${startAt}`)
    const token = this.engine.beginLoad(track.id)
    this.recordedForToken.clear()
    this.significantForToken.clear()
    this.concludedForToken.clear()
    this.discoveryRefillGen = 0
    positionChannel.reset()
    positionChannel.setDuration(track.duration || 0)
    setPlayerState({ current: track, status: 'loading', error: null })
    lyrics.loadFor(track, () => this.engine.isCurrent(token))
    this.mirrorToDesktop(track.title, track.artist)

    try {
      // Pre-resolution: if the immediate-next prefetch already answered for
      // this exact track, use it and skip the resolver round trip.
      this.latencyResolveStartAt = performance.now()
      let source: PlayableSource | null = this.takePlayable(track)
      if (source) {
        this.latencyResolveEndAt = performance.now()
        playLatency('RESOLVE_END', 'elapsed=0ms cache=prefetch')
      } else {
        playLatency('RESOLVE_START', `sourceId=${track.sourceId}`)
        source = await backend().getPlayable(track)
        this.latencyResolveEndAt = performance.now()
        playLatency(
          'RESOLVE_END',
          `elapsed=${Math.round(this.latencyResolveEndAt - this.latencyResolveStartAt)}ms cache=network`,
        )
      }
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
    this.significantForToken.clear()
    this.concludedForToken.clear()
    this.resetSessionContext()
    // An explicit stop ends the listening session — a sleep timer that would
    // "pause" nothing later would be a lie in the UI.
    this.clearSleepTimer()
    this.clearPrefetch()
    positionChannel.reset()
    setPlayerState({ current: null, status: 'idle', error: null, index: -1 })
    lyrics.clear()
    this.mirrorToDesktop('', '')
    this.queueSessionSave()
  }

  async next(): Promise<void> {
    this.recordSkipIfEarly()
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
    const state = playerState()
    const { queue, index, repeat } = state

    if (state.playingFrom === 'autoplay') {
      // Tracks the user queued manually while autoplaying take priority over
      // discovery, so automatic continuation can never reorder their choices.
      if (step > 0 && index + 1 < queue.length) {
        setPlayerState({ index: index + 1, playingFrom: 'queue' })
        await this.start(queue[index + 1])
        return
      }
      const started = await this.startNextDiscovery()
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
      const started = await this.startNextDiscovery()
      if (started) return
    }
    this.finish()
  }

  /** Shifts the next discovery track and starts it; false when none is left. */
  private async startNextDiscovery(): Promise<boolean> {
    // Only fetch when there is literally nothing to shift. Otherwise the
    // per-track refill (kicked off when the new track starts playing) keeps
    // the pipeline topped up, anchored on the new current track.
    if (playerState().autoQueue.length === 0) await this.refillDiscovery()
    const state = playerState()
    if (state.autoQueue.length === 0) return false
    const [next, ...rest] = state.autoQueue
    setPlayerState({ autoQueue: rest, playingFrom: 'autoplay' })
    await this.start(next)
    return true
  }

  /** Reached the end of everything: stop cleanly without clearing the queue. */
  private finish(): void {
    this.engine.stop()
    // Nothing is playing any more, so an end-of-track deadline can never fire;
    // wall-clock timers stay armed for the next listen by design.
    if (playerState().sleepTimer?.mode === 'endOfTrack') this.clearSleepTimer()
    setPlayerState({ status: 'idle' })
    positionChannel.setPosition(0)
    this.queueSessionSave()
  }

  async playQueueIndex(index: number): Promise<void> {
    const state = playerState()
    const track = state.queue[index]
    if (!track) return
    // An explicit choice of a queued track re-anchors discovery around it.
    this.resetDiscovery()
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

  /**
   * One TOTAL line per load generation: click → first audible playback, with
   * the resolver stage split out so the dominant cost is obvious.
   */
  private logLatencyTotal(trigger: string): void {
    const gen = this.engine.currentGeneration
    if (this.latencyTotalLoggedFor === gen) return
    this.latencyTotalLoggedFor = gen
    const now = performance.now()
    const total = this.latencyClickAt ? Math.round(now - this.latencyClickAt) : 0
    const resolve = this.latencyResolveStartAt ? Math.round(this.latencyResolveEndAt - this.latencyResolveStartAt) : 0
    const handoff = this.latencyResolveEndAt ? Math.round(now - this.latencyResolveEndAt) : 0
    playLatency('TOTAL', `total=${total}ms resolve=${resolve}ms handoff=${handoff}ms on=${trigger}`)
  }

  setSpeed(speed: number): void {
    this.engine.setRate(speed)
    setPlayerState({ speed })
    // The chosen speed is a persistent player setting, not a per-track whim:
    // it survives restarts (main.tsx re-applies defaultSpeed).
    void library.saveSettings({ defaultSpeed: speed })
  }

  /**
   * SLEEP TIMER. `preset` is minutes (15/30/45/60), 'endOfTrack', or null to
   * cancel. The tick lives in the controller (so it survives rerenders), its
   * state mirrors into the player store (one source of truth) and only the
   * small countdown readout subscribes to the per-second timerChannel. The
   * timer only ever PAUSES playback: the user queue, autoplay, the radio seed
   * and the history ladder are untouched, and expiry while already paused is
   * a no-op. Starting a new timer always replaces the previous one.
   */
  setSleepTimer(preset: number | 'endOfTrack' | null): void {
    this.stopSleepTick()
    if (preset === null) {
      this.clearSleepTimer()
      return
    }
    if (preset === 'endOfTrack') {
      // No wall clock: handleEnded() treats natural completion as the deadline.
      setPlayerState({ sleepTimer: { mode: 'endOfTrack', endsAt: null, minutes: null } })
      timerChannel.setRemaining(null)
      return
    }
    const minutes = Math.max(1, Math.min(600, Math.round(Number(preset) || 0)))
    const endsAt = Date.now() + minutes * 60_000
    setPlayerState({ sleepTimer: { mode: 'duration', endsAt, minutes } })
    timerChannel.setRemaining(endsAt - Date.now())
    this.sleepTimerTick = setInterval(() => {
      const remaining = endsAt - Date.now()
      if (remaining <= 0) {
        this.clearSleepTimer()
        if (playerState().current) this.engine.pause()
        return
      }
      timerChannel.setRemaining(remaining)
    }, 1000)
  }

  private clearSleepTimer(): void {
    this.stopSleepTick()
    setPlayerState({ sleepTimer: null })
    timerChannel.setRemaining(null)
  }

  private stopSleepTick(): void {
    if (this.sleepTimerTick) {
      clearInterval(this.sleepTimerTick)
      this.sleepTimerTick = null
    }
  }

  // ---------- next-track pre-resolution ----------

  /** A cached resolver answer for exactly this track, single-use, TTL-bounded. */
  private takePlayable(track: Track): PlayableSource | null {
    const hit = this.playableCache.get(track.id)
    if (!hit) return null
    this.playableCache.delete(track.id)
    if (Date.now() - hit.at > PLAYABLE_TTL_MS) return null
    if (hit.source.trackId !== track.id) return null
    return hit.source
  }

  /**
   * Debounced: while the user actually listens, resolve the stream URL of the
   * IMMEDIATE next track (the same one advance() would pick — user queue
   * first, then autoplay) and warm its artwork. One track, one request, best
   * effort: a failed prefetch is silent and the real start() resolves again.
   * The next click on Next/EOF therefore skips a resolver round trip.
   */
  private scheduleNextPrefetch(): void {
    if (this.prefetchTimer) clearTimeout(this.prefetchTimer)
    this.prefetchTimer = setTimeout(() => {
      this.prefetchTimer = null
      const state = playerState()
      if (state.status !== 'playing') return
      const next = state.queue[state.index + 1] ?? state.autoQueue[0]
      if (!next || next.id === state.current?.id) return
      this.prefetchArtwork(next)
      if (this.playableCache.has(next.id) || this.prefetchInFlight.has(next.id)) return
      this.prefetchInFlight.add(next.id)
      void backend()
        .getPlayable(next)
        .then((source) => {
          if (source.trackId !== next.id) return
          this.playableCache.set(next.id, { source, at: Date.now() })
          while (this.playableCache.size > PLAYABLE_CACHE_MAX) {
            const oldest = this.playableCache.keys().next().value
            if (oldest === undefined) break
            this.playableCache.delete(oldest)
          }
        })
        .catch(() => {
          /* prefetch is best-effort; start() resolves again when needed */
        })
        .finally(() => this.prefetchInFlight.delete(next.id))
    }, PREFETCH_DELAY_MS)
  }

  /** Metadata/artwork early: let the browser cache the next cover image. */
  private prefetchArtwork(track: Track): void {
    if (!track.artwork) return
    try {
      const img = new Image()
      img.src = track.artwork
    } catch {
      /* cosmetic only */
    }
  }

  private clearPrefetch(): void {
    if (this.prefetchTimer) {
      clearTimeout(this.prefetchTimer)
      this.prefetchTimer = null
    }
    this.playableCache.clear()
    this.prefetchInFlight.clear()
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

  /** Removes a single track from the discovery (autoplay) list. */
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

  // ---------- autoplay / radio ----------

  /**
   * Keeps several upcoming discovery tracks ahead of the listener — the
   * background continuation that makes playback endless, anchored on the
   * track that is currently playing (never on a search-results list).
   *
   * Two triggers, both meaningful (never duration/buffer/state noise):
   *  - a track TRANSITION (a different song became current): the radio
   *    re-anchors on it. The visible upcoming list is preserved up to
   *    DISCOVERY_KEEP_ON_TRANSITION tracks; only the deep, never-heard tail
   *    is dropped to make room for a fresh, newly-anchored batch, so the
   *    queue evolves with the session instead of remaining anchored to the
   *    first song for the whole session;
   *  - a QUANTITY shortfall (the autoplay list dropped below
   *    DISCOVERY_TARGET): plain top-up.
   *
   * Concurrency and staleness are guarded: only one fetch runs at a time
   * (discoveryPromise) and every response is validated against discoveryGen, so
   * a slow response — or one superseded by an intentional track change — can
   * never pollute the new track's discovery queue. If a fetch is already in
   * flight when a transition happens, that transition is simply picked up by
   * the next one — never queued behind the media element.
   */
  private refillDiscovery(onTransition = false): Promise<void> {
    if (!useLibraryStore.getState().settings.autoplay) return Promise.resolve()
    const state = playerState()
    if (!state.current) return Promise.resolve()
    const anchorId = state.current.id
    const freshAnchor = anchorId !== this.discoveryAnchorId
    if (freshAnchor || onTransition) {
      this.radioDebug(
        `ON REFILL current=${anchorId} lastAnchor=${this.discoveryAnchorId ?? 'none'} ` +
        `why=${onTransition ? 'track transition' : 'new anchor'} autoQueue=${state.autoQueue.length}`,
      )
      this.discoveryAnchorId = anchorId
      if (state.autoQueue.length > DISCOVERY_KEEP_ON_TRANSITION) {
        // Bounded evolution: keep what the listener is about to hear, drop
        // only the never-heard tail, and generate fresh candidates. The
        // visible list is never emptied — the kept head stays usable while
        // the fresh generation is fetched.
        setPlayerState({ autoQueue: state.autoQueue.slice(0, DISCOVERY_KEEP_ON_TRANSITION) })
      }
    } else {
      // INVARIANT: the same current track never gets a second generation
      // merely because the autoplay list is empty or low. A COMPLETED
      // generation (even one that yielded nothing) is final for its anchor;
      // only a FAILED generation may retry, at most MAX_ANCHOR_RETRIES times.
      if (this.discoveryAnchorsDone.has(anchorId)) {
        this.radioDebug(
          `ON REFILL current=${anchorId} lastAnchor=${anchorId} why=quantity(low queue ${state.autoQueue.length}) -> SKIPPED (anchor already generated)`,
        )
        return Promise.resolve()
      }
      const retries = this.discoveryAnchorRetries.get(anchorId) ?? 0
      if (retries >= MAX_ANCHOR_RETRIES) {
        this.radioDebug(
          `ON REFILL current=${anchorId} lastAnchor=${anchorId} why=retry -> SKIPPED (retry budget exhausted: ${retries})`,
        )
        return Promise.resolve()
      }
      this.radioDebug(
        `ON REFILL current=${anchorId} lastAnchor=${anchorId} why=legitimate retry after failure (attempt ${retries + 1}) autoQueue=${state.autoQueue.length}`,
      )
    }
    if (this.discoveryPromise) return this.discoveryPromise
    let promise: Promise<void>
    promise = this.doDiscoveryFetch(anchorId).finally(() => {
      if (this.discoveryPromise === promise) this.discoveryPromise = null
    })
    this.discoveryPromise = promise
    return promise
  }

  /**
   * Forwards a radio-lifecycle line to the backend log (visible in the same
   * terminal channel as the Go REQUEST/SEED/SOURCE blocks when the app runs
   * with MELO_RADIO_DEBUG=1). Diagnostics only; failures are swallowed.
   */
  private radioDebug(line: string): void {
    try {
      void backend().logRadio?.(line)
    } catch {
      /* diagnostics must never affect playback */
    }
  }

  /**
   * The seed the current radio is anchored on. A Song radio re-anchors on the
   * current track for every refill (the session profile provides the drift).
   * Artist/Album radios keep their explicit anchor for the whole session so
   * they stay legitimately artist/album-heavy; any manual play() drops it.
   */
  private currentSeed(): RadioSeed | null {
    const current = playerState().current
    if (!current) return null
    if (this.explicitSeed && this.explicitSeed.kind !== 'track') return this.explicitSeed
    if (this.explicitSeed && this.explicitSeed.id === current.id) return this.explicitSeed
    return radioSeedFromTrack(current)
  }

  /**
   * Collects everything the ranker needs to judge a candidate: what is already
   * playing/queued (hard exclusions) and the local taste snapshot (positive and
   * negative signals). Pure data assembly — all decisions live in lib/radio.
   */
  private radioContext(seed: RadioSeed, snapshot: TasteSnapshot): RadioContext {
    const state = playerState()
    const lib = useLibraryStore.getState()
    const blockedIds = new Set<string>()
    const blockedKeys = new Set<string>()
    if (state.current) {
      blockedIds.add(state.current.id)
      blockedKeys.add(canonicalSongKey(state.current))
    }
    for (const t of [...state.queue, ...state.autoQueue]) {
      blockedIds.add(t.id)
      blockedKeys.add(canonicalSongKey(t))
    }
    const likedArtistKeys = new Set<string>()
    for (const t of lib.liked) {
      const artist = splitArtists(t.artist)[0]
      if (artist) likedArtistKeys.add(artist)
    }
    return {
      seed,
      blockedIds,
      blockedKeys,
      dislikedIds: new Set(lib.disliked.map((t) => t.id)),
      veryRecentIds: snapshot.recentIds,
      heardIds: snapshot.heardIds,
      recentArtistKeys: snapshot.recentArtistKeys,
      likedIds: new Set(lib.liked.map((t) => t.id)),
      likedArtistKeys,
      artistPlays: snapshot.artistPlays,
      artistAffinity: snapshot.artistAffinity,
      artistSkipRates: snapshot.artistSkipRates,
      netSkips: snapshot.netSkips,
      sessionArtistCounts: this.sessionArtistCounts(),
    }
  }

  /** Artist plays within the current listening session (familiarity signal). */
  private sessionArtistCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const track of this.sessionRecent) {
      const artist = splitArtists(track.artist)[0]
      if (!artist) continue
      counts.set(artist, (counts.get(artist) ?? 0) + 1)
    }
    return counts
  }

  /**
   * Last-resort fallback queries: anchored exclusively on the seed's
   * *identified* performing artist (never the uploader/channel, never title
   * words — searching "fearless" is title-keyword matching in disguise).
   */
  /**
   * Catalog fallback queries for ARTIST and ALBUM radios only — the seed's
   * identified performing artist (and artist + album). The parameter type
   * deliberately excludes song-radio seeds (`kind: 'track'`): a Song Radio
   * must never fabricate itself from the artist's search results; if no
   * genuine recommendation source answers, its autoplay stays empty.
   */
  private catalogFallbackQueries(seed: CatalogRadioSeed): string[] {
    if (!seed.primaryArtist || !seed.rawArtist) return []
    const queries = [seed.rawArtist]
    if (seed.album) queries.push(`${seed.rawArtist} ${seed.album}`)
    return [...new Set(queries.filter((q) => q.trim().length > 1))]
  }

  /**
   * One discovery generation: build a candidate POOL from several real
   * recommendation feeds, then filter → rank → diversify → append.
   *
   * Sources (all actual provider recommendation data, in anchor priority):
   *  1. the current track's "Up next" feed — the primary anchor (weight 1);
   *  2. drift anchors: recent *session* tracks (weight W_DRIFT_SOURCE) — this
   *     is what lets a session that wandered from anime into phonk keep
   *     recommending phonk instead of snapping back to the original seed;
   *  3. taste anchors: liked tracks (weight W_TASTE_SOURCE).
   *
   * Broader generation is triggered — never just accepted — when the primary
   * pool is empty, yields too few fresh candidates, or is dominated by one
   * artist/channel identity (the "FUNK CRIMINAL → FUNK TAKA → …" failure).
   * Text search remains the explicit last resort with identity verification.
   */
  private async doDiscoveryFetch(anchorId: string): Promise<void> {
    const gen = ++this.discoveryGen
    const before = playerState()
    this.radioDebug(
      `BEFORE DISCOVERY current=${before.current?.id} autoQueue=${before.autoQueue.length} ` +
      `queueIndex=${before.index} playingFrom=${before.playingFrom} gen=${gen} lastAnchor=${this.discoveryAnchorId ?? 'none'}`,
    )
    const seed = this.currentSeed()
    if (!seed) return

    // ---- candidate generation ----
    const pools: CandidatePool[] = []
    const contributors: string[] = []
    let failed = false

    // 1) Primary anchor: the current track's real recommendation feed.
    let primary: Track[] = []
    let primarySource = ''
    let primaryShelves: { kind: string; count: number }[] | undefined
    try {
      const res = await backend().relatedTracks(playerState().current!)
      if (gen !== this.discoveryGen) return // superseded by a newer request
      primary = res?.tracks ?? []
      primarySource = res?.source ?? ''
      primaryShelves = res?.shelves
    } catch {
      failed = true
    }
    if (primary.length > 0) {
      pools.push({ weight: 1, tracks: primary })
      contributors.push(primarySource)
      this.radioDebug(
        `SOURCE ${primarySource || 'provider'} raw=${primary.length} usable=${this.freshCandidateCount(primary)} accepted`,
      )
    } else {
      this.radioDebug(`SOURCE ${primarySource || 'provider'} raw=0 usable=0 REJECTED: no usable candidates`)
    }

    // 2) Broader generation when the primary pool is thin or one-sided.
    //    Anchors come from the session (drift) and the liked list (taste);
    //    each anchor's feed is fetched at most once per session, and the
    //    budget per refill stays tiny (≤ 2 drift + 1 taste fetch).
    const yieldSoFar = this.freshCandidateCount(primary)
    const concentration = poolConcentration(primary)
    const dominated = primary.length >= 6 && concentration.share >= 0.6
    const needsBroader = primary.length === 0 || yieldSoFar < DISCOVERY_TARGET || dominated
    if (needsBroader && gen === this.discoveryGen) {
      // Anchor priority: recent session tracks (the listener's actual
      // direction) first, then *adjacent* tracks from the provider's own
      // feed — rows the recommendation graph itself surfaced for a DIFFERENT
      // identity than the dominant one (the featured artists in a
      // same-artist wall). Their feeds are genuinely broader graph
      // neighborhoods, so even a cold first-song session diversifies through
      // the graph instead of collapsing into artist search.
      const anchors: { track: Track; kind: 'drift' | 'adjacent' }[] = [
        ...this.driftAnchors().map((track) => ({ track, kind: 'drift' as const })),
        ...this.adjacentAnchors(primary, concentration.topIdentity, seed.identity).map(
          (track) => ({ track, kind: 'adjacent' as const }),
        ),
      ]
      let driftFetches = 0
      for (const { track: anchor, kind } of anchors) {
        if (driftFetches >= MAX_DRIFT_ANCHORS_PER_REFILL) break
        if (this.sessionAnchorsTried.has(anchor.id)) continue
        this.sessionAnchorsTried.add(anchor.id)
        driftFetches += 1
        try {
          const res = await backend().relatedTracks(anchor)
          if (gen !== this.discoveryGen) return
          if ((res?.tracks ?? []).length > 0) {
            pools.push({ weight: W_DRIFT_SOURCE, tracks: res!.tracks })
            contributors.push(`${primarySource || 'radio'}+${kind}`)
          }
        } catch {
          /* a failing drift anchor is never fatal */
        }
      }
      // Taste anchors only when neither drift nor adjacent feeds could
      // contribute (keeps requests low).
      if (pools.length === 1) {
        const lib = useLibraryStore.getState()
        let tasteFetches = 0
        for (const anchor of lib.liked) {
          if (tasteFetches >= MAX_TASTE_ANCHORS_PER_REFILL) break
          if (this.sessionAnchorsTried.has(anchor.id)) continue
          if (anchor.id === playerState().current?.id) continue
          this.sessionAnchorsTried.add(anchor.id)
          tasteFetches += 1
          try {
            const res = await backend().relatedTracks(anchor)
            if (gen !== this.discoveryGen) return
            if ((res?.tracks ?? []).length > 0) {
              pools.push({ weight: W_TASTE_SOURCE, tracks: res!.tracks })
              contributors.push(`${primarySource || 'taste'}+liked`)
            }
          } catch {
            /* best-effort */
          }
        }
      }
    }

    // 3) Explicit last resort for ARTIST and ALBUM radios only, never for
    //    Song Radio: text-search the seed artist's own material (album radio
    //    additionally accepts same-album rows), then hard-verify every
    //    candidate's identity. A Song Radio with no trustworthy
    //    recommendation source prefers an EMPTY radio over silently becoming
    //    Artist Radio via search("artist") — that fabrication was the
    //    confirmed root cause of the artist-only autoplay queues.
    let fallbackCandidates: Track[] | null = null
    if (pools.length === 0 && isCatalogRadio(seed)) {
      const queries = this.catalogFallbackQueries(seed)
      this.radioDebug(
        `SEED-SOURCE START anchor=${seed.id} kind=${seed.kind} artist=${JSON.stringify(seed.rawArtist)} ` +
        `queries=[${queries.map((q) => JSON.stringify(q)).join(', ')}]`,
      )
      let candidates: Track[] = []
      const byQuery: { query: string; list: Track[] }[] = []
      for (const query of queries) {
        if (candidates.length >= DISCOVERY_BATCH) break
        try {
          const res = await backend().search(query, 'songs')
          if (gen !== this.discoveryGen) return
          const batch = [...(res.songs ?? []), ...(res.videos ?? [])]
          this.radioDebug(
            `SEED-SOURCE QUERY/ENDPOINT=search(songs) q=${JSON.stringify(query)} got=${batch.length}`,
          )
          byQuery.push({ query, list: batch })
          candidates = dedupeTracks([...candidates, ...batch])
        } catch {
          failed = true
          this.radioDebug(`SEED-SOURCE QUERY/ENDPOINT=search(songs) q=${JSON.stringify(query)} FAILED`)
        }
      }
      const raw = candidates.length
      candidates = candidates.filter((t) => verifiedSeedContext(t, seed))
      this.radioDebug(
        `SEED-SOURCE END endpoint=search(songs) candidateCount=${candidates.length} ` +
        `verified=${candidates.length}/${raw} queueBefore=${playerState().autoQueue.length}`,
      )
      candidates.forEach((t, i) => {
        const q = byQuery.find((b) => b.list.some((c) => c.id === t.id))?.query ?? '?'
        this.radioDebug(
          `SEED-SOURCE CANDIDATE pos=${i + 1} id=${t.id} title=${JSON.stringify(t.title)} ` +
          `artist=${JSON.stringify(t.artist)}(${t.artistSrc ?? 'none'}) uploader=${JSON.stringify(t.uploader ?? '')} ` +
          `via=${t.via ?? 'search'} anchor=${seed.id} query=${JSON.stringify(q)}`,
        )
      })
      if (candidates.length > 0) fallbackCandidates = candidates
    } else if (pools.length === 0) {
      this.radioDebug(
        'SOURCE artist-search SKIPPED: Song Radio does not permit an artist-search fallback ' +
        '(preferring an empty radio over fabricated Artist Radio)',
      )
    }
    if (gen !== this.discoveryGen) return
    // Lifecycle provenance: one line per generation.
    this.radioDebug(
      `DISCOVERY GENERATION=${gen} ANCHOR=${playerState().current?.id} ` +
      `shelves=${JSON.stringify(primaryShelves ?? [])} pools=${pools.map((p) => p.tracks.length).join('/')}`,
    )

    // ---- rank → dedupe → diversify → append, bounded ----
    // The taste snapshot is taken at decision time (after the awaits) so the
    // play event of the track that just started is already part of it.
    const lib = useLibraryStore.getState()
    const snapshot = tasteSnapshot(lib.history, lib.stats)
    const auto = playerState().autoQueue
    const room = Math.max(0, DISCOVERY_MAX - auto.length)
    if (room === 0) return
    const diversity = DIVERSITY[seed.kind] ?? DIVERSITY.track
    // Identity counts from the live autoplay list: caps hold across refills,
    // so a one-sided feed can never grow into a wall batch after batch.
    const seeded = new Map<string, number>()
    for (const t of auto) {
      const key = identityKeyOf(t)
      if (key) seeded.set(key, (seeded.get(key) ?? 0) + 1)
    }
    const fresh = fallbackCandidates
      ? buildRadioBatch(fallbackCandidates, this.radioContext(seed, snapshot), {
          limit: Math.min(DISCOVERY_BATCH, room),
          source: 'search',
          verifiedOnly: true,
          queueTailArtists: auto.slice(-4).map(identityKeyOf),
        })
      : buildRadioBatch(pools, this.radioContext(seed, snapshot), {
          limit: Math.min(DISCOVERY_BATCH, room),
          source: 'provider',
          windowSize: diversity.windowSize,
          maxPerArtistInWindow: diversity.maxPerArtistInWindow,
          identityCap: diversity.identityCapFor(Math.min(DISCOVERY_BATCH, room)),
          seededIdentityCounts: seeded,
          queueTailArtists: auto.slice(-4).map(identityKeyOf),
        })
    if (fresh.length > 0) {
      // Contextual source label: a single feed is "based on this song";
      // several contributing sources make it a session-driven radio.
      const source = fallbackCandidates
        ? seed.kind === 'artist'
          ? 'seed-artist'
          : 'seed-song'
        : contributors.some((c) => c.endsWith('+drift'))
          ? 'session-mix' // the listening session itself redirected the radio
          : primarySource
      this.radioDebug(`SOURCE=${source || primarySource} CANDIDATE=${fresh.map((t) => t.id).join(',')}`)
      // THE insertion point: fresh candidates become the autoplay list here.
      const queueBefore = playerState().autoQueue.length
      setPlayerState({
        autoQueue: dedupeTracks([...playerState().autoQueue, ...fresh]).slice(0, DISCOVERY_MAX),
        radioSource: source || playerState().radioSource,
      })
      this.radioDebug(
        `QUEUE BEFORE=${queueBefore} AFTER=${playerState().autoQueue.length} (inserted ${fresh.length}, capped at ${DISCOVERY_MAX})`,
      )
      this.discoveryWarned = false
    } else if (failed) {
      // Non-destructive: keep what we have and warn once; the next refill retries.
      if (!this.discoveryWarned) {
        this.discoveryWarned = true
        ui.toast("Couldn't load more suggestions — will retry", 'error')
      }
    } else if (pools.length === 0 && seed.kind === 'track') {
      this.radioDebug(
        'SOURCE OUTCOME song-radio empty: no genuine recommendation source answered ' +
        '(seed-only/empty feeds); artist text search is not permitted for Song Radio',
      )
    }

    // Anchor accounting (the same-anchor invariant): a generation that ran to
    // completion is final for its anchor — even with zero candidates. Only a
    // generation whose fetches FAILED may retry, bounded. Stale generations
    // (superseded mid-flight) mark nothing. Logged AFTER insertion so the
    // queue length reflects the generation's result.
    if (gen === this.discoveryGen) {
      if (failed && fresh.length === 0) {
        this.discoveryAnchorRetries.set(anchorId, (this.discoveryAnchorRetries.get(anchorId) ?? 0) + 1)
      } else {
        this.discoveryAnchorsDone.add(anchorId)
        this.discoveryAnchorRetries.delete(anchorId)
      }
      const after = playerState()
      this.radioDebug(
        `AFTER DISCOVERY RESPONSE current=${after.current?.id} autoQueue=${after.autoQueue.length} ` +
        `gen=${gen} anchor=${anchorId} fresh=${fresh.length} outcome=${failed && fresh.length === 0 ? 'failed (retryable)' : 'complete'}`,
      )
    }
  }

  /**
   * How many genuinely new usable candidates a pool still holds (not blocked,
   * not disliked, not just played, music-shaped). Drives the broadening
   * decision as the queue is consumed.
   */
  private freshCandidateCount(pool: Track[]): number {
    const lib = useLibraryStore.getState()
    const state = playerState()
    const blocked = new Set<string>([...state.queue, ...state.autoQueue].map((t) => t.id))
    const disliked = new Set(lib.disliked.map((t) => t.id))
    let count = 0
    for (const track of pool) {
      if (!track?.id || track.id === state.current?.id) continue
      if (blocked.has(track.id) || disliked.has(track.id)) continue
      if (lib.history.slice(0, 6).some((h) => h.track.id === track.id)) continue
      if (track.duration > MAX_RADIO_DURATION || (track.duration > 0 && track.duration < MIN_RADIO_DURATION)) {
        continue
      }
      count += 1
      if (count >= DISCOVERY_TARGET) break
    }
    return count
  }

  /**
   * Drift anchors: recent session tracks, newest first, excluding the current
   * track and anchors already fetched this session. Their recommendation
   * feeds carry the session's current direction (e.g. the phonk tracks the
   * listener just chose) into the next batch.
   */
  private driftAnchors(): Track[] {
    const currentId = playerState().current?.id
    return this.sessionRecent.filter(
      (t) => t.id !== currentId && t.sourceId && !this.sessionAnchorsTried.has(t.id),
    )
  }

  /**
   * Adjacent anchors: the first few DISTINCT-identity tracks of the primary
   * feed itself (skipping the dominant identity and the seed's own). These
   * rows came out of the provider's recommendation graph for the current
   * song — following their feeds broadens the candidate pool through real
   * recommendations, never through title search or uploader names.
   */
  private adjacentAnchors(pool: Track[], dominantIdentity: string, seedIdentity: string): Track[] {
    const currentId = playerState().current?.id
    const takenIdentities = new Set<string>()
    const out: Track[] = []
    for (const track of pool) {
      if (out.length >= MAX_DRIFT_ANCHORS_PER_REFILL) break
      if (!track?.sourceId || track.id === currentId) continue
      if (this.sessionAnchorsTried.has(track.id)) continue
      const identity = identityKeyOf(track)
      if (!identity || identity === dominantIdentity || identity === seedIdentity) continue
      if (takenIdentities.has(identity)) continue
      takenIdentities.add(identity)
      out.push(track)
    }
    return out
  }


  /** Empties the discovery list without touching the autoplay setting. */
  clearAutoplay(): void {
    this.resetDiscovery()
  }

  private resetDiscovery(): void {
    this.discoveryGen += 1
    this.discoveryWarned = false
    this.discoveryPromise = null
    this.discoveryAnchorId = null
    this.discoveryAnchorsDone = new Set()
    this.discoveryAnchorRetries = new Map()
    setPlayerState({ autoQueue: [], radioSource: '' })
  }

  /** Called when the autoplay setting changes. */
  setAutoplay(enabled: boolean): void {
    if (enabled) {
      // Explicit user action: re-open the fetch budget for the current
      // anchor (bounded by the user's own toggles, never by queue level).
      this.discoveryAnchorsDone = new Set()
      this.discoveryAnchorRetries = new Map()
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
    const speed = session.speed || 1
    this.engine.setRate(speed)
    setPlayerState({
      queue,
      autoQueue: session.autoQueue ?? [],
      index,
      shuffle: !!session.shuffle,
      repeat: session.repeat ?? 'off',
      speed,
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
