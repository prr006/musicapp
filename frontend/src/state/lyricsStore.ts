import { create } from 'zustand'
import { backend } from '../bridge/backend'
import type { LyricLine, LyricsResult, Track } from '../bridge/types'

export type LyricsStatus = 'idle' | 'loading' | 'ready' | 'empty' | 'error'

export interface LyricsState {
  trackId: string | null
  status: LyricsStatus
  result: LyricsResult | null
  error: string | null
}

export const useLyricsStore = create<LyricsState>(() => ({
  trackId: null,
  status: 'idle',
  result: null,
  error: null,
}))

const set = useLyricsStore.setState

export const lyrics = {
  /**
   * Loads lyrics for a track. `isCurrent` is the caller's staleness guard —
   * a slow lyrics response for track A can never land on track B.
   */
  loadFor(track: Track, isCurrent: () => boolean): void {
    set({ trackId: track.id, status: 'loading', result: null, error: null })
    void backend()
      .getLyrics({
        trackId: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        duration: track.duration,
      })
      .then((result) => {
        if (!isCurrent()) return
        const hasContent = (result.lines?.length ?? 0) > 0 || !!result.plain || result.instrumental
        set({
          trackId: track.id,
          status: hasContent ? 'ready' : 'empty',
          result: hasContent ? result : null,
          error: null,
        })
      })
      .catch((err: unknown) => {
        if (!isCurrent()) return
        const message = err instanceof Error ? err.message : 'No lyrics found.'
        const notFound = /no lyrics found/i.test(message)
        set({
          trackId: track.id,
          status: notFound ? 'empty' : 'error',
          result: null,
          error: notFound ? null : message,
        })
      })
  },

  clear(): void {
    set({ trackId: null, status: 'idle', result: null, error: null })
  },
}

/**
 * Finds the index of the line that should be highlighted at `position`.
 * Binary search keeps this cheap enough to run on every position tick.
 */
export function activeLineIndex(lines: LyricLine[], position: number, offset = 0): number {
  if (lines.length === 0) return -1
  const target = position + offset
  if (target < lines[0].time) return -1
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].time <= target) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * Defensive view-side cleanup for timed lines. The provider parses LRC, but a
 * malformed payload can still reach the UI (NaN timestamps, negative values,
 * out-of-order lines — the active-line binary search assumes ascending order).
 * Invalid lines are dropped and the rest sorted; the renderer never crashes on
 * bad timing data, it just shows the clean subset.
 */
export function sanitizeTimedLines(lines: LyricLine[] | undefined | null): LyricLine[] {
  if (!lines || lines.length === 0) return []
  const valid = lines.filter(
    (l) => l && typeof l.time === 'number' && Number.isFinite(l.time) && l.time >= 0,
  )
  return valid.sort((a, b) => a.time - b.time)
}
