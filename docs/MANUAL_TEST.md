# MELO Manual Test Checklist

Human verification for the things unit tests can't prove: real audio, real
YouTube, real process crashes. Primary target: **Windows 10/11**.
Prereqs: `npm install` done, `npm run tauri dev` running (or an installed
build). **No mpv/yt-dlp install needed** — the first run downloads the managed
runtime (see README → "Playback runtime"); delete
`src-tauri/runtime/bin/{mpv.exe,yt-dlp.exe}` to re-test the first-run flow.

Legend: ☐ = to run · note anything unexpected with steps + screenshot.

## 0. Cold start

- ☐ App opens in ≤ 5 s, no console window flashes (Windows).
- ☐ Nothing plays automatically, even after a previous session was playing.
- ☐ Mini player shows "Nothing playing"; Home shows previously collected
      content (or the honest empty state on a fresh profile).
- ☐ First run without a runtime: a toast reports runtime installation
      progress (mpv + yt-dlp download), then the engine comes up — no PATH
      probing, no console window from the downloader/extractor.
- ☐ Settings → Diagnostics shows the managed mpv + yt-dlp paths under
      `runtime/bin` and a **Repair runtime** button.
- ☐ Settings → Diagnostics → Repair runtime re-downloads and the engine
      restarts on its own (toast on completion).

## 1. Search & play (YouTube)

- ☐ `Ctrl+K` focuses search from anywhere; typing navigates to Search.
- ☐ Results appear with title / artist / duration; artwork tiles where
      YouTube provides thumbnails.
- ☐ Clicking a result: status goes `loading` (spinner, NOT "playing") until
      audio starts, then `playing` with a moving progress bar.
- ☐ Double-click another result: switch is clean, no audio overlap.
- ☐ Query containing a bogus term (or with networking off): error state with
      Retry; retry works when the network returns.
- ☐ Search history chips appear on the Search idle screen; clicking one
      re-runs the search; ✕ removes one chip; Clear empties the list.

## 2. Transport & clock

- ☐ Space toggles play/pause; the bar freezes exactly where it was and
      resumes without a jump.
- ☐ ←/→ seek ±5 s; clicking the progress bar seeks proportionally.
- ☐ Dragging volume works; M mutes (icon changes); ↑/↓ nudges volume.
- ☐ Now Playing speed button cycles 0.75×–2×; audio pitch follows; lyrics
      stay aligned at 1.5× (they follow the clock, not wall time).
- ☐ Pause >5 s: position does NOT drift forward (clock frozen, not guessed).

## 3. Queue

- ☐ "…" menu → Add to queue / Play next appear in the queue drawer in the
      right order (Q opens/closes the drawer).
- ☐ EOF auto-advances to the next track without a gap or a stuck spinner;
      queue history gains the finished track.
- ☐ Drag an upcoming row to a new position → order persists.
- ☐ ▲▼ buttons move rows; ✕ removes; removing the CURRENT track advances to
      the next cleanly.
- ☐ Repeat: off → queue ends in `idle` (no error); all → wraps to first;
      one → same track replays. R cycles modes.
- ☐ Shuffle mid-play: current track keeps playing; S toggles.
- ☐ Previous: within 3 s → restarts track; after 3 s → jumps to previous
      track from history.
- ☐ "Save as playlist" in the drawer creates a playlist with current +
      upcoming, visible immediately under Playlists.

## 4. Library

- ☐ Heart a track from a list and from Now Playing → appears in Liked Songs;
      unheart removes it.
- ☐ Playlists: create (inline form), rename, duplicate, delete (confirm),
      add tracks via "…" → Add to playlist (incl. creating a new one inline),
      remove a track, reorder with ▲▼.
- ☐ A playlist built purely from search results (never played, never liked)
      plays correctly — the metadata index remembers them.
- ☐ Recently Played shows entries with "listened Xm (Y%)" that match what
      you actually heard; removing an entry and Clear history both work.
- ☐ Albums/Artists tabs: groups appear only for tracks that carry real
      metadata; with none, the honest empty state explains why.

## 5. Now Playing & lyrics

- ☐ L (or clicking the mini player artwork) opens full screen; Esc closes.
- ☐ Lyrics load (LRCLIB) and the highlighted line matches the audio through
      seeks, pauses and track changes.
- ☐ Clicking a lyric line seeks to it. ±0.5 s buttons shift alignment live.
- ☐ Instrumental track → "Instrumental — no lyrics by design."; unknown
      track → honest "No lyrics found" (never a fake or frozen line).
- ☐ Favorite heart reflects and changes the Liked list.

## 6. Errors & recovery (the important ones)

- ☐ Kill mpv from Task Manager while playing: playback pauses, a restart
      toast appears, and MELO resumes **paused** at the same position (or
      playing only if it was sounding when it died — verify no unexpected
      blast).
- ☐ Kill mpv 4+ times: engine reports dead with a clear message; UI stays
      responsive; playing again after restarting the app works.
- ☐ Play a geoblocked/removed video: error surfaces in the player + a
      toast; queue can advance to the next track manually; no infinite
      spinner (watchdog fires ≤ 30 s).
- ☐ Disconnect the network mid-search / mid-lyrics: honest failures, Retry
      works after reconnecting; a playing local file is unaffected.

## 7. Persistence across restarts

- ☐ Play a remote track, seek to ~1:00, pause, close the app (window X).
- ☐ Reopen: same queue, same track, position ≈ 1:00, **paused**.
- ☐ Volume, repeat, shuffle, theme/accent/compact all survive.
- ☐ Favorites/playlists/history identical after restart (check one of each).

## 8. UI hygiene

- ☐ Dark ↔ light ↔ system theme switches live; accents apply; compact mode
      shrinks rows.
- ☐ Offline state (devtools → Network offline): the status dot flips and a
      toast appears; back online reverses it.
- ☐ Resize to minimum (960×600): layout reflows, no clipped controls.
- ☐ Shortcuts never fire while typing in the search box or playlist name
      fields (except Ctrl+K).
- ☐ No context menu closes when clicking inside it (submenu add-to-playlist).

## 9. Security spot-checks

- ☐ Devtools console: no CSP violations logged.
- ☐ `src-tauri/capabilities/default.json` contains only `core:default`.

## Reporting

File results as: checklist item · pass/fail · build hash · OS · notes.
Any failure in section 6 (recovery) or 7 (persistence) is release-blocking.
