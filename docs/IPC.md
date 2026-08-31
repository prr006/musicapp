# MELO IPC Contract

The complete Tauri command/event surface. TypeScript mirrors live in
`src/app/ipc/contract.ts`; Rust implementations in `src-tauri/src/commands.rs`.

## Conventions

* Commands are `snake_case`; JS call sites use the same names (arguments are
  camelCase keys, converted automatically by Tauri).
* Commands **send intent and return immediately** (`Promise<void>` for most).
  State arrives via events. `get_*` commands exist for boot/re-sync.
* Errors are human-readable strings; providers map to friendly copy via
  `ProviderError::user_message()`.
* Inputs are validated in Rust (titles non-empty, ids present, numbers
  clamped). The webview holds no capabilities beyond `core:default`.

## Commands

### State reads

| Command              | Returns                  | Notes                          |
|----------------------|--------------------------|--------------------------------|
| `get_playback_state` | `PlaybackSnapshot`       | boot / reconnect               |
| `get_queue`          | `QueueView`              | boot / reconnect               |
| `get_library`        | `LibraryData`            | boot + after `library://updated` |
| `get_settings`       | `Settings`               |                                |
| `get_diagnostics`    | `Diagnostics`            | mpv program, yt-dlp presence, quality label |
| `get_lyrics`         | `Lyrics \| null`         | `{ track }` — LRCLIB lookup     |
| `search`             | `SearchResults`          | `{ query, limit? }` — yt-dlp   |

### Transport

| Command              | Args                          |
|----------------------|-------------------------------|
| `player_toggle_play` | —                             |
| `player_play`        | —                             |
| `player_pause`       | —                             |
| `player_stop`        | —                             |
| `player_next`        | — (skips even in repeat-one)  |
| `player_previous`    | — (>3 s in → restart track)   |
| `player_seek_to`     | `{ position: number }` (clamped to duration) |
| `player_seek_by`     | `{ delta: number }`           |
| `player_set_volume`  | `{ volume: 0..100 }`          |
| `player_toggle_mute` | —                             |
| `player_set_speed`   | `{ speed: 0.25..4 }`          |

### Queue

| Command             | Args                            |
|---------------------|---------------------------------|
| `queue_play_now`    | `{ track }`                     |
| `queue_add`         | `{ tracks: Track[] }`           |
| `queue_play_next`   | `{ tracks: Track[] }`           |
| `queue_remove`      | `{ itemId }`                    |
| `queue_jump_to`     | `{ itemId }` (upcoming only)    |
| `queue_move`        | `{ itemId, up }`                |
| `queue_reorder`     | `{ from, to }` (drag-drop)      |
| `queue_clear_upcoming` | —                           |
| `queue_clear_all`   | —                               |
| `queue_set_shuffle` | `{ enabled }` (deterministic re-seed) |
| `queue_set_repeat`  | `{ mode: "off"\|"all"\|"one" }` |
| `queue_start`       | `{ tracks, shuffle }` (replaces queue) |
| `queue_save_as_playlist` | `{ title }` → `Playlist` (current + upcoming) |

### Library — favorites, playlists, history, search history

| Command                    | Args / Returns                        |
|----------------------------|---------------------------------------|
| `favorites_toggle`         | `{ track }` → `boolean` (new state)   |
| `playlist_create`          | `{ title, description? }` → `Playlist` |
| `playlist_rename`          | `{ playlistId, title }`               |
| `playlist_set_description` | `{ playlistId, description }`         |
| `playlist_delete`          | `{ playlistId }`                      |
| `playlist_duplicate`       | `{ playlistId, title }` → `Playlist`  |
| `playlist_add_tracks`      | `{ playlistId, tracks }`              |
| `playlist_remove_track`    | `{ playlistId, trackId }`             |
| `playlist_reorder_track`   | `{ playlistId, from, to }`            |
| `playlist_tracks`          | `{ playlistId }` → `Track[]`          |
| `history_clear`            | —                                     |
| `history_remove`           | `{ entryId }`                         |
| `search_history_clear`     | —                                     |
| `search_history_remove`    | `{ query }`                           |

### Settings

| Command        | Args                             |
|----------------|----------------------------------|
| `get_settings` | — → `Settings`                   |
| `set_settings` | `{ settings }` (full document)   |

## Events

| Event                  | Payload            | Cadence                        |
|------------------------|--------------------|--------------------------------|
| `playback://state`     | `PlaybackSnapshot` | on every state change          |
| `playback://position`  | `PositionUpdate`   | ~4 Hz while sounding           |
| `queue://view`         | `QueueView`        | on every queue mutation        |
| `library://updated`    | `LibraryData`      | on every library mutation      |
| `engine://status`      | `{ health, message }` | starting/running/restarting/dead |

The frontend derives everything else (active lyric line, progress bar
smoothness between samples, "busy" state) from these payloads — it never
owns playback truth.
