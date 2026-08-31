/**
 * Queue machine parity tests — these mirror the Rust test-suite in
 * crates/melo-core/src/queue.rs case-for-case. If a test here and its Rust
 * twin ever disagree, one of the two implementations drifted.
 */

import { describe, expect, it } from "vitest";

import { QueueMachine } from "@/app/ipc/mockQueue";
import { SAMPLE_TRACKS } from "@/app/ipc/sampleData";
import type { QueueItem, Track } from "@/types/domain";

const track = (n: number): Track => {
  const base = SAMPLE_TRACKS[n % SAMPLE_TRACKS.length]!;
  return { ...base, id: `t:${n}`, sourceId: `v${n}`, title: `Track ${n}` };
};

const titles = (items: QueueItem[]) => items.map((i) => i.track.title);

const loadId = (step: { kind: string; id?: string }) =>
  step.kind === "load" ? step.id : null;

function assertInvariants(q: QueueMachine) {
  const order = [...q.orderIds];
  expect(order.length).toBe(q.length);
  expect(new Set(order).size).toBe(order.length);
  for (const id of order) expect(q.byId(id)).not.toBeNull();
  const cur = q.current();
  if (cur) expect(order[q.cursorIndex!]).toBe(cur.id);
  for (const h of q.historyIds) expect(q.byId(h)).not.toBeNull();
}

