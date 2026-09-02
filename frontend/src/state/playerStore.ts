import { create } from 'zustand'
import type { RepeatMode, Track } from '../bridge/types'

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'

export interface PlayerState {
  /** The explicit queue: tracks the user chose. */
  queue: Track[]
  /** Autoplay continuation, kept strictly separate from the explicit queue. */
  autoQueue: Track[]
  index: number
  current: Track | null
  status: PlayerStatus
  error: string | null
  shuffle: boolean
  repeat: RepeatMode
  volume: number
  muted: boolean
  speed: number
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
  error: null,
  shuffle: false,
  repeat: 'off',
  volume: 0.9,
  muted: false,
  speed: 1,
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
