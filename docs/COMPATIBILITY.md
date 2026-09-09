# MELO platform compatibility

This table records implementation coverage, not public production verification.
**Implemented** means the hosted code path and automated coverage exist; **API**
means the hosted backend exists without a dedicated UI entry point; **Partial**
means follow-up work remains. Desktop **Yes** reflects the established desktop
path, while the current CI guards its build and shared tests.

> **Production status (2026-09-09):** the public Vercel frontend is
> <https://musicapp-rp-1bc2.vercel.app> and the Railway API is
> <https://musicapp-production-9257.up.railway.app>. Real search, signed hosted
> playback, audible play/pause/seek, several transitions, Song Radio, synced
> lyrics, and lyric seek have been manually verified. The repaired five-to-eight
> item radio buffer passed a five-transition production run without an
> empty/duplicate buffer and retained explicit priority. A later production test
> of the shared-domain parity candidate exposed premature visual `CURRENT`
> advancement before audible playback, so that deployment is not accepted as
> parity-complete. The transactional repair keeps a candidate upcoming until
> `HTMLAudioElement.play()` succeeds, passes 136 frontend tests plus full CI, and
> is deployed. Its first production retest was blocked before transition one by
> provider `media_unavailable` responses for popular music IDs (a control ID
> resolved), so no queue parity pass is claimed. A bounded supported-client
> resolver fallback and a 60-second browser request deadline are deployed without
> tokens or credentials, but direct post-deploy checks still report the same
> provider rejection for those music IDs. The eight-audible-transition retest is
> therefore blocked, not passed. Account relogin/isolation,
> restart persistence, multi-browser responsive behavior, Media Session, PWA
> install, and expired-ticket recovery remain unverified.

| Capability | Wails desktop | Hosted web | Notes |
| --- | :---: | :---: | --- |
| Play / pause / next / previous | Yes | Implemented | One HTMLAudioElement engine; queue/current commit only after confirmed play |
| Seek / volume / mute / speed | Yes | Implemented | Browser media pipeline is authoritative |
| Repeat off/all/one / shuffle | Yes | Implemented | Shared queue controller |
| Sleep timer | Yes | Implemented | Now Playing 15/30/45/60 minute control |
| Media Session / OS metadata | desktop keys | Implemented | play, pause, next, previous, seek and position |
| Automatic autoplay | Yes | Implemented | Shared 5–8 item discovery buffer; proactive incremental refill and failure-safe retry |
| Next-track resolution prefetch | resolver cache | Implemented | Canonical engine orders candidates; web coalesces/caches three upcoming signed sources |
| Expired URL recovery | Yes | Implemented | Streamer invalidates and resolves once on 403/410 |
| Explicit user queue | Yes | Implemented | Search single-click never enqueues every result |
| Discovery queue | Yes | Implemented | Shared domain reconciles current/explicit/discovery/history/radio-session IDs and canonical titles |
| Session persistence | local | Implemented | isolated anonymous or authenticated account |
| Save queue as playlist | Yes | Implemented | shared queue panel/library operations |
| Song radio | autoplay | Implemented | persistent client session refills from the seed and advancing tracks |
| Artist radio | search-derived | API | `/api/v1/radio/artist/:id` |
| Album radio | search-derived | API | `/api/v1/radio/album/:id` |
| Playlist radio | search-derived | API | ownership checked server-side |
| Liked songs radio | search-derived | API | account-scoped seed |
| Library radio | search-derived | API | account-scoped seed |
| Search songs/videos/albums/artists | Yes | Implemented | InnerTube plus yt-dlp fallback and non-null arrays |
| Incremental suggestions | Yes | Implemented | 200 ms stale-safe client debounce + API cache |
| Recommendations | local sections | Implemented | account history/likes seed cached ranked sections |
| Recently played / likes | Yes | Implemented | persistent per account |
| Dislikes / don't recommend | No | No | domain/storage follow-up; not present in baseline |
| Completion and skip weighting | No | Partial | PostgreSQL schema has fields; client event API is follow-up |
| Artist diversity | Yes | Implemented | canonical discovery filtering and radio artist cap |
| Playlist create/rename/delete | Yes | Implemented | owner isolation enforced by repository scope |
| Playlist add/remove/reorder/duplicate | Yes | Implemented | validated API payloads and indexes |
| Albums / artists / most played | derived | derived | derived from real library/history metadata |
| Synced lyrics | Yes | Implemented | LRCLIB song-centric matching |
| Click lyric to seek | Yes | Implemented | player clock, no duplicate lyric timer |
| Canonical/version matching | Yes | Implemented | existing conservative LRCLIB ladder |
| Anonymous use | local profile | Implemented | signed, isolated HTTP-only anonymous session |
| Account register/login/logout | n/a | Implemented | bcrypt passwords and signed HTTP-only cookie |
| PostgreSQL normalized model | n/a | schema | migration and repository boundary ready; adapter remains |
| Responsive mobile shell | n/a | Implemented | bottom navigation/player, touch queue and lyrics layout |
| PWA shell install/cache | n/a | Implemented | music/API intentionally network-only |

## Browser targets

The production bundle targets ES2022 and current Chrome, Firefox, and Edge on
desktop and mobile. Media Session is feature-detected; unsupported actions are
ignored without affecting playback. iOS browser background/autoplay policy still
requires an initial user gesture, as expected for every HTML audio application.
