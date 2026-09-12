import { create } from 'zustand'
import type { RepeatMode, Track } from '../bridge/types'

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export interface SleepTimerState {
  /** Wall-clock countdown, or a one-shot flag that waits for natural track end. */
  mode: 'duration' | 'endOfTrack'
  /** Epoch-ms expiry for duration mode; null for endOfTrack. */
  endsAt: number | null
  /** The chosen preset (minutes) — kept for UI display; null for endOfTrack. */
  minutes: number | null
}

export interface PlayerState {
  /** The explicit queue: tracks the user chose. */
  queue: Track[]
  /** Autoplay continuation, kept strictly separate from the explicit queue. */
  autoQueue: Track[]
  index: number
  current: Track | null
  status: PlayerStatus
  /**
   * Fine-grained loading stage, only meaningful while status is 'loading':
   * 'resolving' = the backend is resolving the stream URL (yt-dlp work —
   * this is the stage that can take seconds on a cache miss), 'buffering' =
   * the source is set and the audio element is fetching data. A prefetched
   * transition never shows 'resolving': no resolver work is happening, and
   * faking it would be exactly the "frozen look" this field exists to
   * prevent. Null whenever the player is not loading.
   */
  loadStage: 'resolving' | 'buffering' | null
  error: string | null
  shuffle: boolean
  repeat: RepeatMode
  volume: number
  muted: boolean
  speed: number
  /** Active sleep timer, or null. The countdown display lives on timerChannel. */
  sleepTimer: SleepTimerState | null
  /** Source of the current playback: the explicit queue or autoplay. */
  playingFrom: 'queue' | 'autoplay'
  contextLabel: string
  /** Which pipeline produced the current autoplay batch (radio transparency). */
  radioSource: string
}

export const usePlayerStore = create<PlayerState>(() => ({
  queue: [],
  autoQueue: [],
  index: -1,
  current: null,
  status: 'idle',
  loadStage: null,
  error: null,
  shuffle: false,
  repeat: 'off',
  volume: 1.0,
  muted: false,
  speed: 1,
  sleepTimer: null,
  playingFrom: 'queue',
  contextLabel: '',
  radioSource: '',
}))

export const playerState = () => usePlayerStore.getState()
export const setPlayerState = usePlayerStore.setState

export function upcomingTracks(state: PlayerState): Track[] {
  if (state.index < 0) return state.queue
  return state.queue.slice(state.index + 1)
}
