# MELO Roadmap

Status of the rebuild spec's requirement groups, with where each concern
lives. Rule: implement → test → manually verify → fix regressions → move on.

## ✅ Playback engine (mpv supervision, EOF, restart recovery)

`src-tauri/src/mpv/*`, `src-tauri/src/playback_service.rs`,
`crates/melo-core/src/playback.rs`, `player.rs`

* Supervised mpv child (Unix socket / Windows named pipe), `CREATE_NO_WINDOW`
* Two-step load (pause normalize → loadfile), seek-after-loaded for starts
* 30 s load watchdog → surfaced error, never a silent stall
* Restart ≤ 3 with backoff; recovery parks paused then resumes only if it
  was sounding; `engine://status` toasts at every step
* Single EOF path (`EndFile{Eof}` from mpv), dedup safety net in core
* `loading` ≠ `playing`; `buffering` reported by mpv percent-pause events

## ✅ Queue

`crates/melo-core/src/queue.rs` (+ mirrored `src/app/ipc/mockQueue.ts`)

* Full CRUD incl. drag-reorder, move up/down, remove-current (auto-advance),
  jump, clear upcoming/all, save queue as playlist
* Deterministic seeded shuffle, repeat off/all/one, history walk-back
* Invariant tests on both sides (Rust suite + `tests/queueMachine.test.ts`)

## ✅ Search / discovery (yt-dlp)

`src-tauri/src/ytdlp_proc.rs`, `crates/melo-core/src/ytdlp.rs`,
`src/views/SearchView.tsx`

* Flat YouTube search (`ytsearchN:`), title/artist/duration/artwork mapping
  with defensive parsing (never crashes on missing metadata)
* Loading / empty / error / retry states; play, play-next, add-to-queue,
  context menu on results
* Search history: push on search, chips on Home + Search idle, per-item
  removal and clear-all

## ✅ Library

`crates/melo-core/src/library.rs`, `src/views/LibraryView.tsx`

* Favorites (heart in lists + Now Playing), listening history with played
  time and completion, playlists CRUD + duplicate + reorder + remove,
  save-queue-as-playlist, album/artist grouping **only when metadata exists**
* `library.json` format v3 with the track metadata index; atomic writes;
  default-fill migrations from v1/v2

## ✅ Now Playing + lyrics

`src/components/NowPlaying.tsx`, `src-tauri/src/lrclib.rs`,
`crates/melo-core/src/lyrics.rs`, `src/lib/lyrics.ts`

* Full-screen artwork, transport, volume, speed, favorite, queue drawer
* LRCLIB synced lyrics: robust LRC parse (offsets, multi-stamps, word-tag
  stripping), click-to-seek, ±0.5 s sync nudge, instrumental + missing states
* Highlighting is a pure function of the authoritative position

## ✅ Persistence & restart behavior

`crates/melo-core/src/persistence.rs`, `src-tauri/src/settings_store.rs`

* Settings, session (queue + position + volume + repeat/shuffle), library
* Restart restores paused — never autoplays (spec §8)

## ✅ Desktop UI polish

`src/components/*`, `src/styles/*`

* Sidebar/home/search/library/queue drawer/mini player/settings/toasts
* Skeleton + empty + error + offline states; context menus; dark/light/system
  + accents + compact; responsive down to ~980 px; global shortcuts (§21)

## ✅ Security

`src-tauri/capabilities/default.json`, `tauri.conf.json`, command validation

* `core:default` only; CSP; validated inputs; no innerHTML/secrets

## ✅ Tests + build

* Rust: queue/playback/library/lyrics/ytdlp/persistence/IPC suites
  (`cargo test`) — **cannot run in the Arena sandbox (no Rust toolchain
  available there); run locally before trusting green**
* Frontend: `npm test` (73 tests: queue mirror, clock, lyrics, library
  flows, renderer smoke) — passing
* `npm run build` (tsc + vite) — passing

## Explicitly not built yet (honest labels in UI)

* Volume normalization / crossfade / gapless tuning (preferences persist,
  behavior pending)
* Tray/minimize-to-tray, desktop notifications on track change
* Downloads/offline cache (`downloadDir` preference persists only)
* Artist/album **pages from search cards** (grouping views exist for
  collected metadata)
* Translations overlay for lyrics (`showLyricsTranslation` persists only)
