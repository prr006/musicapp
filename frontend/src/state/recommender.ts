/**
 * The recommender: keeps the Autoplay buffer alive.
 *
 *   UP NEXT        — the user's explicit queue (never touched by this module)
 *   AUTOPLAY       — a rolling buffer this module owns
 *
 * Behaviour, mirroring Spotify / YouTube Music autoplay:
 *
 *   - The buffer holds a rolling window of upcoming recommendations
 *     (REFILL_BELOW … BUFFER_MAX tracks). As tracks are consumed it is topped
 *     up incrementally — never emptied and regenerated, never bulk-generated.
 *   - Candidates come from bounded provider searches anchored on several
 *     signals at once: the current track, the listener's recent streak and
 *     their long-term artist/style affinities. Anchors rotate between
 *     fetches so the stream keeps widening instead of looping one query.
 *   - Ranking is the deterministic score in lib/recommend.ts, driven by the
 *     listening profile in lib/profile.ts.
 *   - When the user explicitly changes tracks, the existing buffer is
 *     re-ranked around the new anchor — items are preserved, never dropped.
 *
 * This module never decides *when* playback advances; that stays in the
 * playback controller. It only maintains the buffer.
 */
import { backend } from '../bridge/backend'
import { normalizeTitle } from '../lib/discovery'
import { buildProfile } from '../lib/profile'
import { anchorQueries, reRankBuffer, selectRecommendations, type RecommendationContext } from '../lib/recommend'
import { dedupeTracks } from '../lib/queue'
import type { Track } from '../bridge/types'
import { playerState, setPlayerState } from './playerStore'
import { useLibraryStore } from './libraryStore'
import { ui } from './uiStore'

/** Rolling buffer sizes: top up below 18, never hold more than 30. */
export const BUFFER_MAX = 30
export const REFILL_BELOW = 18
/** One fetch appends at most this many tracks (incremental by design). */
export const BATCH_MAX = 10
/** Distinct anchor queries used per fetch. */
export const ANCHORS_PER_FETCH = 2
/** Minimum pause between fetches so fast skipping cannot hammer the provider. */
export const FETCH_COOLDOWN_MS = 6000
/** The most recent plays that are hard-excluded (older ones are penalised). */
export const HARD_RECENT_BLOCK = 12
/**
 * When this many listens in a row were skipped, the recommender stops
 * anchoring on whatever is currently playing (the listener is rejecting that
 * direction) and anchors purely on the listening profile instead.
 */
export const SKIP_STREAK_DEMOTE = 2

/**
 * Tunables exposed for tests. Production code never touches these.
 */
export const recommenderTuning = {
  fetchCooldownMs: FETCH_COOLDOWN_MS,
}

class Recommender {
  private gen = 0
  /** The in-flight fetch, if any — forced callers await it instead of giving up. */
  private inflight: Promise<void> | null = null
  private lastFetchAt = 0
  private warned = false
  /** Rotates which anchors each fetch uses, so batches keep widening. */
  private cursor = 0

  /** Builds the full scoring context from live player + library state. */
  context(): RecommendationContext {
    const state = playerState()
    const lib = useLibraryStore.getState()
    const profile = buildProfile(lib.history, lib.liked)

    const blockedIds = new Set<string>()
    const blockedTitleKeys = new Set<string>()
    const block = (track: Track | null | undefined): void => {
      if (!track) return
      blockedIds.add(track.id)
      const key = normalizeTitle(track.title)
      if (key) blockedTitleKeys.add(key)
    }
    block(state.current)
    for (const t of state.queue) block(t)
    for (const t of state.autoQueue) block(t)
    // Hard-exclude only the freshest plays; older ones get a soft penalty in
    // scoring so a finite catalogue (or a favourite artist) can still surface.
    for (const id of profile.recentTrackIds.slice(0, HARD_RECENT_BLOCK)) {
      const t = lib.history.find((h) => h.track.id === id)?.track
      block(t ?? ({ id } as unknown as Track))
    }

    return { current: state.current, profile, blockedIds, blockedTitleKeys, buffer: state.autoQueue }
  }

  /**
   * Blends one current-track anchor with one profile anchor per fetch,
   * rotating through each side so successive batches keep widening. Every
   * batch therefore combines "what is playing right now" with "what this
   * listener keeps coming back to".
   */
  private pickAnchors(anchors: { current: string[]; profile: string[] }): string[] {
    const out: string[] = []
    if (anchors.current.length > 0) out.push(anchors.current[this.cursor % anchors.current.length])
    if (anchors.profile.length > 0) {
      out.push(anchors.profile[this.cursor % anchors.profile.length])
    } else if (anchors.current.length > 1) {
      // No profile yet (a brand-new listener): use the song-radio query.
      out.push(anchors.current[(this.cursor + 1) % anchors.current.length])
    }
    return out
  }

