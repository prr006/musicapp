/**
 * Playback/queue stores.
 *
 * Populated ONLY by the playback controller from ENGINE events — libmpv is
 * the single source of truth for playback (status/position/duration); the
 * queue store mirrors the app-level queue machine. React never writes here;
 * it calls the controller/api and events flow back.
 *
 * `positionStore` is deliberately separate: it updates at the engine's
 * position cadence and only progress-dependent components subscribe.
 */

import { createStore, useStore } from "@/app/store";
import type { PlaybackSnapshot, QueueView } from "@/types/domain";

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
