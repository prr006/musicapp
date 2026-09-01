# MELO Architecture

A deliberately small desktop music app: **libmpv is the media engine, MELO is
the application around it.** No custom media framework, no process
supervisor, no duplicate playback state machine.

```
┌──────────────────────────── Tauri webview ────────────────────────────┐
│  React UI (views/components)                                          │
│    ▲ stores: playback / queue / position / library / ui               │
│    │ useClock — interpolation ONLY, re-anchored by every engine event │
│  PlaybackController (src/player/controller.ts)                        │
│    ├─ QueueMachine (src/player/queue.ts) — app-level queue            │
│    ├─ Autoplay service (src/player/autoplay.ts, off by default)       │
│    └─ resolve cache → `resolve_track` IPC                             │
│  ▲ events                          │ commands                          │
└───│────────────────────────────────│──────────────────────────────────┘
    │ player://state | position | end│ player_load/play/pause/seek/…
┌───│────────────────────────────────▼──────────────────────────────────┐
│  Rust native layer (src-tauri, ~1400 lines total)                    │
│   libmpv.rs — runtime-loaded libmpv-2.dll: commands in, events out   │
│   runtime.rs — pinned + SHA-256-verified libmpv/yt-dlp management    │
│   ytdlp.rs   — search/resolve subprocess (absolute path)             │
│   lrclib.rs  — lyrics provider (LRCLIB)                              │
│   library/settings/persistence — local-first JSON stores             │
└───────────────────────────────────────────────────────────────────────┘
```

## 1. Playback engine: libmpv, in-process

`src-tauri/src/libmpv.rs` is the ONLY media code in the project.

* **Startup threading (the Windows freeze fix)**: the engine is ALWAYS
  constructed on a dedicated `melo-engine-start` background thread —
  `start_engine` only spawns it and returns, so Tauri's `.setup()` never
  waits on libmpv. `mpv_create` starts mpv's core thread whose pre-init
  playloop runs the dispatch handshake; calling `mpv_set_option*` /
  `mpv_initialize` synchronously on the idle UI thread could park both
  threads forever inside `mp_dispatch_lock` (window "Not Responding", 0 CPU).
  Once `mpv_initialize` returns, the finished `Player` is installed into the
  app state and the UI gets a `runtime://status` "ready" event; failures
  arrive as an "error" event with the real mpv message. Shutdown cannot race
  startup: a `Player` becomes visible only after full initialization, and
  the app flags `exiting` before tearing the engine down, so an in-flight
  start aborts or destroys its own instance.
* **Loading**: `libmpv-2.dll` is loaded at runtime with `libloading` from an
  absolute path provided by `runtime.rs`. No import library, no build-time
  mpv requirement, no PATH lookup, and no subprocess to supervise. Before
  any mpv object exists, the reported client API version is gated against
  the verified major (2) and logged; `"mpv-version"` is read only AFTER
  `mpv_initialize`.
* **API surface**: the string-based subset of the mpv client API
  (`mpv_command`, `mpv_set_property_string`, `mpv_observe_property`,
  `mpv_wait_event`, …). Constants/struct layouts follow
  `include/mpv/client.h` (a unit test pins them).
* **Configuration**: `idle=yes` (the engine outlives tracks), `vid=no`
  (audio-only), `cache=yes`, `load-scripts=no` — mpv's own ytdl hook is never
  used because MELO resolves URLs itself.
* **Events, not polling**: one thread blocks in `mpv_wait_event` and forwards
  `PROPERTY_CHANGE` (time-pos, duration, pause, paused-for-cache, seeking,
  speed, volume, mute), `FILE_LOADED`, `SEEK`, `PLAYBACK_RESTART`,
  `END_FILE` (with its reason) and `SHUTDOWN` to the app as Tauri events.
  **There is no watchdog** — the load-abort case of the old design does not
  exist: a failed load arrives as `END_FILE(reason=error)`.
* **Epoch guard**: every `player_load` returns a new epoch; end-of-file
  events carry it. The controller drops stale notifications when tracks are
  switched rapidly.

Why not the old mpv-subprocess + named-pipe + JSON-IPC design? It needed a
process supervisor, restart policy, load watchdog and a parallel playback
state machine — exactly the complexity that made playback fragile. libmpv
removes all of it: the engine is a function call away and events arrive on a
thread we own.

## 2. Authoritative state & the clock

