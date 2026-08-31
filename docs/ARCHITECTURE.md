# MELO Architecture

MELO is a lightweight, local-first desktop music player. This document is the
map a developer needs before touching code — no knowledge of the old MELO
codebase is assumed or required (this is a clean-room rebuild).

## 1. Stack

| Layer      | Technology                                  |
|------------|---------------------------------------------|
| Shell      | Tauri 2 (Windows-first, macOS/Linux-ready)  |
| State      | Rust (pure core crate + app service)        |
| Engine     | mpv (supervised child process, JSON IPC)    |
| Streaming  | yt-dlp (Phase 5)                            |
| Lyrics     | LRCLIB (Phase 7)                            |
| UI         | React 18 + TypeScript + Vite (no UI framework) |
| Storage    | JSON (session/settings now) → SQLite (library/history later) |

## 2. The one rule: Rust owns playback state

React renders backend state and sends user commands. It never invents or
simulates playback state. There is exactly **one authoritative playback
clock** (the engine's `time-pos`).

```text
┌────────────┐  invoke(commands)   ┌──────────────┐  UserCommand   ┌─────────────┐
│   React    │ ──────────────────► │ Tauri        │ ─────────────► │ Playback    │
│  (renders) │                     │ commands.rs  │                │ service     │
│            │ ◄────────────────── │ events.rs    │ ◄───────────── │ (1 thread)  │
└────────────┘  emit(events)       └──────────────┘  snapshots     └──────┬──────┘
                                                                            │
                                                     PlayerCommand / EngineEvent
                                                                            │
                                                                     ┌──────▼──────┐
                                                                     │ mpv process │
                                                                     │ (JSON IPC)  │
                                                                     └─────────────┘
```

Everything funnels through a single service thread that owns `PlaybackCore`,
so there are no races over playback state and no locks around the state
machine.

## 3. Crate layout

```text
crates/melo-core/          Pure Rust. No Tauri, no mpv, no async, no I/O.
  domain.rs                Track/Artist/Album/Playlist/Download/History models
  queue.rs                 Queue state machine (order, cursor, history, shuffle, repeat)
  playback.rs              Playback state machine (status, EOF auto-next, seeks, session)
  player.rs                Player abstraction: PlayerCommand / EngineEvent protocol
  lyrics.rs                LRC parsing + position→line lookup
  providers.rs             Resolver / SearchProvider traits + error taxonomy
  persistence.rs           Settings + SessionSnapshot, atomic JSON I/O

src-tauri/src/             The application (thin glue, no business logic).
  lib.rs                   Tauri builder, setup, window lifecycle
  commands.rs              IPC surface (validate → UserCommand → send)
  events.rs                Event names + payloads
  playback_service.rs      The single state-owning loop; supervision; persistence
  resolver.rs              Phase-1 resolver (local path / YouTube watch URL)
  mpv/ipc.rs               mpv JSON IPC protocol encode/decode
  mpv/process.rs           Process spawn, Unix socket / Windows named pipe transport
  settings_store.rs        Settings load/save

src/                       React UI.
  app/ipc/                 Bridge (tauri | mock), typed command/event contract
  app/stores/              playback / queue / position / ui stores (event-fed)
  app/api.ts               The only place that calls invoke()
  components/              Sidebar, MiniPlayer, NowPlaying, QueuePanel, ...
  lib/lyrics.ts            Frontend lyric-line matching (pure, position-driven)
```

**Why a separate core crate?** Everything in `melo-core` is deterministic and
unit-testable without a window, a process, or the network. The critical
behaviors (EOF auto-next, queue mutations mid-playback, lyric sync) are proven
here, in code that can never be affected by UI churn.

## 4. The player abstraction

The state machine never talks to mpv. It speaks a small data protocol
(`player.rs`):

* `PlayerCommand` — semantic intents (`LoadTrack { track, start_paused, start_at }`,
  `SetPaused`, `SeekAbsolute`, `SetVolume`, …). Note `LoadTrack` carries a
  **Track, not a URL** — resolution is a host concern (Phase 1: direct URL /
  mpv ytdl_hook; Phase 5: explicit yt-dlp), which is what keeps the core
  source-agnostic.
* `EngineEvent` — ground truth (`FileLoaded`, `EndFile { reason }`,
  `PropertyTimePos(f64)`, `PropertyPaused`, `PropertyBuffering`, …).

A different engine can implement this protocol without touching state logic.

### EOF policy (spec §3)

`EndFile { reason: Eof }` is **the** auto-next signal. Two observers exist
only as safety nets and are latched off by `eof_handled`:

1. `eof-reached` property change
2. unexpected `idle-active` (never fires after a user Stop — checked via
   status, so stopping can never advance the queue)

Auto-next flow: mpv `end-file(eof)` → `queue.advance(false)` → `Load(next)`
→ mpv loads → `FileLoaded` → status `Playing` → events → React re-renders.
No frontend timer is ever involved.

## 5. Queue model

```text
items   : Vec<QueueItem>      canonical storage (display order, shuffle off)
order   : Vec<QueueItemId>    the play sequence — a permutation of items
cursor  : Option<usize>       position in `order` of the current item
history : Vec<QueueItemId>    previously played (bounded, most recent last)
```

Invariants (asserted in tests):

1. `order` is always a permutation of `items` — no duplicates, no gaps.
2. Toggling shuffle never moves or replaces the current item:
   `order = [current] + shuffled(upcoming) + already_played`.
3. History entries always reference live items; removing an item purges its
   history references.
4. Shuffle is deterministic (seeded xorshift64*): same seed + same queue ⇒
   same play sequence (testable, reproducible).

Semantics (see `queue.rs` tests for the exact expected outcomes):

* **Next (user)** skips even in repeat-one; **EOF** in repeat-one replays.
* EOF at the end: repeat-all wraps; repeat-off stops (current track stays
  visible, status `idle`).
* Removing the current item loads whatever follows it in play order.
* "Play next" inserts after the cursor; "Add to queue" appends (random spot
  in the upcoming span while shuffled).
* `previous`: >3 s into the track → seek to 0 (policy lives in the playback
  SM, which knows the position); otherwise walk history.

## 6. Lyrics synchronization (spec §11)

There is no lyric clock. The highlighted line is a pure function of the
authoritative position:

```text
mpv time-pos → EngineEvent::PropertyTimePos → PlaybackCore.position_secs
   → throttled playback://position events (≥0.2 s spacing)
      → active_line_index(position) — binary search: last line with time ≤ pos
```

Because it is position-derived, it is automatically correct after seeks,
pauses, buffering, track changes, auto-next, restarts, and speed changes
(the engine reports media time; the lookup uses media time).
`melo-core::lyrics` owns parsing (LRC, offsets, enhanced-LRC, LRCLIB entries)
and lookup; `src/lib/lyrics.ts` mirrors the lookup for rendering and both are
covered by mirrored test suites. The data model already reserves
`translation` and `pronunciation` fields.

## 7. Events & rendering performance (spec §34)

* `playback://state` — full snapshot, only when something changed (dirty
  flags).
* `playback://position` — `{positionSecs, durationSecs, speed}` at ~4–5 Hz
  while playing (throttled in Rust), immediate on seek/pause/track change.
* `queue://view` — current + upcoming + history on every queue mutation.
* `engine://status` — engine health for toasts.

The React position store is separate from the snapshot store so 5 Hz updates
re-render only progress/lyrics components (`useSyncExternalStore` selectors),
never the tree. No polling anywhere: the UI is 100% event-fed.

## 8. Persistence (spec §31)

* `settings.json` — user preferences (atomic write).
* `session.json` — serialized queue machine + audio state + position
  (debounced 3 s, forced on close). Restore adopts the queue and position but
  **never autoplays**; the first Play resumes at the saved position.
* Library/playlists/history/downloads move to SQLite repositories in their
  phases (trait boundaries already defined in core).

## 9. Security (spec §33)

* Capability file grants only `core:default` (events/window). No fs, shell,
  or http permissions reach the webview.
* Strict CSP; `connect-src` limited to the Tauri IPC.
* All IPC inputs validated in `commands.rs` (finite numbers, ranges, non-empty
  ids, track shape) before reaching the state machine.
* The frontend can never issue raw mpv commands — `PlayerCommand` is a closed
  Rust enum; only the semantic surface is exposed over IPC.
* No secrets in the frontend; no arbitrary HTML rendering (React escaping
  only); external metadata is rendered as text.

## 10. Engine supervision

mpv is spawned with `--idle` + `--input-ipc-server` (Unix socket / Windows
named pipe `\\.\pipe\melo-mpv-<pid>`). The reader thread delivers events;
process death delivers `ProcessExited`, which:

1. marks the state machine error (toast),
2. respawns the engine (max 3 attempts, 400 ms backoff),
3. parks the interrupted track so the user's next Play resumes where it died.

## 11. Browser preview (dev only)

`npm run dev` outside Tauri uses a **mock bridge** (`src/app/ipc/mock.ts`) —
a faithful TS port of the core state machines driving the identical UI. It
exists so the interface can be developed in a browser; in the packaged app
the tauri bridge is selected automatically (`__TAURI_INTERNALS__` present)
and Rust is authoritative. The mock is covered by mirrored tests to prevent
semantic drift.

## 12. Future phases (design hooks already present)

* `TrackSource` enum + `Resolver` trait — local files and future providers
  plug in without touching playback (Phase 11).
* `Playlist.parent_id`/`kind` — folders and smart playlists (Phase 6+).
* `LyricLine.translation`/`pronunciation`; LRCLIB entry parsing in core.
* `Download` domain model with persistent states (Phase 10).
* Tray/notification hooks land with Phase 12 (`tray-icon` feature flag).
