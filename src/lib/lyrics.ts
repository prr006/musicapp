/**
 * Frontend lyric timestamp matching (spec §11).
 *
 * The authoritative clock lives in Rust (`playback://position` events).
 * This module only performs the pure render-side mapping
 *   position (secs) → highlighted line index
 * plus LRC parsing for the (later) lyrics view. Because it is position-
 * derived it stays in sync across seeks, pauses, buffering, track changes,
 * auto-next, restarts, and playback-speed changes — there is no second clock
 * to drift.
 *
 * Mirrors crates/melo-core/src/lyrics.rs (kept in lockstep; covered by
 * tests/lyrics.test.ts).
 */

import type { LyricLine, Lyrics } from "@/types/domain";

export function parseLrc(input: string): Lyrics | null {
  const lines: LyricLine[] = [];
  let offsetMs = 0;

  for (const raw of input.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    let rest = line;
    const stamps: number[] = [];
    // Consume leading [..] tags.
    while (rest.startsWith("[")) {
      const close = rest.indexOf("]");
      if (close === -1) break;
      const tag = rest.slice(1, close);
      const ts = parseTimestamp(tag);
      if (ts != null) {
        stamps.push(applyOffset(ts, offsetMs));
      } else if (tag.startsWith("offset:")) {
        offsetMs = parseInt(tag.slice("offset:".length).trim(), 10) || 0;
      }
      rest = rest.slice(close + 1);
    }
    const text = stripWordTimestamps(rest.trim());
    for (const t of stamps) {
      lines.push({ timeMs: t, text });
    }
  }

  if (lines.length === 0) return null;
  lines.sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0));
  return { synced: true, provider: "lrc", lines, instrumental: false };
}

export function parsePlain(input: string, provider: string): Lyrics {
  return {
    synced: false,
    provider,
    instrumental: false,
    lines: input.split("\n").map((l) => ({ timeMs: null, text: l.replace(/\r$/, "") })),
  };
}

/**
 * The line highlighted at `positionSecs`: the last line whose timestamp is
 * <= position. `null` before the first line / for unsynced lyrics.
 */
export function activeLineIndex(lyrics: Lyrics, positionSecs: number): number | null {
  if (!lyrics.synced || lyrics.lines.length === 0) return null;
  const posMs = positionSecs > 0 && Number.isFinite(positionSecs)
    ? Math.round(positionSecs * 1000)
    : 0;
  let lo = 0;
  let hi = lyrics.lines.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((lyrics.lines[mid].timeMs ?? 0) <= posMs) lo = mid + 1;
    else hi = mid;
  }
  return lo === 0 ? null : lo - 1;
}

function applyOffset(t: number, offsetMs: number): number {
  return Math.max(0, t + offsetMs);
}

function parseTimestamp(tag: string): number | null {
  const m = /^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/.exec(tag);
  if (!m) return null;
  const mins = parseInt(m[1], 10);
  const secs = parseInt(m[2], 10);
  if (secs > 59) return null;
  let frac = 0;
  if (m[3]) {
    const f = m[3];
    frac = f.length === 1 ? parseInt(f, 10) * 100 : f.length === 2 ? parseInt(f, 10) * 10 : parseInt(f, 10);
  }
  return mins * 60_000 + secs * 1_000 + frac;
}

function stripWordTimestamps(text: string): string {
  return text.replace(/<\d{1,2}:\d{1,2}(?:\.\d{1,3})?>/g, "");
}
