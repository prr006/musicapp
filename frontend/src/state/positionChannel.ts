/**
 * Position is published on its own channel so that a 10 Hz clock cannot
 * re-render the whole application. Only the progress bar, the time readouts
 * and the lyrics view subscribe to it.
 */
import { useSyncExternalStore } from 'react'

type Listener = () => void

let position = 0
let duration = 0
let buffered = 0
const listeners = new Set<Listener>()

function notify(): void {
  for (const l of [...listeners]) l()
}

export const positionChannel = {
  setPosition(next: number): void {
    if (Math.abs(next - position) < 0.01) return
    position = next
    notify()
  },
  setDuration(next: number): void {
    if (Math.abs(next - duration) < 0.01) return
    duration = next
    notify()
  },
  setBuffered(next: number): void {
    if (Math.abs(next - buffered) < 0.5) return
    buffered = next
    notify()
  },
  reset(): void {
    position = 0
    duration = 0
    buffered = 0
    notify()
  },
  getPosition: () => position,
  getDuration: () => duration,
  getBuffered: () => buffered,
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}

export function usePosition(): number {
  return useSyncExternalStore(positionChannel.subscribe, positionChannel.getPosition, positionChannel.getPosition)
}

export function useDuration(): number {
  return useSyncExternalStore(positionChannel.subscribe, positionChannel.getDuration, positionChannel.getDuration)
}

export function useBuffered(): number {
  return useSyncExternalStore(positionChannel.subscribe, positionChannel.getBuffered, positionChannel.getBuffered)
}
