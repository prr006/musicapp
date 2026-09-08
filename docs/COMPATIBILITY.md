# MELO platform compatibility

Legend: **Yes** = working end to end; **API** = hosted backend implemented but no
dedicated UI entry point yet; **Partial** = existing behavior works but the fuller
product requirement still has follow-up work.

| Capability | Wails desktop | Hosted web | Notes |
| --- | :---: | :---: | --- |
| Play / pause / next / previous | Yes | Yes | One HTMLAudioElement engine and controller |
| Seek / volume / mute / speed | Yes | Yes | Browser media pipeline is authoritative |
| Repeat off/all/one / shuffle | Yes | Yes | Shared queue controller |
| Sleep timer | Yes | Yes | Now Playing 15/30/45/60 minute control |
| Media Session / OS metadata | desktop keys | Yes | play, pause, next, previous, seek and position |
| Automatic autoplay | Yes | Yes | Discovery queue remains separate from user queue |
| Next-track resolution prefetch | resolver cache | Yes | Web adapter coalesces and expires signed sources |
| Expired URL recovery | Yes | Yes | Streamer invalidates and resolves once on 403/410 |
| Explicit user queue | Yes | Yes | Search single-click never enqueues every result |
| Discovery queue | Yes | Yes | canonical title/id dedupe and artist cap |
| Session persistence | local | Yes | isolated anonymous or authenticated account |
| Save queue as playlist | Yes | Yes | shared queue panel/library operations |
| Song radio | autoplay | Yes | `/api/v1/radio/song/:id` drives hosted autoplay |
| Artist radio | search-derived | API | `/api/v1/radio/artist/:id` |
| Album radio | search-derived | API | `/api/v1/radio/album/:id` |
| Playlist radio | search-derived | API | ownership checked server-side |
| Liked songs radio | search-derived | API | account-scoped seed |
| Library radio | search-derived | API | account-scoped seed |
| Search songs/videos/albums/artists | Yes | Yes | InnerTube plus yt-dlp fallback and non-null arrays |
| Incremental suggestions | Yes | Yes | 200 ms stale-safe client debounce + API cache |
| Recommendations | local sections | Yes | account history/likes seed cached ranked sections |
| Recently played / likes | Yes | Yes | persistent per account |
| Dislikes / don't recommend | No | No | domain/storage follow-up; not present in baseline |
| Completion and skip weighting | No | Partial | PostgreSQL schema has fields; client event API is follow-up |
| Artist diversity | Yes | Yes | canonical discovery filtering and radio artist cap |
| Playlist create/rename/delete | Yes | Yes | owner isolation enforced by repository scope |
| Playlist add/remove/reorder/duplicate | Yes | Yes | validated API payloads and indexes |
| Albums / artists / most played | derived | derived | derived from real library/history metadata |
| Synced lyrics | Yes | Yes | LRCLIB song-centric matching |
| Click lyric to seek | Yes | Yes | player clock, no duplicate lyric timer |
| Canonical/version matching | Yes | Yes | existing conservative LRCLIB ladder |
| Anonymous use | local profile | Yes | signed, isolated HTTP-only anonymous session |
| Account register/login/logout | n/a | Yes | bcrypt passwords and signed HTTP-only cookie |
| PostgreSQL normalized model | n/a | schema | migration and repository boundary ready; adapter remains |
| Responsive mobile shell | n/a | Yes | bottom navigation/player, touch queue and lyrics layout |
| PWA shell install/cache | n/a | Yes | music/API intentionally network-only |

## Browser targets

The production bundle targets ES2022 and current Chrome, Firefox, and Edge on
desktop and mobile. Media Session is feature-detected; unsupported actions are
ignored without affecting playback. iOS browser background/autoplay policy still
requires an initial user gesture, as expected for every HTML audio application.
