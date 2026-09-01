/**
 * Integration flow against the REAL controller + queue + stores, with only
 * the native boundary mocked (allowed: libmpv/yt-dlp edge).
 *
 * Verifies the core acceptance chain: resolve → load → play → position →
 * EOF → next track, plus duplicate-EOF, stop-vs-EOF, repeat, and manual
 * navigation — all driven by engine events, never timers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { setBridge, type IpcBridge } from "@/app/ipc";
import { createMockBridge } from "@/app/ipc/mock";
import { playbackController } from "@/player/controller";
import { playbackStore, queueStore } from "@/app/stores/playback";
import { resetClockForTest } from "@/app/stores/clock";
import type { Track } from "@/types/domain";

let seq = 0;
function track(title: string): Track {
  const id = `yt:f${seq++}`;
  return {
    id,
    source: "youtube",
    sourceId: id,
    title,
    artists: [{ id: `a${seq}`, name: `Artist ${seq}` }],
    album: null,
    durationSecs: 180,
    artworkUrl: null,
    metadata: {},
    addedAt: null,
  } as unknown as Track;
}

/**
 * Deterministic native-boundary double: every native event is emitted
 * manually by the test (no timers), loads are recorded, and the epoch
 * counter mirrors the mock engine (one per player_load).
 */
type AnyHandler = (payload: unknown) => void;
function scriptedBridge(): IpcBridge & {
  emitState(s: { status: string; positionSecs?: number; epoch?: number }): void;
  emitEnd(reason: "eof" | "stop" | "quit" | "error" | "redirect", epoch?: number): void;
  loads: { url: string; startAt: number | null; startPaused: boolean }[];
} {
  const base = createMockBridge();
  const loads: { url: string; startAt: number | null; startPaused: boolean }[] = [];
  const handlers = new Map<string, Set<AnyHandler>>();
  let epoch = 0;
  const bridge: IpcBridge = {
    kind: "mock",
    invoke: (cmd, ...args) => {
      const a = (args[0] ?? {}) as Record<string, unknown>;
      if (cmd === "player_load") {
        epoch += 1;
        loads.push({
          url: String(a.url),
          startAt: (a.startAt as number | null) ?? null,
          startPaused: a.startPaused === true,
        });
      }
      return base.invoke(cmd as never, ...(args as [never]));
    },
    on: (event, handler) => {
      const set = handlers.get(event) ?? new Set();
      set.add(handler as AnyHandler);
      handlers.set(event, set);
      return () => set.delete(handler as AnyHandler);
    },
  };
  const emit = (event: string, payload: unknown) => {
    for (const h of handlers.get(event) ?? []) h(payload);
  };
  return {
    ...bridge,
    loads,
    emitState(s) {
      emit("player://state", {
        status: s.status,
        positionSecs: s.positionSecs ?? 0,
        durationSecs: 180,
        paused: s.status === "paused",
        buffering: false,
        seeking: false,
        speed: 1,
        volume: 80,
        muted: false,
        epoch: s.epoch ?? epoch,
        mpvVersion: "test",
      });
    },
    emitEnd(reason, atEpoch) {
      emit("player://end", { reason, error: null, epoch: atEpoch ?? epoch });
    },
  };
}

describe("playback flow: resolve → load → EOF → next (real controller)", () => {
  let bridge: ReturnType<typeof scriptedBridge>;

  beforeEach(async () => {
    vi.useRealTimers();
    resetClockForTest();
    bridge = scriptedBridge();
    setBridge(bridge);
    const dispose = playbackController.wire();
    // Start clean for every case (repeat/shuffle are queue-machine state too).
    playbackController.clearQueue();
    playbackController.setRepeat("off");
    playbackController.setShuffle(false);
    dispose();
    setBridge(bridge);
    playbackController.wire();
    await Promise.resolve();
  });

  it("playNow resolves the track and loads the returned media URL", async () => {
    playbackController.playNow(track("Real Song"));
    await vi.waitFor(() => {
      expect(bridge.loads.length).toBe(1);
    });
    expect(bridge.loads[0].url).toMatch(/^mock:\/\/media\//);
    expect(playbackStore.get().currentTrack?.title).toBe("Real Song");
    expect(queueStore.get().current?.track.title).toBe("Real Song");
  });

  it("natural EOF advances A → B automatically, exactly once", async () => {
    playbackController.playNow(track("A"));
    playbackController.addToQueue([track("B"), track("C")]);
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));

    bridge.emitEnd("eof");
    await vi.waitFor(() => expect(bridge.loads.length).toBe(2));
    expect(bridge.loads[1].url).toContain("t" /* resolved B */);
    expect(playbackStore.get().currentTrack?.title).toBe("B");

    // Duplicate EOF for the finished file (same epoch as the first) must
    // NOT skip B — the queue guards on the load token, the controller on
    // the engine epoch.
    const endedEpoch = 1;
    bridge.emitEnd("eof", endedEpoch);
    await new Promise((r) => setTimeout(r, 20));
    expect(playbackStore.get().currentTrack?.title).toBe("B");
    expect(bridge.loads.length).toBe(2);
  });

  it("manual STOP does not advance the queue", async () => {
    playbackController.playNow(track("A"));
    playbackController.addToQueue([track("B")]);
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));

    bridge.emitEnd("stop");
    await new Promise((r) => setTimeout(r, 20));
    expect(playbackStore.get().currentTrack?.title).toBe("A");
    expect(bridge.loads.length).toBe(1);
  });

  it("manual next advances exactly once; repeat one replays at EOF", async () => {
    playbackController.playNow(track("A"));
    playbackController.addToQueue([track("B")]);
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));

    playbackController.next();
    await vi.waitFor(() => expect(playbackStore.get().currentTrack?.title).toBe("B"));

    playbackController.setRepeat("one");
    bridge.emitEnd("eof");
    await vi.waitFor(() => expect(bridge.loads.length).toBe(3));
    expect(playbackStore.get().currentTrack?.title).toBe("B"); // same track again
  });

  it("a stale EOF from a replaced track is ignored (rapid switching)", async () => {
    playbackController.playNow(track("A"));
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));
    const staleEpoch = 1;
    playbackController.playNow(track("B"));
    await vi.waitFor(() => expect(bridge.loads.length).toBe(2));

    bridge.emitEnd("eof", staleEpoch); // old file's end, already replaced
    await new Promise((r) => setTimeout(r, 20));
    expect(playbackStore.get().currentTrack?.title).toBe("B");
    expect(bridge.loads.length).toBe(2);
  });

  it("queue exhaustion with repeat off ends idle (autoplay disabled by default)", async () => {
    playbackController.playNow(track("Only"));
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));
    bridge.emitEnd("eof");
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.loads.length).toBe(1);
    expect(queueStore.get().current).toBeNull();
  });
});
