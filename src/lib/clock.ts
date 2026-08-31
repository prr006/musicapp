/**
 * The playback clock (spec §7).
 *
 * There is ONE authoritative clock: Rust/mpv positions delivered via
 * `playback://position` and `playback://state`. This module adds the only
 * thing the UI is allowed to do on top: *derive* a smooth position from the
 * LATEST authoritative sample — `position + elapsed × speed` — and hard-freeze
 * when samples go stale (>1.5 s without an update, e.g. a stalled engine).
 * There is no independent timer that "keeps counting" through errors:
 * every seek/pause/resume/track-change/buffer/restart produces a new
 * authoritative sample that resets the extrapolation origin.
 */

/** A single authoritative position sample from the backend. */
export interface ClockSample {
  positionSecs: number;
  durationSecs: number | null;
  speed: number;
  playing: boolean;
  /** performance.now() when this sample arrived. */
  receivedAtMs: number;
}

/** Samples older than this are treated as stalled → freeze the clock. */
export const STALE_AFTER_MS = 1500;

/**
 * Derive the current position for `nowMs`. Pure function — trivially
 * testable, no timers.
 */
export function sampleClock(sample: ClockSample, nowMs: number): number {
  const elapsedMs = nowMs - sample.receivedAtMs;
  if (!sample.playing || elapsedMs < 0) {
    return sample.positionSecs;
  }
  if (elapsedMs > STALE_AFTER_MS) {
    // Stale: an authoritative update should have arrived; a UI that kept
    // counting here would drift from the engine. Freeze at last truth.
    return sample.positionSecs;
  }
  const derived = sample.positionSecs + (elapsedMs / 1000) * sample.speed;
  if (sample.durationSecs != null && sample.durationSecs > 0) {
    return Math.min(derived, sample.durationSecs);
  }
  return derived;
}

/** Quantize for cheap React comparisons (lyrics need ~100 ms resolution). */
export function quantize(positionSecs: number, stepSecs = 0.25): number {
  return Math.round(positionSecs / stepSecs) * stepSecs;
}
