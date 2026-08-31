/**
 * Authoritative-clock hook (spec §7): backend `playback://position` samples
 * are the truth; this hook *derives* a smooth position between samples
 * (`position + elapsed × speed`) at display cadence via one shared rAF loop.
 * When samples go stale (>1.5 s — stalled engine) the clock FREEZES rather
 * than drift; the next authoritative sample resets the origin. There is no
 * independent timer anywhere in the renderer that advances playback.
 */

import { useEffect, useRef, useState } from "react";
import { quantize, sampleClock, type ClockSample } from "@/lib/clock";

let latest: ClockSample | null = null;
const listeners = new Set<() => void>();
let rafHandle: number | null = null;

function tick(): void {
  rafHandle = null;
  for (const l of [...listeners]) l();
  if (listeners.size > 0) {
    rafHandle = requestAnimationFrame(tick);
  }
}

function ensureLoop(): void {
  if (rafHandle == null && listeners.size > 0) {
    rafHandle = requestAnimationFrame(tick);
  }
}

/**
 * Sink for backend position events — wired once by useAppBridge. `playing`
 * comes from the latest playback state snapshot (status events and position
 * events both originate in the same engine loop, so they cannot disagree
 * for more than one tick).
 */
export function onPositionEvent(
  sample: Omit<ClockSample, "receivedAtMs"> & { receivedAtMs?: number },
): void {
  latest = { ...sample, receivedAtMs: sample.receivedAtMs ?? performance.now() };
  for (const l of [...listeners]) l();
}

export function peekSample(): ClockSample | null {
  return latest;
}

/** Test-only: reset the singleton sample. */
export function resetClockForTest(): void {
  latest = null;
}

/**
 * Smooth position for the current track. `stepSecs` quantizes re-renders
 * (default 0.25 s — fine for progress bars and synced lyrics).
 */
export function useClock(stepSecs = 0.25): { position: number; duration: number | null } {
  const lastRef = useRef(-1);
  const [, force] = useState(0);

  useEffect(() => {
    const listener = () => {
      const sample = latest;
      if (!sample) return;
      const derived = quantize(sampleClock(sample, performance.now()), stepSecs);
      if (derived !== lastRef.current) {
        lastRef.current = derived;
        force((n) => n + 1);
      }
    };
    listeners.add(listener);
    ensureLoop();
    listener();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0 && rafHandle != null) {
        cancelAnimationFrame(rafHandle);
        rafHandle = null;
      }
    };
  }, [stepSecs]);

  const sample = latest;
  if (!sample) return { position: 0, duration: null };
  return {
    position: sampleClock(sample, performance.now()),
    duration: sample.durationSecs,
  };
}
