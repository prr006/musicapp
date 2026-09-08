# MELO HTTP API v1

Base path: `/api/v1`. JSON mutations require `Content-Type: application/json`.
Success responses are stable domain objects; errors are:

```json
{ "error": { "code": "invalid_track", "message": "track fields are invalid or too long" } }
```

A signed HTTP-only `melo_session` cookie isolates anonymous and authenticated
libraries. CORS echoes only configured exact origins and permits credentials.
Every response includes an `X-Request-ID`; a valid caller-supplied ID is preserved
and exposed to approved browser origins for support correlation.

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

Radio responses are bounded, cached candidate batches rather than continuation
tokens. The shared playback controller owns the persistent radio session: it keeps
five to eight ready discovery tracks, preserves that buffer across transitions,
requests the original radio context and then the advancing current track as
needed, and supplements short batches with bounded search candidates. It never
replaces either queue with a raw search response or an empty failed response.

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
- `POST /api/v1/events/playback-error`: accepts only a validated track ID,
  machine-readable code, and recoverability flag. It lets browser media failures
  be correlated without accepting or logging free-form messages, source URLs,
  cookies, or capabilities.
- Search, resolve, stream, and global API requests use independent token buckets.
- Provider failures open a short circuit backoff after repeated failures.
- Structured logs identify the `search`, `suggest`, `resolve`, `lyrics`, `radio`,
  `recommendations`, `signed_source`, `stream_resolve`, `stream_reresolve`,
  `upstream_stream`, `stream_retry`, and `browser_playback` stages. Provider URLs,
  provider headers, cookie values, and playback signatures are never logged.
- Provider-facing error details remain in server logs; browser responses use
  stable messages suitable for retry UI rather than exposing resolver output.
