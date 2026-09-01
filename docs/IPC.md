# MELO IPC surface

Commands (webview → Rust) and events (Rust → webview). The native layer is a
thin shell around libmpv; the queue and app logic live in the frontend.

## Commands

### Player (libmpv)

| Command            | Args                                  | Result | Notes |
|--------------------|---------------------------------------|--------|-------|
| `player_get_state` | —                                     | `EngineState` | last observed engine state |
| `player_load`      | `url`, `startPaused?`, `startAt?`     | epoch  | replaces current file; epoch drops stale EOFs |
| `player_play`      | —                                     | —      | |
| `player_pause`     | —                                     | —      | |
| `player_toggle_play` | —                                  | —      | |
| `player_stop`      | —                                     | —      | manual stop; engine reports `stop`, queue must NOT advance |
| `player_seek`      | `position` (secs)                     | —      | absolute |
| `player_set_volume`| `volume` 0–100                        | —      | |
| `player_set_mute`  | `muted`                               | —      | |
| `player_set_speed` | `speed` 0.25–4                        | —      | |

### Resolve / search

| Command          | Args                    | Result | Notes |
|------------------|-------------------------|--------|-------|
| `resolve_track`  | `sourceId`, `quality?`  | `ResolvedMedia` | direct media URL via managed yt-dlp |
| `search`         | `query`, `limit?`       | `SearchResults` | flat YouTube results (songs only, honest) |
| `search_history_clear` / `search_history_remove` | — / `query` | — | |

### Library / history / session / settings / runtime

`favorites_toggle`, `record_play` (listening history), `playlist_create`,
`playlist_rename`, `playlist_set_description`, `playlist_delete`,
`playlist_duplicate`, `playlist_add_tracks`, `playlist_remove_track`,
`playlist_reorder_track`, `playlist_tracks`, `history_clear`,
`history_remove`, `get_lyrics` (LRCLIB), `get_library`, `get_session`,
`set_session`, `get_settings`, `set_settings`, `get_diagnostics`,
`repair_runtime`.

Queue commands are intentionally ABSENT: the queue is an application concept
living in the frontend (`src/player/queue.ts`).

## Events

| Event                | Payload | Meaning |
|----------------------|---------|---------|
| `player://state`     | `{status, positionSecs, durationSecs, paused, buffering, seeking, speed, volume, muted, epoch, mpvVersion}` | authoritative engine snapshot; also re-anchors the interpolated clock |
| `player://position`  | `{positionSecs, durationSecs, epoch}` | position sample |
| `player://end`       | `{reason: eof\|stop\|quit\|error\|redirect, error, epoch}` | file ended; only `eof` may auto-advance the queue |
| `runtime://status`   | `{phase: installing\|ready\|error, message}` | runtime install progress / repair result |
| `library://updated`  | `LibraryData` | likes/playlists/history/search changed |
