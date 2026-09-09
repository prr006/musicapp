# MELO v3

MELO is an artwork-first music application for the **web and Windows desktop**.
One React + TypeScript UI runs against either a hosted Go HTTP API in Chrome,
Firefox, and Edge or the existing lightweight Wails/WebView2 desktop shell. The
browser build is a responsive PWA with HTMLAudioElement playback, Media Session
controls, queue/discovery, LRCLIB lyrics, recommendations, persistent anonymous
libraries, and optional accounts.

MELO searches YouTube Music and resolves browser-compatible audio on the Go
side. Hosted clients receive short-lived signed playback links; provider URLs,
headers, executables, credentials, and filesystem access remain server-side.
Desktop continues to use its local capability proxy and the local JSON library.

---

## Architecture

```
React UI (TypeScript)                   Go services
────────────────────────                ─────────────────────────────
views/ components/ state/               internal/provider  YouTube Music + yt-dlp fallback
         │                              internal/media     resolver + reusable Range streamer
bridge/Backend                          internal/lyrics    LRCLIB matching + LRC parser
   ├── WailsBackend ─────────────────►  app.go             desktop bindings/local store
   └── WebBackend ─── HTTPS JSON ────►  server/api         auth/cache/limits/radio/library
                                           │
                                           └── server/store Repository
                                               ├── account file store (development/current)
                                               └── PostgreSQL schema/adapter boundary
```

Rules the codebase holds to:

- **One authority per concern.** One playback controller, one queue, one current
  track, one library store. Position and duration exist only inside the audio
  engine's `positionChannel` — there is no second playback clock and no
  independent lyric timer; the lyric highlight is derived from the element's real
  `timeupdate`.
- **Player-authoritative time.** The `HTMLAudioElement` in WebView2 is the clock.
  Go never guesses where playback is.
- **Resolver is independent of the player.** `search provider → Track →
  resolver → PlayableSource → player`. Swapping the resolver does not touch
  playback code.
- **Generation tokens on every async step.** Each track switch takes a new token;
  a late resolver, lyric fetch or artwork load whose token is stale is dropped
  instead of overwriting the newer track.
- **Position updates do not rerender the app.** They go through a subscription
  channel that only the scrubber, time labels and lyric pane read.

### Why this playback backend

| Option | Verdict |
| --- | --- |
| libmpv / mpv sidecar | Rejected. ~40 MB of native DLLs, a process supervisor, IPC state machine, and the exact architecture that made previous MELO builds fragile. |
| Go audio libraries (beep, oto, malgo) | Rejected. They need decoded PCM: MELO would have to demux/decode AAC/Opus itself, plus cgo, plus a device-loss story. |
| **WebView2 `HTMLAudioElement` fed by a Go loopback proxy** | **Chosen.** |

WebView2 (a Chromium media pipeline that is already installed on Windows) plays
YouTube's `m4a`/`opus` streams natively, gives accurate `timeupdate`/`ended`
events, and supports seeking and playback rate with zero extra binaries. The Go
side resolves a stream URL with yt-dlp and serves it to the webview through a
loopback HTTP proxy bound to `127.0.0.1` on a random port with a per-track
capability token. The proxy forwards `Range` requests (so seeking works), and if
YouTube expires a URL mid-playback (403/410) it re-resolves once, transparently.
Total native surface: one HTTP handler and one yt-dlp invocation.

---

## Features

**Playback** — play / pause / resume / stop / next / previous / seek / volume /
mute / speed (0.5×–2×), shuffle, repeat off-one-all, natural EOF auto-advance.
Manual **Stop never advances** the queue. EOF and manual Next each advance
exactly once. Previous restarts the track if more than 3 s have elapsed.
Rapid track switching is safe: A is stopped and its state (metadata, artwork,
lyrics, progress) cleared before B loads, and A's in-flight results are rejected.
A browser-only official YouTube IFrame adapter can be validated with
`?player=youtube`: the real video remains visible in a compact Now Playing
surface while Melo controls it through the same queue/controller adapter seam.
That path consumes provider IDs directly and never calls the resolver or stream
routes; the resolved desktop/default web path and all backend code remain intact.

**Search** — real YouTube Music InnerTube search with a yt-dlp `ytsearch`
fallback, filters for songs / videos / albums / artists, single click to play,
independent secondary buttons (like, add to queue, play next, add to playlist,
more) that never trigger playback. Loading, results, empty, error + retry states.
Search history is persisted and removable.

**Queue** — real queue with play next, add to end, remove, drag-free reorder,
clear upcoming, shuffle upcoming (current track never moves), dedupe. Autoplay
("keep playing similar music") is a **separate** auto-queue, clearly labelled and
switchable off in settings. It refills five-to-eight prepared tracks incrementally,
limits one normalized primary artist to two visible generated entries, and never
counts, reorders, replaces, or delays explicit user additions for diversity.

**Library** — Liked Songs, Songs, Albums, Artists, Playlists, Recently Played.
Albums and artists are *derived from real track metadata only*; nothing is
invented to fill a grid. Opening an album or artist you don't actually have shows
an explicit empty state.

**Playlists** — create, rename, delete, add, remove, reorder, duplicate, play,
shuffle-play, and save the current queue as a playlist.

**Lyrics** — LRCLIB, synced (LRC) and plain, with instrumental / not-found /
network-failure states handled distinctly. Highlighting is driven purely by the
player's position and a per-track offset.

