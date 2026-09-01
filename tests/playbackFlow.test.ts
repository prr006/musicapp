/**
 * Integration flow against the REAL controller + queue + stores, with only
 * the native boundary mocked (allowed: libmpv/yt-dlp edge).
 *
 * Verifies the core acceptance chain: resolve → load → play → position →
 * EOF → next track, plus duplicate-EOF, stop-vs-EOF, repeat, manual
 * navigation, the stop-first track-change contract, previous-restart,
 * remove-current and stale-resolve guards — all driven by engine events,
 * never timers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { setBridge, type IpcBridge } from "@/app/ipc";
import { createMockBridge } from "@/app/ipc/mock";
import { playbackController } from "@/player/controller";
import { playbackStore, queueStore } from "@/app/stores/playback";
import { peekSample, resetClockForTest } from "@/app/stores/clock";
import type { Track } from "@/types/domain";

let seq = 0;
function track(title: string, opts: { sourceId?: string } = {}): Track {
  const n = seq++;
  const id = `yt:f${n}`;
  return {
    id: opts.sourceId ? `yt:${opts.sourceId}` : id,
    source: "youtube",
    sourceId: opts.sourceId ?? id,
    title,
    artists: [{ id: `a${n}`, name: `Artist ${n}` }],
    album: null,
    durationSecs: 180,
    artwork: `https://i.ytimg.com/vi/${n}/hqdefault.jpg`,
    isLocal: false,
    metadata: {},
  };
}

/**
 * Deterministic native-boundary double: engine events are emitted manually
 * by the test (no timers), commands are recorded, the epoch counter mirrors
 * the engine (one per player_load), and per-track resolve latency can be
 * scripted for race tests.
 */
