/**
 * REAL queue-machine behavior (the app-level queue implementation that runs
 * in production). No mocks here at all — pure domain logic:
 *
 * * natural EOF advances exactly once
 * * duplicate EOF notifications never double-advance
 * * manual stop never advances
 * * manual next advances exactly once
 * * rapid switching cannot corrupt state (fresh token per load)
 * * repeat one / repeat all / shuffle determinism
 */

import { describe, expect, it } from "vitest";

import { QueueMachine } from "@/player/queue";
import type { Track } from "@/types/domain";

let seq = 0;
function track(title: string): Track {
  const id = `yt:t${seq++}`;
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

describe("queue machine (real implementation)", () => {
  it("playNow loads a track and startSequence seeds an ordered queue", () => {
    const q = new QueueMachine(7);
    const t = track("A");
    const { item, token } = q.playNow(t);
    expect(item.track.title).toBe("A");
    expect(token).toBeGreaterThan(0);
    expect(q.currentItem()?.track.title).toBe("A");

    const seq = q.startSequence([track("B"), track("C"), track("D")], false);
    expect(seq?.item.track.title).toBe("B");
    expect(q.upcomingItems().map((i) => i.track.title)).toEqual(["C", "D"]);
  });

  it("natural EOF advances to the next track exactly once", () => {
    const q = new QueueMachine(7);
    q.startSequence([track("A"), track("B"), track("C")], false);
    const first = q.onEngineEof(q.state.token);
    expect(first.kind).toBe("load");
    if (first.kind === "load") expect(first.item.track.title).toBe("B");

    // Duplicate EOF for the same file must be a no-op.
    const dup = q.onEngineEof(q.state.token - 1); // duplicate for the ended file
    expect(dup.kind).toBe("none");
    expect(q.currentItem()?.track.title).toBe("B");

    const second = q.onEngineEof(q.state.token);
    expect(second.kind).toBe("load");
    if (second.kind === "load") expect(second.item.track.title).toBe("C");
  });

  it("manual STOP never advances the queue", () => {
    const q = new QueueMachine(7);
    q.startSequence([track("A"), track("B")], false);
    q.onEngineStop();
    // Stop must leave the queue exactly where it was — nothing advances.
    expect(q.currentItem()?.track.title).toBe("A");
    expect(q.upcomingItems().map((i) => i.track.title)).toEqual(["B"]);
  });

  it("manual next advances exactly once and reports exhaustion honestly", () => {
    const q = new QueueMachine(7);
    q.startSequence([track("A"), track("B")], false);
    const n1 = q.next();
    expect(n1?.item.track.title).toBe("B");
    const n2 = q.next();
    expect(n2).toBeNull(); // repeat off, queue done
    expect(q.exhausted).toBe(true);
  });

  it("rapid switching keeps tokens distinct — a stale EOF cannot advance", () => {
    const q = new QueueMachine(7);
    q.startSequence([track("A"), track("B"), track("C")], false);
    const loadA = q.state.token;
    const loadX = q.playNow(track("X")).token; // replaces A mid-play
    expect(loadX).not.toBe(loadA);
    expect(q.currentItem()?.track.title).toBe("X");
    // EOF for the abandoned track A is stale — ignored:
    expect(q.onEngineEof(loadA).kind).toBe("none");
    expect(q.currentItem()?.track.title).toBe("X");
    // EOF for X advances; a duplicate of X's EOF then cannot:
    expect(q.onEngineEof(loadX).kind).toBe("load");
    expect(q.onEngineEof(loadX).kind).toBe("none");
    expect(q.currentItem()?.track.title).toBe("B");
  });

  it("repeat one replays the same track at EOF", () => {
    const q = new QueueMachine(7);
    q.startSequence([track("A"), track("B")], false);
    q.setRepeat("one");
    const d = q.onEngineEof(q.state.token);
    expect(d.kind).toBe("load");
    if (d.kind === "load") {
      expect(d.item.track.title).toBe("A");
      expect(d.restart).toBe(true);
    }
  });

  it("repeat all wraps to the first track when the order is exhausted", () => {
    const q = new QueueMachine(7);
    q.startSequence([track("A"), track("B")], false);
    q.setRepeat("all");
    expect(q.onEngineEof(q.state.token).kind).toBe("load"); // A → B
    const wrap = q.onEngineEof(q.state.token); // B exhausted
    expect(wrap.kind).toBe("load");
    if (wrap.kind === "load") expect(wrap.item.track.title).toBe("A");
    expect(q.upcomingItems().map((i) => i.track.title)).toEqual(["B"]);
  });

  it("shuffle is deterministic for a seed and keeps the current track playing", () => {
    const q1 = new QueueMachine(42);
    const q2 = new QueueMachine(42);
    for (const q of [q1, q2]) q.startSequence([track("A"), track("B"), track("C"), track("D")], true);
    const order1 = q1.upcomingItems().map((i) => i.track.title);
    const order2 = q2.upcomingItems().map((i) => i.track.title);
    expect(order1).toEqual(order2);
    expect(order1).not.toContain("A"); // current stays current

    // Toggling shuffle off restores the added order.
    q1.setShuffle(false);
    expect(q1.upcomingItems().map((i) => i.track.title)).toEqual(["B", "C", "D"]);
  });

  it("add / playNext / remove / reorder / clearUpcoming behave", () => {
    const q = new QueueMachine(7);
    q.startSequence([track("A")], false);
    q.add([track("B"), track("C")]);
    expect(q.upcomingItems().map((i) => i.track.title)).toEqual(["B", "C"]);

    q.playNext([track("N")]);
    expect(q.upcomingItems().map((i) => i.track.title)).toEqual(["N", "B", "C"]);

    const bId = q.upcomingItems()[1].id;
    q.remove(bId);
    expect(q.upcomingItems().map((i) => i.track.title)).toEqual(["N", "C"]);

    q.reorder(0, 1);
    expect(q.upcomingItems().map((i) => i.track.title)).toEqual(["C", "N"]);

    q.clearUpcoming();
    expect(q.upcomingItems()).toEqual([]);
    expect(q.currentItem()?.track.title).toBe("A");
  });

  it("removing the playing item advances to the next one", () => {
    const q = new QueueMachine(7);
    q.startSequence([track("A"), track("B")], false);
    const aId = q.currentItem()?.id;
    q.remove(aId!);
    expect(q.currentItem()?.track.title).toBe("B");
  });

  it("previous walks history and restarts when history is empty", () => {
    const q = new QueueMachine(7);
    q.startSequence([track("A"), track("B")], false);
    q.next(); // → B
    const p = q.previous();
    expect(p?.item.track.title).toBe("A");
    expect(p?.seekTo).toBe(0);
    const restart = q.previous(); // no history → restart current
    expect(restart?.item.track.title).toBe("A");
    expect(restart?.seekTo).toBe(0);
  });

  it("history grows most-recent-first and queueTracks returns play order", () => {
    const q = new QueueMachine(7);
    q.startSequence([track("A"), track("B"), track("C")], false);
    q.onEngineEof(q.state.token); // A → B
    q.onEngineEof(q.state.token); // B → C
    expect(q.snapshot().history.map((h) => h.track.title)).toEqual(["B", "A"]);
    expect(q.queueTracks().map((t) => t.title)).toEqual(["C"]);
  });
});
