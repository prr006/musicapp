# MELO

A lightweight, local-first desktop music player with the fundamentals you
expect from the big streaming apps — reliable playback, a real queue,
synchronized lyrics — and none of the weight. Built from scratch on
**Tauri 2 + Rust + mpv + React**, Windows-first.

> **Playback reliability comes before visual polish.** A beautiful player
> that can't reliably advance from Song A to Song B is not acceptable.
> The state machines behind playback are pure Rust with ~60 unit tests.

## Highlights

* **Rust owns playback state.** React renders events and sends commands —
  it never simulates playback. One authoritative clock.
* **EOF auto-next in Rust.** When a track finishes, the queue advances in
  the backend (repeat off/all/one, deterministic shuffle) — no frontend timers.
* **Queue as a first-class state machine.** Play order, history, shuffle,
  reorder, remove-current, clear-upcoming — all safe mid-playback, all
  invariant-checked.
* **Lyrics follow the clock.** The highlighted line is a pure function of the
  engine-reported position: correct after seeks, pauses, buffering, speed
  changes, restarts.
* **Source-independent tracks.** `Track` has a `source` (youtube/local/…),
  and the engine resolves streams through a `Resolver` trait — local music
  and future providers plug in without rewriting playback.
* **No Electron. No old backend. No webview fs/shell permissions.**

## Repository layout

```text
crates/melo-core/     Pure domain core (queue, playback, lyrics, models, tests)
src-tauri/            Tauri shell (mpv engine, IPC, persistence, supervision)
src/                  React UI (event-fed stores, no state framework)
docs/                 ARCHITECTURE.md · IPC.md · DATA_MODEL.md · ROADMAP.md
tests/                Frontend test suites (mirror the Rust cases)
```

## Prerequisites

* [Node.js](https://nodejs.org) ≥ 20
* [Rust](https://rustup.rs) (stable) — for the backend
* **[mpv](https://mpv.io)** on `PATH` (Windows: also `mpv\mpv.exe` next to
  `MELO.exe` works, or set `MELO_MPV_PATH`)
* Windows: WebView2 (installed by the Tauri bootstrapper)
* Phase 5+ will require [yt-dlp](https://github.com/yt-dlp/yt-dlp) on `PATH`
  (until then mpv's built-in ytdl hook handles YouTube URLs if yt-dlp exists)

## Development

```bash
npm install

# UI only, in a browser (mock backend simulates the Rust state machines):
npm run dev            # http://localhost:1420

# Full desktop app (Tauri + Rust + mpv):
npm run tauri dev

# Tests
npm run test           # frontend suites (vitest)
cargo test             # Rust suites (melo-core + melo-app)

# Release build (Windows installer):
npm run tauri build
```

The browser preview runs against a **dev-only mock** that faithfully ports
the Rust state machines, so the UI can be developed without native deps. In
the packaged app, the Tauri bridge is selected automatically and **Rust is
authoritative**.

## Status

Phase 1 complete (skeleton + IPC + persistence + full UI shell), with the
Phase 2–4 core (mpv engine, playback state machine, queue + EOF auto-next)
implemented and unit-tested in Rust. See `docs/ROADMAP.md` for the phase plan
and what comes next (yt-dlp search, library, lyrics provider, downloads…).

## License

MIT
