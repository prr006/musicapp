# MELO

A lightweight, local-first desktop music player with the fundamentals you
expect from the big streaming apps — reliable playback, a real queue,
synchronized lyrics, a library that belongs to you — and none of the weight.
Built from scratch on **Tauri 2 + Rust + mpv + React**, Windows-first.

> **Playback reliability comes before visual polish.** A beautiful player
> that can't reliably advance from Song A to Song B is not acceptable.
> The state machines behind playback are pure Rust with unit tests
> (`cargo test -p melo-core`).

## What's implemented

* **Playback** — play/pause/seek/volume/mute/speed through a supervised mpv
  child process. End-of-file auto-advances in Rust; loading is distinct from
  playing; failures surface as errors, never silent stalls (30 s watchdog).
  If mpv crashes, MELO restarts it (≤ 3 attempts) and resumes paused at the
  last position — it never unexpectedly blares audio after a crash.
* **Queue** — full CRUD (play now / next / add / remove / jump / move /
  drag-reorder / clear), deterministic seeded shuffle, repeat off/all/one,
  queue history, all invariant-checked in `crates/melo-core/src/queue.rs`.
* **Search** — YouTube search via yt-dlp (flat results: title / artist /
  duration / artwork), with loading, empty, error and retry states. Recent
  searches are remembered and removable.
* **Library** — favorites, listening history with completion stats,
  playlists (create / rename / delete / duplicate / add-remove-reorder
  tracks / save-queue-as-playlist), album and artist views wherever track
  metadata actually carries them (no fake groups). Everything persists to
  `library.json` (atomic writes).
* **Lyrics** — LRCLIB lookup with a robust LRC parser: synced highlighting,
  click-to-seek, ±0.5 s sync adjustment, instrumental and not-found states.
  The highlighted line is a pure function of the engine position — there is
  no second clock to drift.
* **Now Playing** — full-screen view with artwork, transport, volume, speed,
  favorite toggle, queue drawer access, synced lyrics.
* **Settings** — theme (dark/light/system), accent, compact mode,
  animations, audio quality, autoplay-similar, restore-last-session (paused;
  **never autoplays on launch**), history on/off, close behavior, plus an
  honest diagnostics panel (mpv path, yt-dlp presence, quality label).
* **Shortcuts** — Space, ←/→ (seek), Ctrl+←/→ (prev/next), ↑/↓ (volume),
  M, S, R, L, Q, Ctrl+K, Esc. They never hijack typing.
* **Persistence** — settings, volume, repeat/shuffle, queue session with
  per-track position, favorites, playlists, history: all restored on
  restart, paused.

## The one rule

**Rust owns playback state.** React renders events and sends commands. The
frontend has no timers that advance playback or lyrics — one authoritative
clock (mpv's `time-pos`), extrapolated for at most 1.5 s between samples and
frozen (never drifted) when samples stop.

## Repository layout

```text
crates/melo-core/     Pure domain core (queue, playback, library, lyrics, yt-dlp parsing, tests)
src-tauri/            Tauri shell (mpv supervision + IPC, resolver, LRCLIB client, persistence)
src/                  React UI (event-fed stores, no state framework)
docs/                 ARCHITECTURE.md · IPC.md · DATA_MODEL.md · ROADMAP.md
tests/                Frontend test suites (mirror the Rust cases; mock only mpv + network)
docs/MANUAL_TEST.md   Human test checklist (Windows-first)
```

## Prerequisites

* [Node.js](https://nodejs.org) ≥ 20
* [Rust](https://rustup.rs) (stable)
* **[mpv](https://mpv.io)** — discovered in this order: `MELO_MPV_PATH`
  env var → `mpv/mpv.exe`-style path next to the app → `PATH`
* **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** on `PATH` for YouTube
  search/streaming (mpv's built-in ytdl hook is enabled either way; an
  explicit path is passed through when found). Local files play without it.
* Windows: WebView2 (installed by the Tauri bootstrapper)

## Development

```bash
npm install

# UI only, in a browser (mock backend simulates the Rust state machines):
npm run dev            # http://localhost:1420

# Full desktop app (Tauri + Rust + mpv):
npm run tauri dev

# Tests
npm run test           # frontend suites (vitest, jsdom)
cargo test             # Rust suites (melo-core + src-tauri)

# Type-check + production bundle of the UI:
npm run build

# Release build (Windows installer):
npm run tauri build
```

The browser preview runs against a **dev-only mock** that faithfully ports
the Rust state machines (queue, playback, library), so the UI can be
developed without native deps. In the packaged app the Tauri bridge is
selected automatically and **Rust is authoritative**. The mock never ships as
a substitute for the backend.

## Security posture

The webview gets `core:default` permissions only — no filesystem, shell, or
HTTP access. Every IPC input is validated in Rust (titles, ids, numeric
ranges). The UI renders text only; no `innerHTML`, no remote code.

## License

MIT