describe("queue machine (mirrors Rust)", () => {
  it("empty queue advances to nothing", () => {
    const q = new QueueMachine(42);
    expect(q.advance(false).kind).toBe("none");
    expect(q.previous().kind).toBe("none");
  });

  it("plays first item then advances in order", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2), track(3)], "end");
    expect(q.current()).toBeNull();
    expect(loadId(q.advance(true))).toBe("qi:1");
    expect(q.current()!.track.title).toBe("Track 1");
    expect(loadId(q.advance(true))).toBe("qi:2");
    expect(loadId(q.advance(true))).toBe("qi:3");
    assertInvariants(q);
  });

  it("EOF at end with repeat off ends the queue", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2)], "end");
    q.advance(true);
    q.advance(false);
    expect(q.advance(false).kind).toBe("end-of-queue");
    expect(q.current()!.track.title).toBe("Track 2");
    assertInvariants(q);
  });

  it("repeat all wraps at the end", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2)], "end");
    q.setRepeat("all");
    q.advance(true);
    q.advance(false);
    expect(loadId(q.advance(false))).toBe("qi:1");
    assertInvariants(q);
  });

  it("repeat one replays on EOF but explicit next advances", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2)], "end");
    q.setRepeat("one");
    q.advance(true);
    expect(q.advance(false).kind).toBe("replay-current");
    expect(loadId(q.advance(true))).toBe("qi:2");
  });

  it("history and previous", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2), track(3)], "end");
    q.advance(true);
    q.advance(true);
    expect(titles(q.historyItems())).toEqual(["Track 1"]);
    expect(loadId(q.previous())).toBe("qi:1");
    expect(q.previous().kind).toBe("seek-start");
    assertInvariants(q);
  });

  it("play next inserts directly after the current item", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2)], "end");
    q.advance(true);
    q.addTracks([track(9)], "after-current");
    expect(q.upcoming()[0]!.track.title).toBe("Track 9");
    expect(loadId(q.advance(true))).toBe("qi:3");
    assertInvariants(q);
  });

  it("add to queue appends after upcoming", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2)], "end");
    q.advance(true);
    q.addTracks([track(5), track(6)], "end");
    expect(titles(q.upcoming())).toEqual(["Track 2", "Track 5", "Track 6"]);
  });

  it("play now jumps and pushes the outgoing track to history", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2), track(3)], "end");
    q.advance(true);
    q.playNow(track(9));
    expect(q.current()!.track.title).toBe("Track 9");
    expect(titles(q.historyItems())).toEqual(["Track 1"]);
    expect(q.upcoming()[0]!.track.title).toBe("Track 2");
    assertInvariants(q);
  });

  it("removing an upcoming item keeps the current one", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2), track(3)], "end");
    q.advance(true);
    expect(q.remove("qi:2").kind).toBe("none");
    expect(q.current()!.track.title).toBe("Track 1");
    expect(titles(q.upcoming())).toEqual(["Track 3"]);
    assertInvariants(q);
  });

  it("removing the current item loads the next in play order", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2), track(3)], "end");
    q.advance(true);
    expect(loadId(q.remove("qi:1"))).toBe("qi:2");
    expect(q.current()!.track.title).toBe("Track 2");
    expect(q.historyItems()).toEqual([]);
    assertInvariants(q);
  });

  it("removing the last item with repeat off ends the queue", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2)], "end");
    q.advance(true);
    q.advance(true);
    expect(q.remove("qi:2").kind).toBe("end-of-queue");
    expect(q.current()).toBeNull();
    assertInvariants(q);
  });

  it("removing the last item with repeat all wraps", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2)], "end");
    q.setRepeat("all");
    q.advance(true);
    q.advance(true);
    expect(loadId(q.remove("qi:2"))).toBe("qi:1");
    assertInvariants(q);
  });

  it("clear upcoming keeps current + history and EOF then stops", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2), track(3), track(4)], "end");
    q.advance(true);
    q.advance(true);
    q.clearUpcoming();
    expect(q.current()!.track.title).toBe("Track 2");
    expect(q.upcoming()).toEqual([]);
    expect(titles(q.historyItems())).toEqual(["Track 1"]);
    expect(q.advance(false).kind).toBe("end-of-queue");
    assertInvariants(q);
  });

  it("clear all resets everything", () => {
    const q = new QueueMachine(1);
    q.addTracks([track(1), track(2), track(3)], "end");
    q.advance(true);
    expect(q.clearAll().kind).toBe("end-of-queue");
    expect(q.isEmpty).toBe(true);
    expect(q.current()).toBeNull();
  });

  it("shuffle keeps the current item in place and stays a permutation", () => {
    const q = new QueueMachine(77);
    q.addTracks([1, 2, 3, 4, 5, 6, 7, 8].map(track), "end");
    q.advance(true);
    q.advance(true);
    q.setShuffle(true);
    assertInvariants(q);
    expect(q.current()!.track.title).toBe("Track 2");
    const upcoming = titles(q.upcoming()).sort();
    expect(upcoming).toEqual(
      ["Track 1", "Track 3", "Track 4", "Track 5", "Track 6", "Track 7", "Track 8"].sort(),
    );
    // Full walk visits every track exactly once.
    const visited = new Set(["Track 2"]);
    for (;;) {
      const step = q.advance(false);
      if (step.kind === "end-of-queue") break;
      if (step.kind === "load") visited.add(q.current()!.track.title);
      else throw new Error(`unexpected ${step.kind}`);
    }
    expect(visited.size).toBe(8);
  });

  it("shuffle is deterministic for a fixed seed", () => {
    const a = new QueueMachine(1234);
    const b = new QueueMachine(1234);
    const tracks = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(track);
    a.startSequence(tracks, true);
    b.startSequence([...tracks], true);
    expect([...a.orderIds]).toEqual([...b.orderIds]);
  });

  it("unshuffle restores canonical order and keeps the current item", () => {
    const q = new QueueMachine(5);
    q.addTracks([1, 2, 3, 4, 5, 6].map(track), "end");
    q.setShuffle(true);
    q.advance(true);
    const before = q.current()!.id;
    q.setShuffle(false);
    assertInvariants(q);
    expect(q.current()!.id).toBe(before);
    expect([...q.orderIds]).toEqual(["qi:1", "qi:2", "qi:3", "qi:4", "qi:5", "qi:6"]);
  });

  it("adding while shuffled lands in the upcoming span and plays once", () => {
    const q = new QueueMachine(9);
    q.addTracks([1, 2, 3, 4].map(track), "end");
    q.advance(true);
    q.setShuffle(true);
    q.addTracks([track(99)], "end");
    assertInvariants(q);
    expect(q.upcoming().some((i) => i.track.title === "Track 99")).toBe(true);
    let seen = 0;
    for (;;) {
      const step = q.advance(false);
      if (step.kind === "end-of-queue") break;
      if (step.kind === "load" && q.current()!.track.title === "Track 99") seen++;
    }
    expect(seen).toBe(1);
  });

  it("move up/down/reorder operate on upcoming only", () => {
    const q = new QueueMachine(1);
    q.addTracks([1, 2, 3, 4].map(track), "end");
    q.advance(true);
    q.moveUp("qi:1"); // current: no-op
    expect(q.current()!.track.title).toBe("Track 1");
    q.moveDown("qi:2");
    expect(titles(q.upcoming())).toEqual(["Track 3", "Track 2", "Track 4"]);
    q.moveUp("qi:2");
    expect(titles(q.upcoming())).toEqual(["Track 2", "Track 3", "Track 4"]);
    q.reorderUpcoming(0, 2);
    expect(titles(q.upcoming())).toEqual(["Track 3", "Track 4", "Track 2"]);
    assertInvariants(q);
  });

  it("start sequence replaces the queue and starts at the first item", () => {
    const q = new QueueMachine(1);
    q.addTracks([1, 2, 3].map(track), "end");
    q.advance(true);
    const step = q.startSequence([track(7), track(8)], false);
    expect(loadId(step)).toBe("qi:4");
    expect(q.current()!.track.title).toBe("Track 7");
    expect(q.historyItems()).toEqual([]);
    expect(q.upcoming().length).toBe(1);
    assertInvariants(q);
  });

  it("serializes and restores exactly", () => {
    const q = new QueueMachine(1);
    q.addTracks([1, 2, 3, 4].map(track), "end");
    q.advance(true);
    q.advance(true);
    q.setShuffle(true);
    const restored = QueueMachine.deserialize(q.serialize());
    expect([...restored.orderIds]).toEqual([...q.orderIds]);
    expect(restored.cursorIndex).toBe(q.cursorIndex);
    expect([...restored.historyIds]).toEqual([...q.historyIds]);
    expect(restored.shuffleEnabled).toBe(true);
    assertInvariants(restored);
  });
});
