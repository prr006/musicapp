import { create } from 'zustand'
import type { RepeatMode, Track } from '../bridge/types'
import { projectUpcoming } from '../domain/queueEngine'

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
  /** Unix milliseconds, or null when no sleep timer is active. */
  sleepTimerEndsAt: number | null
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
  sleepTimerEndsAt: null,
}))

export const playerState = () => usePlayerStore.getState()
export const setPlayerState = usePlayerStore.setState

export function upcomingTracks(state: PlayerState): Track[] {
  return projectUpcoming(state).explicit
}