type AnyHandler = (payload: unknown) => void;
function scriptedBridge(): IpcBridge & {
  emitState(s: {
    status: string;
    positionSecs?: number;
    epoch?: number;
    durationSecs?: number | null;
  }): void;
  emitEnd(reason: "eof" | "stop" | "quit" | "error" | "redirect", epoch?: number): void;
  loads: { url: string; startAt: number | null; startPaused: boolean }[];
  stops: number[];
  seeks: number[];
  volumes: number[];
  mutes: boolean[];
  progress: { trackId: string; playedSecs: number; completion: number }[];
  setResolveDelay(sourceId: string, ms: number): void;
  setSession(session: unknown): void;
  session(): unknown;
} {
  const base = createMockBridge();
  const loads: { url: string; startAt: number | null; startPaused: boolean }[] = [];
  const stops: number[] = [];
  const seeks: number[] = [];
  const volumes: number[] = [];
  const mutes: boolean[] = [];
  const progress: { trackId: string; playedSecs: number; completion: number }[] = [];
  const delays = new Map<string, number>();
  const handlers = new Map<string, Set<AnyHandler>>();
  let epoch = 0;
  let sessionStore: unknown = null;
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
      } else if (cmd === "player_stop") {
        stops.push(epoch);
      } else if (cmd === "player_seek") {
        seeks.push(Number(a.position));
      } else if (cmd === "player_set_volume") {
        volumes.push(Number(a.volume));
      } else if (cmd === "player_set_mute") {
        mutes.push(a.muted === true);
      } else if (cmd === "record_play_progress") {
        progress.push({
          trackId: String(a.trackId),
          playedSecs: Number(a.playedSecs),
          completion: Number(a.completion),
        });
      } else if (cmd === "set_session") {
        sessionStore = a.session;
      }
      if (cmd === "resolve_track") {
        const id = String(a.sourceId ?? "");
        const delay = delays.get(id) ?? 0;
        if (delay > 0) {
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              base
                .invoke(cmd as never, ...(args as [never]))
                .then(resolve)
                .catch(reject);
            }, delay);
          });
        }
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
    stops,
    seeks,
    volumes,
    mutes,
    progress,
    emitState(s) {
      emit("player://state", {
        status: s.status,
        positionSecs: s.positionSecs ?? 0,
        durationSecs: s.durationSecs ?? 180,
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
    setResolveDelay(sourceId, ms) {
      delays.set(sourceId, ms);
    },
    setSession(session) {
      sessionStore = session;
    },
    session() {
      return sessionStore;
    },
  };
}

/** Let in-flight load promises settle so epochs/tokens are aligned. */
async function settle(ms = 15): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
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
    playbackController.setVolume(80);
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
    expect(playbackStore.get().status).not.toBe("idle");
  });

  it("switching tracks stops the old audio first and resets visible state", async () => {
    playbackController.playNow(track("A"));
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));
    // Old track is really playing, mid-song.
    bridge.emitState({ status: "playing", positionSecs: 95, epoch: 1 });

    playbackController.playNow(track("B"));
    // 1. Old audio is stopped IMMEDIATELY (before B even resolves).
    expect(bridge.stops.length).toBeGreaterThanOrEqual(1);
    // 2. UI already points at B: loading state, position reset, B's metadata.
    const snap = playbackStore.get();
    expect(snap.currentTrack?.title).toBe("B");
    expect(snap.status).toBe("loading");
    expect(snap.positionSecs).toBe(0);
    // 3. The interpolated clock is reset too (no A position under B's title).
    expect(peekSample()?.positionSecs ?? 0).toBeLessThan(1);
    // 4. B actually loads and becomes the engine's track.
    await vi.waitFor(() => expect(bridge.loads.length).toBe(2));
    expect(bridge.loads[1].url).toContain("mock://media/");
    expect(playbackStore.get().currentTrack?.title).toBe("B");
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

    playbackController.stop();
    await new Promise((r) => setTimeout(r, 20));
    // The current item stays selected (Play restarts it), queue unchanged.
    expect(playbackStore.get().currentTrack?.title).toBe("A");
    expect(queueStore.get().upcoming.map((i) => i.track.title)).toEqual(["B"]);
    expect(bridge.loads.length).toBe(1);
    expect(playbackStore.get().positionSecs).toBe(0);
  });

  it("manual next advances exactly once; repeat one replays at EOF", async () => {
    playbackController.playNow(track("A"));
    playbackController.addToQueue([track("B")]);
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));

    playbackController.next();
    await vi.waitFor(() => expect(bridge.loads.length).toBe(2));
    expect(playbackStore.get().currentTrack?.title).toBe("B");

    playbackController.setRepeat("one");
    bridge.emitState({ status: "playing", positionSecs: 179, epoch: 2 });
    bridge.emitEnd("eof");
    await vi.waitFor(() => expect(bridge.loads.length).toBe(3));
    expect(playbackStore.get().currentTrack?.title).toBe("B"); // same track again
    expect(bridge.loads[2].startAt).toBeNull(); // replays from the top
  });

  it("repeat all wraps A → B → C → A", async () => {
    playbackController.playNow(track("A"));
    playbackController.addToQueue([track("B"), track("C")]);
    playbackController.setRepeat("all");
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));
    await settle();

    bridge.emitEnd("eof", 1); // A ends
    await vi.waitFor(() => expect(playbackStore.get().currentTrack?.title).toBe("B"));
    await settle();
    bridge.emitEnd("eof", 2); // B ends
    await vi.waitFor(() => expect(playbackStore.get().currentTrack?.title).toBe("C"));
    await settle();
    bridge.emitEnd("eof", 3); // C ends → wrap to A
    await vi.waitFor(() => expect(bridge.loads.length).toBe(4));
    expect(playbackStore.get().currentTrack?.title).toBe("A");
  });

  it("previous restarts the current track past the threshold, goes back before it", async () => {
    playbackController.playNow(track("A"));
    playbackController.addToQueue([track("B")]);
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));
    await settle();
    playbackController.next();
    await vi.waitFor(() => expect(bridge.loads.length).toBe(2));
    await settle();

    // 40 s into B: Previous restarts B in place (a seek, not a reload).
    bridge.emitState({ status: "playing", positionSecs: 40, epoch: 2 });
    playbackController.previous();
    expect(bridge.seeks).toContain(0);
    expect(bridge.loads.length).toBe(2); // no re-resolve, no reload
    expect(playbackStore.get().currentTrack?.title).toBe("B");

    // 1 s into B: Previous walks back to A (a real load, from zero).
    bridge.emitState({ status: "playing", positionSecs: 1, epoch: 2 });
    playbackController.previous();
    await vi.waitFor(() => expect(bridge.loads.length).toBe(3));
    expect(playbackStore.get().currentTrack?.title).toBe("A");
    expect(bridge.loads[2].startAt).toBeNull();
  });

  it("removing the CURRENT queue item loads the follow-up (no stale audio)", async () => {
    playbackController.playNow(track("A"));
    playbackController.addToQueue([track("B"), track("C")]);
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));

    const currentId = queueStore.get().current?.id;
    expect(currentId).toBeTruthy();
    playbackController.removeFromQueue(currentId!);
    await vi.waitFor(() => expect(bridge.loads.length).toBe(2));
    expect(playbackStore.get().currentTrack?.title).toBe("B");
    // The removed track is stopped on the engine.
    expect(bridge.stops.length).toBeGreaterThanOrEqual(1);
  });

  it("removing the LAST current item stops cleanly (queue dry)", async () => {
    playbackController.playNow(track("Only"));
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));
    const currentId = queueStore.get().current?.id;
    playbackController.removeFromQueue(currentId!);
    await new Promise((r) => setTimeout(r, 20));
    expect(bridge.loads.length).toBe(1);
    expect(bridge.stops.length).toBeGreaterThanOrEqual(1);
    expect(playbackStore.get().currentTrack).toBeNull();
    expect(playbackStore.get().status).toBe("idle");
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

  it("a slow resolve that finishes after a newer play is discarded", async () => {
    const a = track("A", { sourceId: "slow-a" });
    const b = track("B", { sourceId: "fast-b" });
    bridge.setResolveDelay("slow-a", 120);
    playbackController.playNow(a);
    await new Promise((r) => setTimeout(r, 10)); // A's resolve in flight
    playbackController.playNow(b);
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));
    expect(bridge.loads[0].url).toContain("fast-b");
    expect(playbackStore.get().currentTrack?.title).toBe("B");
    // Let A's late resolve land — it must NOT load over B.
    await new Promise((r) => setTimeout(r, 200));
    expect(bridge.loads.length).toBe(1);
    expect(playbackStore.get().currentTrack?.title).toBe("B");
  });

  it("rapid Next lands on D with no stale audio or wasted loads", async () => {
    playbackController.playNow(track("A"));
    playbackController.addToQueue([track("B"), track("C"), track("D")]);
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));
    playbackController.next();
    playbackController.next();
    playbackController.next();
    await vi.waitFor(() => expect(playbackStore.get().currentTrack?.title).toBe("D"));
    await new Promise((r) => setTimeout(r, 80));
    // A is stopped immediately; the superseded B/C loads are skipped, D
    // loads exactly once — the engine never plays a replaced track.
    expect(bridge.stops.length).toBeGreaterThanOrEqual(1);
    expect(playbackStore.get().currentTrack?.title).toBe("D");
    expect(bridge.loads.filter((l) => l.url.includes("mock://media/")).length).toBe(2);
  });

  it("volume/mute reach the engine, unmute on drag, and persist to the session", async () => {
    playbackController.playNow(track("A"));
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));
    await playbackController.setVolume(37);
    expect(bridge.volumes.at(-1)).toBe(37);
    expect(playbackStore.get().volume).toBe(37);

    await playbackController.toggleMute();
    expect(bridge.mutes.at(-1)).toBe(true);
    expect(playbackStore.get().muted).toBe(true);

    // Dragging the slider above zero while muted also unmutes.
    await playbackController.setVolume(50);
    expect(bridge.volumes.at(-1)).toBe(50);
    expect(bridge.mutes.at(-1)).toBe(false);
    expect(playbackStore.get().muted).toBe(false);

    playbackController.flushSession();
    await vi.waitFor(() => {
      const session = bridge.session() as { volume?: number; muted?: boolean } | null;
      expect(session?.volume).toBe(50);
    });
  });

  it("playing records history, and reached position is reported on switch", async () => {
    const a = track("A");
    playbackController.playNow(a);
    await vi.waitFor(() => expect(bridge.loads.length).toBe(1));
    await settle();
    bridge.emitState({ status: "playing", positionSecs: 90, epoch: 1 });
    playbackController.playNow(track("B"));
    await vi.waitFor(() =>
      expect(
        bridge.progress.some((p) => p.trackId === a.id && p.playedSecs === 90 && p.completion === 0.5),
      ).toBe(true),
    );
  });

  it("session restore is gated on the setting and never autoplays", async () => {
    const a = track("A");
    const b = track("B");
    const dispose = playbackController.wire();
    playbackController.clearQueue();
    // Save a session: queue A,B with B current at 42 s, volume 55.
    playbackController.addToQueue([a, b]);
    playbackController.jumpTo(queueStore.get().upcoming[1]!.id);
    await settle();
    await playbackController.setVolume(55);
    bridge.emitState({ status: "playing", positionSecs: 42, epoch: 1 });
    playbackController.flushSession();
    await vi.waitFor(() => expect(bridge.session()).toBeTruthy());
    dispose();

    // resumeLastSession = false → nothing restored.
    await playbackController.restoreForTest({ resumeLastSession: false });
    expect(queueStore.get().current).toBeNull();
    expect(bridge.loads.length).toBe(1); // never autoplayed
    // Volume prefs still applied.
    expect(bridge.volumes.at(-1)).toBe(55);

    // resumeLastSession = true → queue restored, B selected at 42 s, paused.
    await playbackController.restoreForTest({ resumeLastSession: true });
    await vi.waitFor(() => expect(queueStore.get().current?.track.title).toBe("B"));
    expect(playbackStore.get().status).toBe("paused");
    expect(playbackStore.get().positionSecs).toBe(42);
    // Nothing loaded into the engine (no autoplay on startup).
    expect(bridge.loads.length).toBe(1);
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
