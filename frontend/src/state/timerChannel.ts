/**
 * Remaining sleep-timer time, published on its own channel for the same reason
 * position is: a per-second countdown must not re-render the player store's
 * subscribers. Only the small countdown readout subscribes here, and it only
 * notifies when the displayed second actually changes.
 */
import { useSyncExternalStore } from 'react'

type Listener = () => void

let remainingMs: number | null = null
const listeners = new Set<Listener>()

function notify(): void {
  for (const l of [...listeners]) l()
}

export const timerChannel = {
  /** Sets the remaining time; null means no active countdown. Notifies only on change. */
  setRemaining(ms: number | null): void {
    const prevSec = remainingMs === null ? null : Math.ceil(remainingMs / 1000)
    const nextSec = ms === null ? null : Math.ceil(ms / 1000)
    if (prevSec === nextSec) {
      remainingMs = ms
      return
    }
    remainingMs = ms
    notify()
  },
  getRemaining: () => remainingMs,
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export function useSleepTimerRemaining(): number | null {
  return useSyncExternalStore(timerChannel.subscribe, timerChannel.getRemaining, timerChannel.getRemaining)
}
