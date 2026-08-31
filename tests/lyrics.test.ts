/**
 * Lyrics synchronization tests — mirror crates/melo-core/src/lyrics.rs.
 * The invariant under test: the highlighted line is a pure function of the
 * authoritative position (the spec's 83.42s example included).
 */

import { describe, expect, it } from "vitest";

import { activeLineIndex, parseLrc, parsePlain } from "@/lib/lyrics";

const LRC = [
  "[ti:Neon River]",
  "[ar:Aster Vale]",
  "[00:00.00]Intro line",
  "[00:12.50]First verse",
  "[01:23.42]Chorus",
  "[00:45.10][02:10.00]Repeated hook",
  "[03:00]Outro",
].join("\n");

describe("LRC parsing", () => {
  it("parses timestamps in mixed formats and sorts the result", () => {
    const lyrics = parseLrc(LRC)!;
    const times = lyrics.lines.map((l) => l.timeMs);
    expect(times).toEqual([0, 12_500, 45_100, 83_420, 130_000, 180_000]);
  });

  it("splits multi-timestamp lines", () => {
    const lyrics = parseLrc(LRC)!;
    const hooks = lyrics.lines.filter((l) => l.text === "Repeated hook");
    expect(hooks).toHaveLength(2);
    expect(hooks[0]!.timeMs).toBe(45_100);
    expect(hooks[1]!.timeMs).toBe(130_000);
  });

  it("drops metadata tags", () => {
    const lyrics = parseLrc(LRC)!;
    expect(lyrics.lines.some((l) => l.text.includes("Aster"))).toBe(false);
  });

  it("applies offset tags", () => {
    expect(parseLrc("[offset:+500]\n[00:10.00]Line")!.lines[0]!.timeMs).toBe(10_500);
    expect(parseLrc("[offset:-1000]\n[00:10.00]Line")!.lines[0]!.timeMs).toBe(9_000);
  });

  it("strips enhanced-LRC word timestamps", () => {
    const lyrics = parseLrc("[00:05.00]Hello <00:05.10>wor<00:05.40>ld")!;
    expect(lyrics.lines[0]!.text).toBe("Hello world");
  });

  it("returns null when there are no timestamps", () => {
    expect(parseLrc("just text\nmore text")).toBeNull();
  });

  it("plain lyrics are unsynced and never highlighted", () => {
    const lyrics = parsePlain("one\ntwo", "test");
    expect(lyrics.synced).toBe(false);
    expect(activeLineIndex(lyrics, 10)).toBeNull();
  });
});

describe("active line follows the authoritative position", () => {
  const lyrics = parseLrc(LRC)!;

  it("highlights the spec's canonical example: position 83.42 → chorus", () => {
    const idx = activeLineIndex(lyrics, 83.42);
    expect(lyrics.lines[idx!].text).toBe("Chorus");
  });

  it("is none before the first timestamp", () => {
    const lrc = parseLrc("[00:10.00]First\n[00:20.00]Second")!;
    expect(activeLineIndex(lrc, 5)).toBeNull();
    expect(activeLineIndex(lrc, 10)).toBe(0);
    expect(activeLineIndex(lrc, 15)).toBe(0);
    expect(activeLineIndex(lrc, 25)).toBe(1);
  });

  it("stays consistent through seeks and pauses (no second clock to drift)", () => {
    expect(activeLineIndex(lyrics, 200)).toBe(5); // outro
    expect(activeLineIndex(lyrics, 50)).toBe(2); // hook (1st)
    expect(activeLineIndex(lyrics, 130.5)).toBe(4); // hook (2nd)
    expect(activeLineIndex(lyrics, 12.5)).toBe(1);
    expect(activeLineIndex(lyrics, 83.42)).toBe(activeLineIndex(lyrics, 83.42));
  });

  it("handles playback speed: engine reports media time either way", () => {
    // At 2x the position is still media time; the mapping is unchanged.
    expect(lyrics.lines[activeLineIndex(lyrics, 90)!].text).toBe("Chorus");
  });
});
