# MELO HTTP API v1

Base path: `/api/v1`. JSON mutations require `Content-Type: application/json`.
Success responses are stable domain objects; errors are:

```json
{ "error": { "code": "invalid_track", "message": "track fields are invalid or too long" } }
```

A signed HTTP-only `melo_session` cookie isolates anonymous and authenticated
libraries. CORS echoes only configured exact origins and permits credentials.

## Catalogue and playback

| Method | Path | Description |
| --- | --- | --- |
| GET | `/search?q=&filter=` | grouped songs/videos/albums/artists |
| GET | `/suggest?q=` | bounded typeahead result |
| POST | `/resolve` | Track -> short-lived signed `PlayableSource` |
| GET | `/resolve/:sourceId` | resolve by validated provider ID |
| GET/HEAD | `/stream/:sourceId?expires=&signature=` | bounded Range-capable media stream |
| POST | `/lyrics` | `LyricsQuery` -> synced/plain lyrics |
| GET | `/radio/:kind/:id` | song/artist/album/playlist/liked/library radio |
| GET | `/recommendations` | taste-seeded recommendation sections |
| GET | `/home` | alias of recommendations |

The resolve response never includes the raw provider URL or provider headers.
Tickets authorize only one validated source ID and never outlive the provider source (with a two-hour upper bound). Identical
resolver/search/radio/lyrics requests are coalesced.

## Account and library

| Method | Path |
| --- | --- |
| GET | `/me` |
| POST | `/auth/register`, `/auth/login`, `/auth/logout` |
| GET | `/state`, `/library`, `/playlists` |
| PUT | `/settings`, `/session` |
| DELETE | `/session`, `/history`, `/search-history` |
| POST / DELETE | `/library/likes` |
| POST | `/history`, `/search-history`, `/playlists` |
| PATCH / DELETE | `/playlists/:id` |
| POST / PATCH / DELETE | `/playlists/:id/tracks` |
| POST | `/playlists/:id/duplicate` |

Playlist IDs are resolved only inside the request identity's repository scope;
another account receives `404` rather than object existence information.

## Operations

- `GET /health`: process liveness.
- `GET /ready`: storage readiness.
- `GET /api/v1/diagnostics`: sanitized runtime/provider status with no internal
  filesystem paths.
- Search, resolve, stream, and global API requests use independent token buckets.
- Provider failures open a short circuit backoff after repeated failures.