libmpv is the single source of truth for status/position/duration/paused/
buffering. The Rust layer caches observed values only to answer
`player_get_state`; it never invents values.

The UI interpolates position between authoritative samples for a smooth
progress bar (`src/lib/clock.ts` + `stores/clock.ts`): it derives from the
latest sample + engine speed and **re-anchors on every engine state event**
(seek, pause, resume, buffering, track change, speed change). If samples go
stale the clock freezes rather than drift. There is no independent
frontend timer driving playback.

### Track-change contract (stop-first)

Every track change in the controller (`src/player/controller.ts`) follows
one strict order: **stop the old file → reset visible state (title, artist,
artwork, position, clock) → publish the new track as "loading" → only then
resolve + `player_load`**. The old song never plays under the new title, and
a generation counter (`loadGen`) discards resolves that finish after a newer
play request. Engine events are additionally guarded by the load `epoch`.

## 3. Queue — an application concept

The queue lives entirely in the frontend (`src/player/queue.ts`, pure and
unit-tested). The engine knows nothing about it.

* Automatic advance is triggered ONLY by a natural engine EOF
  (`END_FILE reason=eof`). Manual stop (`reason=stop`) never advances.
* Duplicate EOF notifications cannot double-advance: each load gets a fresh
  token and only the current file's token may advance the queue.
* Manual Next advances exactly once. Previous restarts the current track
  when more than `PREVIOUS_RESTART_THRESHOLD_SECS` (3 s) has played,
  otherwise walks history (documented desktop-player behavior).
* Shuffle is seeded/deterministic; repeat supports off/one/all.
* Removing the CURRENT item is a single advance decided by the queue and
  executed by the controller — the removed track never keeps playing.
* Autoplay (continue with related music after the queue is exhausted) is a
  SEPARATE service (`src/player/autoplay.ts`), OFF by default; when enabled
  it picks the most-played music already in the library (no network).

## 4. YouTube / yt-dlp — independent of the player

`search` (flat results) and `resolve_track` (direct media URL) run the
managed `yt-dlp.exe` with an absolute path, hidden window and hard timeouts.
The player only ever receives a playable URL — it has no yt-dlp knowledge.
The controller caches resolved URLs (30 min TTL, media URLs expire).

## 5. Managed runtime (pinned + verified)

Two files: `libmpv-2.dll` and `yt-dlp.exe`.

* Lookup order (first hit wins, **no PATH ever**): `MELO_RUNTIME_DIR/bin` →
  `<exe_dir>/runtime/bin` (installed builds, bundle.resources) →
  `<repo>/.melo-runtime/bin` (dev cache — outside every dev-watcher path so
  `tauri dev` never restarts mid-download) → `<config>/runtime/bin`.
* Downloads are **pinned to exact release tags** and verified against the
  SHA-256 digest GitHub publishes for that asset:
  * libmpv: zhongfly/mpv-winbuild `2026-08-31-02a595ddc1`
    (`mpv-dev-x86_64-*.7z`, unpacked once with pinned `7zr.exe` from
    ip7z/7zip `26.02`)
  * yt-dlp: yt-dlp `2026.08.19` (`yt-dlp.exe`)
* A failed check discards the download and reports an actionable error
  (Settings → Diagnostics → Repair runtime re-downloads from scratch).
* Progress/status is reported via `runtime://status` events.

## 6. Local-first persistence

`<config>/` holds `settings.json`, `library.json` (likes, playlists,
history, search history), `session.json` (queue + position, owned by the
frontend controller) and `lyrics-cache/`. Writes are atomic (tmp + rename).
Track ids are source-namespaced (`yt:…`, `local:…`) so the model is not
permanently tied to YouTube.

## 7. Lyrics

LRCLIB via `lrclib.rs` (exact match, then search; cached). Synced/plain/
missing/malformed all handled by `melo-core::lyrics`. The active line is
derived FROM THE PLAYER POSITION on every render — there is no second lyric
timer; seeking changes the line instantly, pausing freezes it.

## 8. What was removed (2026-09 redesign)

* mpv subprocess + named-pipe/JSON IPC + supervisor + restart policy +
  load watchdog (`src-tauri/src/mpv/`, `playback_service.rs`)
* Rust playback/queue state machines (`melo-core::{playback,player,queue}`)
  — replaced by the frontend queue machine tested against its real
  implementation
* The Rust resolver service (resolution is a command now) and the
  TypeScript mirror of the old Rust queue (the "fake" the old tests ran
  against)
