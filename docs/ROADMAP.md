# MELO Roadmap

Phases from the rebuild spec, with status and where each concern lives in the
codebase. Rule: implement → test → manually verify → fix regressions → move on.

## Phase 1 — Project skeleton + Tauri + React + Rust IPC ✅

* Cargo workspace (`melo-core` pure crate + `melo-app` Tauri shell)
* React + TS + Vite frontend, no UI framework
* Typed IPC bridge (tauri + dev mock), events feed stores
* Settings/session persistence (atomic JSON)
* 46 frontend tests + ~60 Rust unit tests (queue/playback/lyrics/persistence)
* Browser preview runs the full UI against the mock backend

## Phase 2 — mpv integration ✅ (code complete; verify on Windows/macOS/Linux with mpv installed)

* Supervised mpv child process, Unix socket / Windows named pipe transport
* JSON IPC encode/decode with unit tests
* Property observers (time-pos, duration, pause, eof, seeking, buffering,
  volume, mute, speed, idle-active)
* Restart with backoff (max 3), resume-at-position recovery

## Phase 3 — Reliable playback state ✅

* `PlaybackCore` state machine: status transitions, seeks (clamped), volume/
  mute/speed, buffering, errors, safety-net EOF dedup
* One authoritative clock; throttled position publishing
* Session restore (no autoplay; Play resumes at saved position)

## Phase 4 — Queue + EOF auto-next ✅

* Queue machine with play order/cursor/history, deterministic shuffle,
  repeat off/all/one, all mutations safe mid-playback
* EOF auto-next in Rust; user Stop can never advance the queue

## Phase 5 — YouTube search + yt-dlp resolution (next)

* Implement `SearchProvider` + `Resolver` over yt-dlp JSON output
* Worker pool for resolutions (never block the service loop)
* Quality selection (honest labels), resolution cache, offline reuse
* Search UI wiring (view already exists), artist/album pages

## Phase 6 — Library + favorites + playlists

* SQLite repositories (`LibraryRepository` traits), likes, playlists CRUD +
  reorder, folders/smart-playlist hooks in the model

## Phase 7 — Lyrics

* LRCLIB client in Rust (parse/model already in core + tests)
* Cache per track; unsynced fallback; unavailable states

## Phase 8 — Now Playing + Mini Player polish

* Dominant-color extraction from artwork, background blur, visualizer,
  transitions (respect reduced-motion settings)

## Phase 9 — History + recommendations

* History store (track, timestamps, completion), Recently Played,
  Continue Listening, local recommendation heuristics

## Phase 10 — Downloads / offline

* Persistent download records, progress/pause/resume/cancel, storage usage,
  offline playback through the local resolver

## Phase 11 — Local music

* Folder import/scan, metadata + artwork, local lyrics; `TrackSource::Local`
  end-to-end through the existing player abstraction

## Phase 12 — Desktop integration + packaging

* Windows SMTC media keys, tray + close behavior, notifications, sleep timer
  UI, installer (NSIS/MSI), startup profiling

## Verification notes

* `npm run test` — frontend suites (queue parity, lyrics parity, mock engine)
* `cargo test` — Rust suites (run on a machine with the Rust toolchain; this
  repo's CI sandbox could not install Rust)
* `npm run tauri dev` — full app (requires mpv on PATH or `MELO_MPV_PATH`)
