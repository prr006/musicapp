# MELO Manual Test Checklist

Human verification for what unit tests can't prove: real audio, real
YouTube, real libmpv. Primary target: **Windows 10/11**.
Prereqs: `npm install` done, `npm run tauri dev` running (or an installed
build). **No mpv/yt-dlp install needed** — the first run downloads the
managed runtime (README → "Playback runtime"); delete `.melo-runtime/` at
the repo root to re-test the first-run flow. The download must NOT cause
`tauri dev` to rebuild/restart the app.

## 0. Cold start & runtime

- ☐ App opens ≤ 5 s, no console window flashes.
- ☐ First run without runtime: toast reports installation progress
      (libmpv + yt-dlp, pinned + SHA-256 verified), then the engine comes
      up — no PATH probing, no dev-server restart loop.
- ☐ Settings → Diagnostics shows the libmpv path, engine running,
      yt-dlp path, runtime dir, and a **Repair runtime** button.
- ☐ Repair runtime re-downloads and the engine restarts on its own.
- ☐ Nothing autoplays, even after a previous session was playing.

## 1. Gate 1 — real playback chain

- ☐ Search a real song → results appear (title/artist/duration/artwork).
- ☐ Play it: real audio starts; progress bar moves; position updates.
- ☐ Pause → audio stops, position freezes. Resume → continues.
- ☐ Seek (bar + ±5 s keys) → audio jumps, lyrics (if open) jump.
- ☐ Volume slider + mute work.
- ☐ Add B and C to the queue.
- ☐ Let A genuinely reach EOF → B starts AUTOMATICALLY (no timer).
- ☐ B EOF → C starts. C EOF → idle (autoplay off by default).
- ☐ Stop mid-track → queue does NOT advance; current track stays.
- ☐ Next → advances exactly once. Previous → previous track (or restart).
- ☐ Rapid switching (Next Next Next fast) → queue never skips desyncs.
- ☐ Repeat One: EOF replays the same track. Repeat All: wraps.
- ☐ Shuffle: upcoming order shuffles, current track keeps playing.

## 2. Gate 2 — real position + lyrics

- ☐ Lyrics on several real songs (synced lines highlight in time).
- ☐ Pause freezes the lyric line; resume continues from the right line.
- ☐ Seek moves the active line instantly.
- ☐ Change track with lyrics open → lyrics reset immediately.
- ☐ Playback speed 1.5× → lyrics stay in sync (engine-driven).
- ☐ A song without lyrics shows the honest empty state; malformed lyrics
      degrade to plain text.

## 3. Gate 3 — library / playlists / history / persistence

- ☐ Like a track → appears in Liked Songs.
- ☐ Create/rename/delete a playlist; add/remove/reorder tracks.
- ☐ Save the current queue as a playlist.
- ☐ History records played tracks; remove one entry; clear all.
- ☐ Close and reopen the app: queue + current track + position restore
      WITHOUT autoplaying; pressing play resumes at the saved position.

## 4. Desktop polish

- ☐ Media keys (play/pause/next/prev) work.
- ☐ App closes cleanly (no orphaned audio, no crash on exit).

## 5. Failure honesty

- ☐ Offline search fails with a clear message; loaded audio keeps playing.
- ☐ Rename `.melo-runtime/bin/libmpv-2.dll` away and restart: clear
      engine-missing error with repair instructions (never a silent PATH
      fallback); Repair runtime recovers.