  /**
   * How many listens in a row the listener just skipped. The leading entry
   * for the track that is currently starting (heard nothing yet) is ignored.
   */
  private recentSkipStreak(): number {
    const hist = useLibraryStore.getState().history
    let i = 0
    // Skip the in-progress entry for the track that just started.
    while (i < hist.length && !hist[i].skipped && !hist[i].completed && (hist[i].listenedSec ?? 0) === 0) {
      i += 1
    }
    let streak = 0
    for (; i < hist.length; i += 1) {
      if (hist[i].skipped) streak += 1
      else break
    }
    return streak
  }

  /**
   * Tops the buffer up. Safe to call on every track start: it returns
   * immediately unless the buffer is actually low and the cooldown has
   * elapsed. A forced call (autoplay needs a track *now*) first waits for any
   * in-flight fetch to land — an EOF that races the very first refill must
   * benefit from it rather than giving up.
   */
  async ensureBuffered(opts: { force?: boolean } = {}): Promise<void> {
    const settings = useLibraryStore.getState().settings
    if (!settings.autoplay) return
    if (!playerState().current) return
    if (this.inflight) {
      await this.inflight.catch(() => {})
    }
    const state = playerState()
    if (state.autoQueue.length >= REFILL_BELOW) return
    if (!opts.force && Date.now() - this.lastFetchAt < recommenderTuning.fetchCooldownMs) return
    if (this.inflight) return
    this.inflight = this.fetch().finally(() => {
      this.inflight = null
    })
    await this.inflight
  }

  private async fetch(): Promise<void> {
    const gen = ++this.gen
    try {
      const lib = useLibraryStore.getState()
      const anchors = anchorQueries(
        playerState().current,
        buildProfile(lib.history, lib.liked),
        lib.liked,
      )
      let queries: string[]
      if (this.recentSkipStreak() >= SKIP_STREAK_DEMOTE && anchors.profile.length > 0) {
        // The listener is skipping through this run: stop anchoring on the
        // rejected material and lean on what the profile knows they like.
        queries = [
          anchors.profile[this.cursor % anchors.profile.length],
          anchors.profile[(this.cursor + 1) % anchors.profile.length],
        ]
      } else {
        queries = this.pickAnchors(anchors)
      }
      if (queries.length === 0) return
      const candidates: Track[] = []
      let failed = false
      for (const query of queries) {
        try {
          const res = await backend().search(query, 'songs')
          if (gen !== this.gen) return // superseded by a newer fetch or reset
          candidates.push(...(res.songs ?? []))
        } catch {
          failed = true
        }
      }
      if (gen !== this.gen) return

      const state = playerState()
      if (!state.current) return
      const ctx = this.context()
      const room = BUFFER_MAX - state.autoQueue.length
      if (room <= 0) return
      let fresh = selectRecommendations(candidates, ctx, Math.min(BATCH_MAX, room))
      if (fresh.length === 0 && candidates.length > 0 && !failed) {
        // Every candidate was hard-excluded (a fully-recent result set, which
        // happens on small catalogues). Fall back to a relaxed pass that only
        // excludes the current session, so autoplay never stalls; the soft
        // penalties in scoring still keep fresh tracks far ahead.
        const sessionOnly: RecommendationContext = {
          ...ctx,
          blockedIds: new Set<string>([
            ...(state.current ? [state.current.id] : []),
            ...state.queue.map((t) => t.id),
            ...state.autoQueue.map((t) => t.id),
          ]),
          blockedTitleKeys: new Set<string>([
            ...(state.current ? [normalizeTitle(state.current.title)] : []),
            ...state.queue.map((t) => normalizeTitle(t.title)),
            ...state.autoQueue.map((t) => normalizeTitle(t.title)),
          ]),
        }
        fresh = selectRecommendations(candidates, sessionOnly, Math.min(BATCH_MAX, room))
      }
      if (fresh.length > 0) {
        setPlayerState({ autoQueue: dedupeTracks([...state.autoQueue, ...fresh]) })
        this.warned = false
      } else if (failed) {
        // Non-destructive: keep what we have and warn once; the next
        // low-buffer moment retries.
        if (!this.warned) {
          this.warned = true
          ui.toast("Couldn't load more suggestions — will retry", 'error')
        }
      }
      this.cursor += 1
    } finally {
      this.lastFetchAt = Date.now()
    }
  }

  /**
   * The anchor changed (the user picked something explicitly). Re-rank the
   * existing buffer around it — every upcoming track is preserved, only the
   * order adapts. The buffer is never thrown away and regenerated here.
   */
  reAnchor(): void {
    const state = playerState()
    if (state.autoQueue.length <= 1) return
    const ctx = this.context()
    setPlayerState({ autoQueue: reRankBuffer(state.autoQueue, ctx) })
  }

  /** Removes one track from the buffer (it was just played). */
  removeById(id: string): void {
    const { autoQueue } = playerState()
    if (autoQueue.some((t) => t.id === id)) {
      setPlayerState({ autoQueue: autoQueue.filter((t) => t.id !== id) })
    }
  }

  /** Empties the buffer without touching the autoplay setting. */
  clear(): void {
    this.gen += 1
    this.warned = false
    setPlayerState({ autoQueue: [] })
  }
}

export const recommender = new Recommender()
