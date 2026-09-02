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
import {
  buildRadioBatch, canonicalSongKey, radioSeedFromTrack, splitArtists,
  type RadioContext, type RadioKind, type RadioSeed,
} from '../lib/radio'
import { tasteSnapshot, type TasteSnapshot } from '../lib/taste'
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

/** Discovery (autoplay) keeps at least this many upcoming tracks ready. */
const DISCOVERY_TARGET = 8
/** Hard bound on the autoplay list: radio stays lightweight and fresh. */
const DISCOVERY_MAX = 20
/** Upper bound for how many candidates one discovery fetch may add. */
const DISCOVERY_BATCH = 20
/** A listen counts as "significant" after this many seconds (or half the song). */
const SIGNIFICANT_LISTEN_SECONDS = 30

/** Seconds after which a listen counts as significant: 30s or half the song. */
function significantAt(track: Track): number {
  if (track.duration > 0) return Math.min(SIGNIFICANT_LISTEN_SECONDS, track.duration / 2)
  return SIGNIFICANT_LISTEN_SECONDS
}

export class PlaybackController {
  readonly engine: PlaybackEngine
  private sessionTimer: ReturnType<typeof setTimeout> | null = null
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
  /** An explicit artist/album seed from Start Radio; holds until playback moves on. */
  private explicitSeed: RadioSeed | null = null

  constructor(engine = new PlaybackEngine()) {
    this.engine = engine
    this.engine.subscribe((event) => this.onEngineEvent(event))
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
          this.markPlayed()
          // Refill discovery once per track (generation), not on every state
          // emission — otherwise duration/buffered updates would keep
          // re-searching the same anchor query.
          if (this.discoveryRefillGen !== this.engine.currentGeneration) {
            this.discoveryRefillGen = this.engine.currentGeneration
            void this.refillDiscovery()
          }
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
    void library.recordPlayEvent(current, 'play_started').catch(() => {
      /* history is best-effort; the error surfaces through the store */
    })
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
    this.resetDiscovery()
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

  /** Starts a specific track: clears old state first, then resolves. */
  private async start(track: Track, startAt = 0): Promise<void> {
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
    this.significantForToken.clear()
    this.concludedForToken.clear()
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
   * Keeps several upcoming discovery tracks ahead of the listener. It is the
   * background continuation that makes playback endless: when the discovery
   * count drops below DISCOVERY_TARGET it fetches more, anchored on the track
   * that is currently playing — never on a search-results list — so the radio
   * drifts naturally as playback moves on.
   *
   * Concurrency and staleness are guarded: only one fetch runs at a time
   * (discoveryPromise) and every response is validated against discoveryGen, so
   * a slow response — or one superseded by an intentional track change — can
   * never pollute the new track's discovery queue.
   */
  private refillDiscovery(): Promise<void> {
    if (!useLibraryStore.getState().settings.autoplay) return Promise.resolve()
    const state = playerState()
    if (!state.current) return Promise.resolve()
    if (state.autoQueue.length >= DISCOVERY_TARGET) return Promise.resolve()
    if (this.discoveryPromise) return this.discoveryPromise
    let promise: Promise<void>
    promise = this.doDiscoveryFetch().finally(() => {
      if (this.discoveryPromise === promise) this.discoveryPromise = null
    })
    this.discoveryPromise = promise
    return promise
  }

  /**
   * The seed the current radio is built around: an explicit artist/album seed
   * while its own track is still playing, otherwise the current track itself.
   */
  private currentSeed(): RadioSeed | null {
    const current = playerState().current
    if (!current) return null
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
      netSkips: snapshot.netSkips,
    }
  }

  /**
   * Deterministic fallback queries built only from the seed's own metadata.
   * These run exclusively when the provider's dedicated related feed is
   * unavailable or empty — they are artist/album context queries, never a
   * generic "radio" search.
   */
  private radioFallbackQueries(seed: RadioSeed): string[] {
    const queries: string[] = []
    if (seed.rawArtist) queries.push(seed.rawArtist)
    if (seed.album && seed.rawArtist) queries.push(`${seed.rawArtist} ${seed.album}`)
    if (seed.kind === 'track' && seed.rawArtist && seed.title) queries.push(`${seed.rawArtist} ${seed.title}`)
    return [...new Set(queries.filter((q) => q.trim().length > 1))]
  }

  private async doDiscoveryFetch(): Promise<void> {
    const gen = ++this.discoveryGen
    const seed = this.currentSeed()
    if (!seed) return

    // ---- candidate sources, in priority order ----
    //
    // 1) The provider's dedicated related feed: the same "Up next" watch
    //    continuation YouTube Music itself plays (Go: InnerTube /next, with a
    //    yt-dlp mix fallback). This is the real radio endpoint — plain search
    //    results are never used while it answers.
    let candidates: Track[] = []
    let source = ''
    let failed = false
    try {
      const res = await backend().relatedTracks(playerState().current!)
      if (gen !== this.discoveryGen) return // superseded by a newer request
      candidates = res?.tracks ?? []
      source = res?.source ?? ''
    } catch {
      failed = true
    }

    // 2) Deterministic metadata fallback (only when the related feed is
    //    unavailable or empty): queries constructed from the seed's own
    //    artist/album/title metadata — artist results and album context, not
    //    a generic "radio" search.
    if (candidates.length === 0) {
      for (const query of this.radioFallbackQueries(seed)) {
        if (candidates.length >= DISCOVERY_BATCH) break
        try {
          const res = await backend().search(query, 'songs')
          if (gen !== this.discoveryGen) return
          candidates = dedupeTracks([...candidates, ...(res.songs ?? []), ...(res.videos ?? [])])
          source = 'seed-metadata'
        } catch {
          failed = true
        }
      }
    }
    if (gen !== this.discoveryGen) return

    // ---- rank → dedupe → diversify → append, bounded ----
    // The taste snapshot is taken at decision time (after the awaits) so the
    // play event of the track that just started is already part of it.
    const lib = useLibraryStore.getState()
    const snapshot = tasteSnapshot(lib.history, lib.stats)
    const auto = playerState().autoQueue
    const room = Math.max(0, DISCOVERY_MAX - auto.length)
    if (room === 0) return
    const fresh = buildRadioBatch(candidates, this.radioContext(seed, snapshot), {
      limit: Math.min(DISCOVERY_BATCH, room),
      queueTailArtists: auto.slice(-4).map((t) => splitArtists(t.artist)[0] ?? ''),
    })
    if (fresh.length > 0) {
      setPlayerState({
        autoQueue: dedupeTracks([...playerState().autoQueue, ...fresh]).slice(0, DISCOVERY_MAX),
        radioSource: source || playerState().radioSource,
      })
      this.discoveryWarned = false
    } else if (failed) {
      // Non-destructive: keep what we have and warn once; the next refill retries.
      if (!this.discoveryWarned) {
        this.discoveryWarned = true
        ui.toast("Couldn't load more suggestions — will retry", 'error')
      }
    }
  }

  /** Empties the discovery list without touching the autoplay setting. */
  clearAutoplay(): void {
    this.resetDiscovery()
  }

  private resetDiscovery(): void {
    this.discoveryGen += 1
    this.discoveryWarned = false
    this.discoveryPromise = null
    setPlayerState({ autoQueue: [], radioSource: '' })
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
