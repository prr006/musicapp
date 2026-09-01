# MELO Architecture

MELO is a lightweight, local-first desktop music player. This document is the
map a developer needs before touching code — no knowledge of any older MELO
codebase is assumed (this is a clean-room build).

## 1. Stack

| Layer      | Technology                                  |
|------------|---------------------------------------------|
| Shell      | Tauri 2 (Windows-first, macOS/Linux-ready)  |
| State      | Rust (pure core crate + app service)        |
| Engine     | mpv (supervised child process, JSON IPC)    |
| Streaming  | yt-dlp (discovery + stream URL resolution)  |
| Lyrics     | LRCLIB (HTTP client in Rust)                |
| UI         | React 18 + TypeScript + Vite (no UI framework) |
| Storage    | JSON documents with atomic tmp+rename writes |

## 2. The one rule: Rust owns playback state

React renders backend state and sends user commands. It never invents or
simulates playback state. There is exactly **one authoritative playback
clock** (mpv's `time-pos`), delivered as `playback://position` events.

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

Everything funnels through a single service thread that owns `PlaybackCore`
(`crates/melo-core/src/playback.rs`). All state transitions — play, pause,
seek, EOF, queue mutations, mpv restarts — happen there, under one owner.
The frontend is a projection.

### The mandated flow, end to end

1. **React** calls a typed facade function (`src/app/api.ts`) →
2. **IPC bridge** (`src/app/ipc/`) invokes a Tauri command,
3. **commands.rs** validates input and forwards a `UserCommand`,
4. **PlaybackService** (single thread, `src-tauri/src/playback_service.rs`)
   applies it to **PlaybackCore** and emits **PlayerCommands** to mpv,
5. **mpv** answers **EngineEvents** (FileLoaded, EndFile, Seek, errors…),
6. the service folds them back into PlaybackCore and publishes
   **snapshots/queue views** via `events.rs`,
7. React stores receive them and the UI re-renders.

No step is skipped and there is no side channel: the frontend cannot touch
mpv, yt-dlp, or the filesystem.

## 3. Process supervision & reliability

* **mpv spawn** (`src-tauri/src/mpv/process.rs`): `--idle=yes --input-ipc-server`
  (or named pipe on Windows), `--ytdl=yes` with `--ytdl-path=<managed yt-dlp>`
  when available, `CREATE_NO_WINDOW` on Windows so no console flashes. The
  program itself is always an **absolute path** from the managed runtime
  (`src-tauri/src/runtime.rs`) — never a bare `mpv` from `PATH`.
* **Managed runtime** (`src-tauri/src/runtime.rs`): deterministic lookup
  (env overrides → dev checkout → bundled → managed config dir; no PATH), a
  first-run background download (mpv `.7z` via `7zr.exe`, stable `yt-dlp.exe`)
  reporting progress through `engine://status`, and a repair path used by
  Settings → Diagnostics. The bootstrap reloads the shared `RuntimeHandle` so
  the resolver and engine see the new binaries without an app restart.
* **Loading policy** (`mpv/ipc.rs`): every load normalizes pause state first
  (`set_property pause <p>`) and then `loadfile <url> replace` — two request
  ids, version-safe (no loadfile options map). Start positions are applied as
  an absolute seek *after* `file-loaded`, then unpaused if it should be
  sounding. This avoids the audio blip of loadfile-then-pause.
* **Watchdog**: a load that produces no `file-loaded` within 30 s is failed
  with a synthetic `EndFile{error}` and the user sees a toast.
* **Restart recovery**: mpv exits/crashes → up to 3 restarts (400 ms
  backoff). Recovery parks the track paused at its last position, then
  auto-resumes only if it was actually sounding. Otherwise the engine parks
  paused — no surprise audio. After 3 failures: engine `dead` + "restart
  MELO" message.
* **Single EOF path**: EOF is `EndFile{reason: Eof}` from mpv, nothing else.
  No timers, no frontend polling, no second guess.
* **Shutdown**: window-close requests flush the queue session (≤150 ms wait)
  so the next launch restores accurately.

## 4. The queue state machine

`crates/melo-core/src/queue.rs` — `QueueMachine` owns current/upcoming/
history with these invariants (unit-tested):

* current is unique; upcoming has no duplicates of the current item id,
* history is capped (500) and most-recent-first,
* `advance()` = load next / repeat-one replay / wrap (repeat all) / stop,
* shuffle is a deterministic seeded permutation (`fnv1a` of the upcoming
  order + generation) — re-shuffling mid-play never moves the current track,
* `previous()` seeks to 0 when >3 s into the track, else walks history.

The TS port in `src/app/ipc/mockQueue.ts` exists **only** for the browser
preview and is covered by mirrored test cases.

## 5. Library & persistence

`crates/melo-core/src/library.rs` — one JSON document (`library.json`,
format v3): liked tracks, playlists (+rows), listening history (capped 2000),
search history (capped 20), and a **track metadata index** so playlist rows
resolve even for tracks that were never played or liked. Older format
versions default-fill and backfill the index on load. Writes are atomic
(tmp + rename) and serialized behind one mutex.

Sessions (`session.json`): queue order + current item + per-track position +
volume/repeat/shuffle — saved debounced (3 s), on flush, and on exit. On
startup the session restores **paused**; nothing autoplays unless the user
had `resumeLastSession` on and presses play (spec §8).

Settings (`settings.json`) — same store pattern (`settings_store.rs`).

## 6. Search, streaming, lyrics

* **yt-dlp** (`src-tauri/src/ytdlp_proc.rs`, `crates/melo-core/src/ytdlp.rs`):
  `yt-dlp --flat-playlist --dump-single-json ytsearch10:<query>` for search;
  result mapping is defensive — missing artist/album/artwork/duration never
  panics, it degrades to "Unknown artist"/`—`. Streaming URLs resolve through
  the same resolver (quality setting → yt-dlp format selector), while local
  tracks resolve inline via filesystem.
* **LRCLIB** (`src-tauri/src/lrclib.rs`): HTTP via `ureq` with timeouts,
  404 → no lyrics (honest), 429 → rate-limited error, timeout/offline →
  retriable error. Best-match requires ≥25 % duration agreement;
  provider-marked instrumentals are surfaced as such.

## 7. Frontend

* Stores: tiny `createStore` (useSyncExternalStore). `playback`/`queue`/
  `library` stores are written **only** by backend events. `ui` store holds
  renderer-only concerns (route, overlays, toasts, draft settings).
* Clock (`src/app/stores/clock.ts` + `src/lib/clock.ts`): the only layer
  allowed to extrapolate between position samples — `pos + elapsed × speed`,
  quantized to 250 ms, frozen after 1.5 s without a sample. Progress bars,
  Now Playing and lyric highlighting all consume this one clock.
* Lyrics (`src/lib/lyrics.ts`): pure `position → active line` mapping
  (binary search), LRC parse with offsets and multi-stamp lines. Mirrors
  `crates/melo-core/src/lyrics.rs`.
* Views: Home (jump-back-in, recommendations from history, recents),
  Search (states + recent searches), Library (playlists CRUD, favorites,
  recently played with completion, songs, albums, artists), queue drawer,
  full-screen Now Playing, settings modal, toasts, skeletons/empty/error
  states throughout.
* Mock backend (`src/app/ipc/mock*.ts`) simulates the engine for browser
  development only; it is selected automatically when Tauri internals are
  absent and is never used in the packaged app.

## 8. Testing strategy

* **Rust** (`cargo test`): queue invariants, playback state machine
  (loading≠playing, EOF, restart), library CRUD + migration, lyrics parsing/
  matching, yt-dlp JSON parsing, persistence round-trips, IPC command
  behavior in `src-tauri`.
* **Frontend** (`npm test`): mirrored queue-machine cases, clock freeze/
  extrapolation, lyric mapping, library flows through the IPC surface,
  renderer smoke tests. TS mocks are used **only** for mpv and network
  behavior; domain logic is tested against the real Rust core (mirrored
  suites keep the TS mock honest).
* **Manual** (`docs/MANUAL_TEST.md`): the human checklist for real audio,
  real YouTube, real restarts on Windows.

## 9. Security

* Capability file grants `core:default` only — no fs/shell/http to the
  webview. CSP restricts to self (+https images for artwork).
* All command inputs validated in Rust (non-empty titles, id formats,
  numeric clamps: volume 0–100, speed 0.25–4, seek clamped to duration).
* No `innerHTML`, no remote code, no secrets in the frontend.
