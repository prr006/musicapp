# MELO v3

A lightweight desktop music player for Windows. Native shell in Go
([Wails v2](https://wails.io) / WebView2), UI in React + TypeScript. No Electron,
no bundled Chromium, no Rust, no libmpv — the shipped app is a single ~5 MB
executable that renders in the WebView2 runtime already present on Windows 10/11.

MELO searches YouTube Music and plays tracks through the **official YouTube
embedded player (IFrame API)**, wrapped in its own player UI, and keeps a local
library (likes, playlists, listening history) in a single JSON file you own.

---

## Architecture

```
React UI (TypeScript)                          Go (native shell)
──────────────────────────                     ─────────────────────────────
views/  components/                            app.go             Wails bindings
   │                                          internal/provider   YT Music InnerTube search
state/playback.ts   ◀── one controller        internal/lyrics     LRCLIB client + LRC parser
state/recommender.ts ◀─ autoplay buffer       internal/store      atomic JSON persistence
audio/youtubeAdapter.ts ── YouTube IFrame     mediakeys / tray    Win32 integrations
bridge/backend.ts   ── typed adapter
```

Canonical playback path — one direction, one authority per layer:

```
UI
  ↓
Queue / Playback Controller (state/playback.ts)
  ↓
PlaybackAdapter (audio/adapter.ts contract)
  ↓
YouTube IFrame Player (audio/youtubeAdapter.ts)
```

Rules the codebase holds to:

- **One authority per concern.** One playback controller, one queue, one current
  track, one library store. Position and duration exist only in the position
  channel fed by the adapter — there is no second playback clock.
- **The provider is behind an adapter.** `PlaybackAdapter` is a small contract
  (`beginLoad` / `load` / `play` / `pause` / `seek` / volume / rate / events).
  The YouTube adapter is the only code that knows the IFrame API exists; the
  controller hands it a `Track` and nothing else. Swapping providers cannot
  touch queue or recommendation logic, and vice versa.
- **No media extraction.** There is no resolver, no stream proxy, no yt-dlp and
  no `/resolve`/`/stream` endpoint anywhere. Playback is the official embedded
  YouTube player, driven by `loadVideoById` with the track's YouTube id.
- **Generation tokens on every async step.** Each track switch takes a new token;
  a late load, lyric fetch or artwork load whose token is stale is dropped
  instead of overwriting the newer track.
- **Position updates do not rerender the app.** They go through a subscription
  channel that only the scrubber, time labels and lyric pane read.
- **Recommendation logic is separate from playback.** `lib/profile.ts` (what the
  listener enjoys) and `lib/recommend.ts` (deterministic scoring + diversity)
  are pure modules; `state/recommender.ts` orchestrates fetching and owns the
  autoplay buffer; the playback controller only consumes from it.

### Playback presentation

The embedded player must be (and is) always visible while it plays — MELO never
hides, shrinks, crops or moves it off-screen. Instead of competing with the
app's UI, the video **is** the Now Playing artwork while the Now Playing view is
open, and docks into a compact mini-player attached to the player bar when the
view is closed (the YouTube Music pattern). `stop()` destroys the player
entirely, so no hidden idle player ever exists. The stage is a single,
persistent DOM node that is only ever repositioned — never re-created — so
navigating the app never reloads the video.

---

## Features

**Playback** — play / pause / resume / stop / next / previous / seek / volume /
mute / speed (0.5×–2×), shuffle, repeat off-one-all, natural EOF auto-advance.
Manual **Stop never advances** the queue. EOF and manual Next each advance
exactly once. Previous restarts the track if more than 3 s have elapsed, and
during autoplay it walks back through what actually played this session.

**Queue — Up Next + Autoplay, like Spotify / YouTube Music.** The queue panel
has three sections: **Now playing**, **Up next** (the user's explicit queue) and
**Autoplay · for you** (a rolling recommendation buffer). Explicitly queued
tracks *always* play before autoplay, no matter when they were added. The
autoplay buffer holds a rolling window (refills below 18, capped at 30): as
tracks are consumed it is topped up incrementally — never emptied and
regenerated, never bulk-generated — so listening continues indefinitely without
starting a new radio session.

**Recommendations that learn from real listening.** Every listen is recorded
with what actually happened: how long it played, whether it completed, whether
it was skipped. From that history plus likes, a deterministic profile is built
(artist affinities with recency decay, style/genre tags, recent streak, skips).
Recommendations combine:

```
score =  current-track relevance      (artist / title / album)
      + recent-history relevance     (the current listening streak)
      + artist affinity              (what you keep coming back to)
      + style/genre affinity
      + liked-artist bonus
      + provider rank                (the search engine's own relevance)
      - ever-played penalty
      - repeated-artist penalty      (what's already in the buffer)
      - current-artist flood penalty
```

Candidates come from bounded searches anchored on several signals at once — the
current track, top affinities, liked artists, recent streak — rotating between
fetches. Diversity is structural, never random: no more than two consecutive
tracks from one artist, a per-artist share cap on the buffer, no repeat uploads
of the same song (normalized-title matching), recently played and recently
skipped tracks excluded outright. Same inputs always produce the same queue.

**Search** — YouTube Music InnerTube search with filters for songs / videos /
albums / artists, single click to play (only the chosen track is ever enqueued),
independent secondary buttons (like, add to queue, play next, add to playlist,
more), search history.

**Library** — Liked Songs, Songs, Albums, Artists, Playlists, Recently Played,
derived from real metadata only. **Lyrics** — LRCLIB, synced and plain.
**Desktop integration** — media keys, tray icon, notifications, session restore.

Keyboard: `Ctrl/⌘+K` search · `Space` play/pause · `←/→` seek 5 s ·
`Ctrl+←/→` prev/next · `↑/↓` volume · `M` mute · `S` shuffle · `R` repeat ·
`L` like · `Q` queue · `Y` lyrics · `Esc` close panel.

---

## Requirements

- Windows 10 1809+ or Windows 11 with the **WebView2 runtime**.
- Internet access for search, playback and lyrics. The library, playlists and
  settings are entirely local.

## Build

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@v2.10.1
wails build            # -> build/bin/MELO.exe
wails dev              # hot-reloading dev build

go test ./...          # Go tests
go vet ./...
```

Frontend-only work:

```bash
cd frontend
npm install
npm run dev      # Vite on :5173 — browser dev against the fixture backend
npm test         # vitest
npm run build    # type-check + production bundle into frontend/dist
```

`frontend/.env.development` sets `VITE_MELO_MOCK=1`, which makes `npm run dev`
run against an in-browser fixture backend (a catalogue of real YouTube video
ids + localStorage persistence) so the UI can be worked on without the Go
shell. In that mode the app prefers the real YouTube IFrame player if the
browser can reach it, and otherwise falls back to a silent offline transport
(`?player=clock` forces it) so the full queue/autoplay flow stays testable
offline. The fixture never applies when Wails bindings exist.

## Data

State lives in `%AppData%\MELO\melo-state.json` (override with `MELO_DATA_DIR`).
Writes are atomic (temp file + rename) and debounced by 250 ms. A corrupt file
is moved aside and MELO starts clean.

**Listening history** entries record the track, when it played, how many
seconds were actually heard, the track's duration, whether the listen completed
and whether it was skipped — the exact signal the recommendation profile learns
from. History is capped at 500 entries; a repeated start of the same track
within 30 s merges into one entry.

## Testing

- `go test ./...` — store, provider (against served fixtures), lyrics.
- `npm test` — adapters (including the YouTube adapter against a faithful
  `YT.Player` stand-in), controller/queue semantics, recommender & profile
  scoring, application smoke tests through the real component tree.
- `frontend/scripts/e2e.mjs` — an end-to-end run against the dev server
  (`node scripts/e2e.mjs`) driving the real UI in headless Chromium: listens
  across artists, completes and skips tracks, likes songs, and verifies the
  queue panel reflects accumulated behaviour. Screenshots land in
  `frontend/e2e/shots/`.

## Known limitations

- **Not validated on real Windows hardware in this environment.** The sandbox
  is Linux-only and offline from YouTube, so the Windows binary cross-compiles
  and all automated tests pass, but the IFrame playback, tray, media keys and
  notifications have not been observed on a real Windows machine. The Win32
  syscall layer is the first thing to check there.
- The YouTube player is the *embedded* player: a small number of videos forbid
  embedding. MELO surfaces a clear message and moves on rather than failing.
- No local-file library, no gapless/crossfade, no equalizer, no offline caching,
  no account or cloud sync.
- Album and artist pages cover what is in your library; MELO does not browse a
  catalogue it hasn't got metadata for.
