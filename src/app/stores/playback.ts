/**
 * Playback/queue stores — populated ONLY from backend events (spec §2).
 * React never writes playback state here; it sends commands and the backend
 * answers with events.
 *
 * `positionStore` is deliberately separate: it updates at ~4–5 Hz and only
 * progress-dependent components subscribe to it (spec §34).
 */

import { createStore, useStore } from "@/app/store";
import type { PlaybackSnapshot, PositionUpdate, QueueView } from "@/types/domain";

const IDLE_SNAPSHOT: PlaybackSnapshot = {
  status: "idle",
  currentItemId: null,
  currentTrack: null,
  positionSecs: 0,
  durationSecs: null,
  volume: 80,
  muted: false,
  speed: 1,
  shuffle: false,
  repeat: "off",
  bufferingPct: null,
  error: null,
  queueRev: 0,
};

export const playbackStore = createStore<PlaybackSnapshot>(IDLE_SNAPSHOT);

export const queueStore = createStore<QueueView>({
  current: null,
  upcoming: [],
  history: [],
  shuffle: false,
  repeat: "off",
  rev: 0,
});

export const positionStore = createStore<{ positionSecs: number; durationSecs: number | null }>({
  positionSecs: 0,
  durationSecs: null,
});

export function onPlaybackState(snapshot: PlaybackSnapshot): void {
  playbackStore.set(snapshot);
  // State events always carry a current-enough position (seeks/pauses force
  // one); the throttled position stream keeps it fresh between them.
  positionStore.set({
    positionSecs: snapshot.positionSecs,
    durationSecs: snapshot.durationSecs,
  });
}

export function onQueueView(view: QueueView): void {
  queueStore.set(view);
}

export function onPosition(update: PositionUpdate): void {
  positionStore.set({
    positionSecs: update.positionSecs,
    durationSecs: update.durationSecs,
  });
}

// ---- ergonomic selectors -------------------------------------------------

export function usePlayback(): PlaybackSnapshot {
  return useStore(playbackStore, (s) => s);
}

export function useIsPlaying(): boolean {
  return useStore(playbackStore, (s) => s.status === "playing" || s.status === "buffering");
}

export function useCurrentTrack() {
  return useStore(playbackStore, (s) => s.currentTrack);
}

export function usePosition(): { positionSecs: number; durationSecs: number | null } {
  return useStore(positionStore, (s) => s);
}
