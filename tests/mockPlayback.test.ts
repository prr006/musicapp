/**
 * End-to-end playback behavior through the mock bridge (browser preview
 * engine). Verifies the behaviors that matter most (spec §35) against the
 * simulated engine: play, pause, EOF auto-next, repeat, stop-at-end, session
 * restore. The same behaviors are covered on the Rust side against
 * `PlaybackCore` directly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMockBridge } from "@/app/ipc/mock";
import type { IpcBridge, PlaybackSnapshot, QueueView } from "@/app/ipc";
import { SAMPLE_TRACKS } from "@/app/ipc/sampleData";
import type { Track } from "@/types/domain";

const track = (n: number): Track => ({
  ...SAMPLE_TRACKS[n % SAMPLE_TRACKS.length]!,
  id: `test:${n}`,
  sourceId: `v${n}`,
  durationSecs: 2, // 2-second tracks make EOF tests fast
});

describe("mock playback engine (browser preview shim)", () => {
  let bridge: IpcBridge;
  let states: PlaybackSnapshot[];
  let positions: number[];
  let queues: QueueView[];

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    bridge = createMockBridge();
    states = [];
    positions = [];
    queues = [];
    bridge.on("playback://state", (s) => states.push(structuredClone(s)));
    bridge.on("playback://position", (p) => positions.push(p.positionSecs));
    bridge.on("queue://view", (q) => queues.push(structuredClone(q)));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const snap = (): PlaybackSnapshot => states[states.length - 1]!;
  const last = <T,>(arr: T[]): T => arr[arr.length - 1]!;

  it("loads a track, transitions loading → playing, and reports positions", async () => {
    await bridge.invoke("queue_play_now", { track: track(1) });
    expect(snap().status).toBe("loading");
    await vi.advanceTimersByTimeAsync(400);
    expect(snap().status).toBe("playing");
    expect(snap().currentTrack!.id).toBe("test:1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(last(positions)).toBeGreaterThan(0.9);
  });

  it("pauses and resumes without losing position", async () => {
    await bridge.invoke("queue_play_now", { track: track(1) });
    await vi.advanceTimersByTimeAsync(1400);
    const atPause = last(positions);
    await bridge.invoke("player_pause");
    expect(snap().status).toBe("paused");
    await vi.advanceTimersByTimeAsync(1000);
    expect(last(positions)).toBeCloseTo(atPause, 1);
    await bridge.invoke("player_play");
    expect(snap().status).toBe("playing");
  });

  it("auto-advances to the next track at EOF (no frontend timers involved)", async () => {
    await bridge.invoke("queue_start", { tracks: [track(1), track(2)], shuffle: false });
    await vi.advanceTimersByTimeAsync(400); // load track 1
    expect(snap().currentTrack!.id).toBe("test:1");
    await vi.advanceTimersByTimeAsync(2000); // play through EOF (2s track)
    expect(snap().status).toBe("loading"); // track 2 loading
    await vi.advanceTimersByTimeAsync(400);
    expect(snap().status).toBe("playing");
    expect(snap().currentTrack!.id).toBe("test:2");
    // History shows track 1.
    const view = last(queues);
    expect(view.history[0]!.track.id).toBe("test:1");
  });

  it("stops (idle) at the end of the queue with repeat off", async () => {
    await bridge.invoke("queue_start", { tracks: [track(1)], shuffle: false });
    await vi.advanceTimersByTimeAsync(700); // load completes
    expect(snap().status).toBe("playing");
    await vi.advanceTimersByTimeAsync(2200); // play through EOF (2s track)
    expect(snap().status).toBe("idle");
    expect(snap().currentTrack!.id).toBe("test:1"); // stays visible
  });

  it("repeat one replays the same track at EOF", async () => {
    await bridge.invoke("queue_start", { tracks: [track(1), track(2)], shuffle: false });
    await bridge.invoke("queue_set_repeat", { mode: "one" });
    await vi.advanceTimersByTimeAsync(3600); // load + play past EOF
    await vi.advanceTimersByTimeAsync(320); // reload completes
    expect(snap().currentTrack!.id).toBe("test:1");
    expect(snap().status).toBe("playing");
  });

  it("repeat all wraps back to the first track", async () => {
    const ten = (n: number) => ({ ...track(n), durationSecs: 10 });
    await bridge.invoke("queue_start", { tracks: [ten(1), ten(2)], shuffle: false });
    await bridge.invoke("queue_set_repeat", { mode: "all" });
    await vi.advanceTimersByTimeAsync(400); // 1 playing
    await vi.advanceTimersByTimeAsync(10200); // finish 1 → EOF → load 2
    await vi.advanceTimersByTimeAsync(400); // 2 playing
    expect(snap().currentTrack!.id).toBe("test:2");
    await vi.advanceTimersByTimeAsync(10200); // finish 2 → wrap → load 1
    await vi.advanceTimersByTimeAsync(400); // 1 playing
    expect(snap().currentTrack!.id).toBe("test:1");
    expect(snap().status).toBe("playing");
  });

  it("seek jumps to the requested position and lyrics-critical updates flow", async () => {
    await bridge.invoke("queue_play_now", {
      track: { ...track(1), durationSecs: 200 },
    });
    await vi.advanceTimersByTimeAsync(400);
    await bridge.invoke("player_seek_to", { position: 83.42 });
    expect(snap().positionSecs).toBeCloseTo(83.42, 1);
    expect(last(positions)).toBeCloseTo(83.42, 1);
  });

  it("previous restarts a long track before walking history", async () => {
    const long = (n: number) => ({ ...track(n), durationSecs: 200 });
    await bridge.invoke("queue_start", { tracks: [long(1), long(2)], shuffle: false });
    await vi.advanceTimersByTimeAsync(700); // 1 playing
    await bridge.invoke("player_next"); // to 2
    await vi.advanceTimersByTimeAsync(700);
    await bridge.invoke("player_seek_to", { position: 12 });
    await bridge.invoke("player_previous"); // >3s in → restart
    expect(snap().positionSecs).toBe(0);
    expect(snap().currentTrack!.id).toBe("test:2");
    await bridge.invoke("player_previous"); // early in track → history
    await vi.advanceTimersByTimeAsync(700);
    expect(snap().currentTrack!.id).toBe("test:1");
  });

  it("shuffle mid-play keeps the current track playing", async () => {
    const tracks = [1, 2, 3, 4, 5].map(track);
    await bridge.invoke("queue_start", { tracks, shuffle: false });
    await vi.advanceTimersByTimeAsync(400);
    await bridge.invoke("queue_set_shuffle", { enabled: true });
    expect(snap().currentTrack!.id).toBe("test:1");
    expect(snap().status).toBe("playing");
    const view = last(queues);
    expect(view.upcoming).toHaveLength(4);
    expect(new Set(view.upcoming.map((u) => u.track.id)).size).toBe(4);
  });

  it("removing the current item advances to the next one", async () => {
    await bridge.invoke("queue_start", { tracks: [track(1), track(2), track(3)], shuffle: false });
    await vi.advanceTimersByTimeAsync(400);
    const id = snap().currentItemId!;
    await bridge.invoke("queue_remove", { itemId: id });
    await vi.advanceTimersByTimeAsync(400);
    expect(snap().currentTrack!.id).toBe("test:2");
    expect(snap().status).toBe("playing");
  });

  it("clearing the queue stops playback", async () => {
    await bridge.invoke("queue_start", { tracks: [track(1), track(2)], shuffle: false });
    await vi.advanceTimersByTimeAsync(400);
    await bridge.invoke("queue_clear_all");
    expect(snap().status).toBe("idle");
    expect(snap().currentTrack).toBeNull();
  });

  it("session restores without autoplay", async () => {
    await bridge.invoke("queue_start", { tracks: [track(1), track(2)], shuffle: false });
    await vi.advanceTimersByTimeAsync(400);
    await bridge.invoke("player_pause");
    await vi.advanceTimersByTimeAsync(600); // let persistence debounce run

    const bridge2 = createMockBridge();
    const got = await bridge2.invoke("get_playback_state");
    expect(got.status).toBe("idle");
    expect(got.currentTrack).not.toBeNull(); // queue survived
    const q = await bridge2.invoke("get_queue");
    expect(q.upcoming.length + (q.current ? 1 : 0)).toBe(2);
    // Nothing plays until the user asks.
    await vi.advanceTimersByTimeAsync(1000);
    expect((await bridge2.invoke("get_playback_state")).status).toBe("idle");
  });

  it("search finds grouped results and surfaces failures honestly", async () => {
    const ok = await bridge.invoke("search", { query: "neon" });
    expect(ok.tracks.length).toBeGreaterThan(0);
    await expect(bridge.invoke("search", { query: "error please" })).rejects.toBeTruthy();
  });
});
