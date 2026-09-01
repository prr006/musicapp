/**
 * Playback/queue stores.
 *
 * Populated ONLY by the playback controller from ENGINE events — libmpv is
 * the single source of truth for playback (status/position/duration); the
 * queue store mirrors the app-level queue machine. React never writes here;
 * it calls the controller/api and events flow back.
 *
 * Position is deliberately NOT in these stores: the ONE position
 * representation is the interpolated clock in stores/clock.ts (anchored on
 * engine samples); progress-dependent components subscribe to `useClock`.
 */

import { createStore } from "@/app/store";
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