**Desktop integration** — global media keys (play/pause, next, previous, stop),
a notification-area icon with a transport context menu (play/pause, next,
previous, show, quit), close-to-tray, balloon notifications on track change,
session restore (queue + track + position), and a clean shutdown that flushes
state and stops the proxy. All of it is plain `user32`/`shell32` syscalls — no
extra dependencies — and each piece degrades to "off" if Windows refuses it.

**UI** — MELO's own dark/light identity (deep slate + ember accent, seven
selectable accents), keyboard shortcuts, persistent mini player, Now Playing
view, Home, Artist and Album pages.

Keyboard: `Ctrl/⌘+K` search · `Space` play/pause · `←/→` seek 5 s ·
`Ctrl+←/→` prev/next · `↑/↓` volume · `M` mute · `S` shuffle · `R` repeat ·
`L` like · `Q` queue · `Y` lyrics · `Esc` close panel.

---

## Run MELO Web

```bash
# Terminal 1 — API (Go 1.23+)
MELO_YTDLP="$(command -v yt-dlp)" go run ./server

# Terminal 2 — browser UI
cd frontend
npm install
npm run dev
# open http://localhost:5173
```

Or run `./scripts/dev-web.sh`. Vite proxies `/api` to the Go process; web
development does not require Wails. `docker compose up --build` can run the API
with its pinned server-side resolver. See:

- [Local development and exact Railway/Vercel steps](docs/WEB_DEPLOYMENT.md)
- [HTTP API](docs/WEB_API.md)
- [Desktop/web compatibility matrix](docs/COMPATIBILITY.md)

## Requirements

- Web: current Chrome, Firefox, or Edge on desktop/mobile; Go 1.23+ and Node 20+
  for development.
- Windows desktop: Windows 10 1809+ or Windows 11 with the **WebView2 runtime** (preinstalled on
  Windows 11 and on up-to-date Windows 10).
- Internet access for search, streaming and lyrics. Desktop library data is
  local; hosted library data is persisted by the configured API repository.

## Build

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.1
wails build            # -> build/bin/MELO.exe
wails dev              # hot-reloading dev build
```

Frontend-only work:

```bash
cd frontend
npm install
npm run dev      # Vite on :5173
npm test         # vitest
npm run build    # type-check + production bundle into frontend/dist
```

Go:

```bash
go test ./...
go vet ./...
```

## Data

Desktop state lives in `%AppData%\MELO\melo-state.json`. The hosted development
repository keeps one isolated document per signed anonymous/account subject under
`MELO_DATA_DIR/accounts`; the API never accepts a storage path from a client.
Writes are atomic and debounced by 250 ms. A corrupt document is preserved with a
`.corrupt` suffix. History is capped at 500 entries with a 30 s consecutive
dedupe window; search history at 50.

## The resolver dependency

MELO uses **yt-dlp** to turn a YouTube video id into a playable audio URL. It is
not assumed to be on `PATH` and is never invoked from a directory the dev watcher
looks at.

- The version is pinned in `internal/deps/manifest.json` (currently
  `2026.08.19`) and the binary is installed to
  `%LocalAppData%\MELO\bin\yt-dlp.exe`.
- Downloads are verified against SHA-256 before the file is put in place, from
  the release's published `SHA2-256SUMS`.
- Installation happens once, on explicit user action from Settings → Resolver (or
  the actionable error shown when playback needs it). There is no bootstrap loop
  and no silent background retry: a failure reports the URL, the HTTP status or
  the digest mismatch.
- `go run ./tools/pindeps [version]` refreshes the manifest digests. **Run it and
  commit the result whenever the pinned version changes** — see the limitation
  below.

## Known limitations

- **Digest pinning is trust-on-first-use in this checkout.** The sandbox this
  release was built in cannot reach GitHub release assets, so the `sha256` fields
  in `internal/deps/manifest.json` are empty. With empty digests MELO falls back
  to verifying the downloaded binary against the `SHA2-256SUMS` file published
  with the *same pinned release* — which authenticates the download against
  GitHub but not against a digest reviewed in source control. Running
  `go run ./tools/pindeps` on a networked machine and committing the manifest
  closes this gap.
- **Not validated on real Windows hardware.** Everything here was built and
  tested on headless Linux. The Windows binary cross-compiles (7.6 MB, stripped)
  and all automated tests pass, but no one has yet run `MELO.exe` on Windows and
  played audio, used media keys, the tray icon or notifications. The Win32
  syscall layer (`mediakeys_windows.go`, `tray_windows.go`) is compiled and
  reviewed, not observed — treat it as the first thing to check on a real
  machine.
- **No live network validation.** YouTube and LRCLIB are unreachable from the
  build environment, so the provider, resolver and lyrics clients are covered by
  tests against recorded/served fixtures rather than the live services.
- The hosted account repository currently uses account-scoped atomic files. The
  PostgreSQL repository interface and normalized migration are present, but the
  production PostgreSQL adapter and cross-device desktop sync remain follow-up.
- To use the browser-only fixture backend, create
  `frontend/.env.development.local` with `VITE_MELO_MOCK=1`; normal development
  uses the real Go HTTP API.
- No local-file library, gapless/crossfade, equalizer, or offline music cache.
  The PWA caches only the application shell and static assets.
- Album and artist pages cover what is in your library; MELO does not browse a
  catalogue it hasn't got metadata for.
