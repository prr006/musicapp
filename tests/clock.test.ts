/**
 * The derived clock (spec §7): between authoritative samples the UI may
 * extrapolate; past STALE_AFTER_MS it must FREEZE. No second clock may drift.
 */

import { describe, expect, it } from "vitest";

import { quantize, sampleClock, STALE_AFTER_MS, type ClockSample } from "@/lib/clock";

function sample(over: Partial<ClockSample> = {}): ClockSample {
  return {
    positionSecs: 10,
    durationSecs: 200,
    speed: 1,
    playing: true,
    receivedAtMs: 0,
    ...over,
  };
}

describe("sampleClock derivation", () => {
  it("extrapolates between samples using the engine speed", () => {
    expect(sampleClock(sample(), 500)).toBeCloseTo(10.5, 5);
    expect(sampleClock(sample({ speed: 2 }), 500)).toBeCloseTo(11, 5);
  });

  it("does not run backwards for out-of-order timestamps", () => {
    expect(sampleClock(sample(), -100)).toBe(10);
  });

  it("freezes when paused", () => {
    expect(sampleClock(sample({ playing: false }), 10_000)).toBe(10);
  });

  it("freezes when samples go stale instead of drifting", () => {
    expect(sampleClock(sample(), STALE_AFTER_MS + 1)).toBe(10);
  });

  it("never reports past the known duration", () => {
    const s = sample({ positionSecs: 199.8, durationSecs: 200 });
    expect(sampleClock(s, 500)).toBe(200);
  });

  it("handles unknown duration (live/streams)", () => {
    const s = sample({ durationSecs: null });
    expect(sampleClock(s, 1_000)).toBeCloseTo(11, 5);
  });
});

describe("quantize", () => {
  it("steps at the requested resolution", () => {
    expect(quantize(10.13, 0.25)).toBe(10.25);
    expect(quantize(10.1, 0.25)).toBe(10);
    expect(quantize(0.9, 0.5)).toBe(1);
  });
});
