# MELO Web simplification proposal

Date: 2026-09-09

## Executive decision

There is no fundamentally simpler hosted extractor/proxy that will make arbitrary
YouTube audio URLs reliable. Moving yt-dlp from the current Go server into a
smaller service, function, sidecar, or different cloud only moves the same
provider-facing failure boundary. The production evidence already proves that:
the same binary and arguments changed from zero formats to playable formats and
back as Railway processes changed.

The simplest practical web architecture is therefore:

> **Do not extract or proxy YouTube media on the hosted web path. Use the official,
> visible YouTube IFrame Player in the browser. Keep the backend only for search,
> lyrics, accounts, libraries, playlists, radio metadata, and session state.**

This removes yt-dlp, format selection, expiring media URLs, signed stream tickets,
Range forwarding, stream bandwidth, resolver prefetch, and resolver retries from
the web architecture. Desktop can retain its existing local yt-dlp and loopback
proxy because that implementation is small, already appropriate for a local
application, and runs from the user's network.

This recommendation has one non-negotiable product tradeoff: YouTube's player must
be visibly presented as an audiovisual player. It cannot be hidden and used as an
audio-only/background source. If MELO must remain a pure custom audio player with
no visible provider player, the reliable solution is not another proxy; it is a
licensed playback provider or audio that MELO is entitled to serve from its own
media origin.

## Why desktop works and hosted web does not

### Desktop

```text
React UI in WebView2
       │
       ▼
local Go/Wails process ── local yt-dlp ── YouTube from the user's network
       │
       ▼
127.0.0.1 capability/Range proxy ── HTMLAudioElement
```

The desktop process resolves and transports media locally. YouTube sees the end
user's outbound network context. The signed media URL and required headers never
need to cross an application trust boundary. The loopback proxy only serves one
user and does not turn a cloud server into a shared media relay.

### Current web path

```text
React on Vercel
       │ resolve
       ▼
Go on Railway ── yt-dlp ── YouTube from shared/datacenter egress
       │
       ├── signed MELO ticket
       ▼
Railway Range streamer ── all audio bytes ── browser HTMLAudioElement
```

The failure occurs before MELO has a media source: yt-dlp exits successfully with
correct identity metadata and `formats: []`. A proxy cannot proxy a URL that the
provider did not supply. Retries cannot fix a provider epoch in which all clients
return zero formats; the measured bad epoch produced 90 zero-format subprocess
results out of 90.

A browser also cannot simply take over the desktop strategy. It cannot launch
yt-dlp, and direct CDN media is subject to expiring capabilities, request headers,
CORS, browser media policy, and provider enforcement. A hosted extraction
microservice recreates the existing Railway boundary rather than simplifying it.

The yt-dlp project now documents evolving PO-token requirements for YouTube player
and media requests. That is useful context, but adding token-generation plugins,
cookies, or identity workarounds would make the hosted design more complicated and
is not the clean architecture proposed here.

## Recommended target architecture

```text
                         MEDIA PLANE
Browser ─────────────────────────────────────► YouTube IFrame Player
  │                                            (official, visible, direct)
  │
  │                    CONTROL/DATA PLANE
  └── same-origin JSON ─► MELO web service
                          ├── search/metadata
                          ├── related/radio metadata
                          ├── LRCLIB lyrics
                          ├── account/session
                          └── library/playlists/history
```

### Browser

- One React application.
- One visible `YT.Player` iframe, reused for every track.
- One MELO queue controller; do not hand queue authority to the iframe playlist.
- A small `PlaybackAdapter` interface hides whether transport is desktop audio or
  web iframe playback.
- No web call to `getPlayable`, `/resolve`, or `/stream`.
- No web media URL, MIME type, bitrate, expiry, resolver cache, or source prefetch.
- Position comes from `getCurrentTime()` polling while playing; duration from
  `getDuration()`; loaded progress from `getVideoLoadedFraction()`.
- Play, pause, seek, volume, mute, and supported playback-rate operations map
  directly to documented IFrame API functions.
- Queue state commits only after `YT.PlayerState.PLAYING`, just as the existing
  audio path commits only after actual playback starts.
- `ENDED` advances once. IFrame errors reject only the candidate and let the queue
  controller choose the next item.

### Backend

Use one small same-origin service. The existing Go service is already suitable;
rewriting it in Node would change language without reducing the number of product
concerns.

Keep only:

```text
GET    /api/search
GET    /api/related/:videoId       (or the existing radio metadata endpoint)
POST   /api/lyrics
GET/PUT /api/state and settings
POST/DELETE /api/library/likes
POST/DELETE /api/history
CRUD    /api/playlists
PUT/DELETE /api/session
account endpoints
```

Remove from the hosted build:

```text
POST/GET /api/resolve
GET/HEAD /api/stream/:id
hosted yt-dlp installation and startup self-check
format/client retry policy
signed playback capabilities
Range relay and stream concurrency limits
resolver prefetch/invalidation
PLAYBACK_SIGNING_KEY
MELO_YTDLP in the web container
Python from the production web image
```

Keep `internal/media`, the managed standalone yt-dlp dependency, and the loopback
proxy for the Wails desktop build. The web server should stop depending on them.
Build tags or separate desktop/server composition roots can enforce this boundary
without duplicating queue or library semantics.

### Deployment

Serve the compiled React assets and `/api` from one public origin. A single Go
container on Railway, Fly.io, Render, or another ordinary application host is
enough because it no longer extracts or relays media. This removes production CORS
coordination between Vercel and Railway. A CDN can still sit in front of the same
origin if needed.

For the current scale, the existing account-scoped store is adequate. If starting
strictly from scratch, one SQLite database in WAL mode on a persistent volume is
the simplest account/library store. PostgreSQL should be introduced only if
multiple application replicas are actually required.

YouTube media bandwidth flows directly from YouTube to the browser; MELO pays only
for small JSON and lyrics responses.

## Playback provider details

### Use the official IFrame API

The IFrame API supports loading or cueing a video, play, pause, stop, seek, volume,
playback rate, state events, error events, current time, duration, and loaded
fraction. It also reports autoplay blocking. These operations cover most of MELO's
current web transport surface without exposing a media URL.

Recommended player configuration:

```ts
new YT.Player(element, {
  width: 480,
  height: 270,
  videoId,
  playerVars: {
    playsinline: 1,
    controls: 1,
    origin: window.location.origin,
  },
  events: {
    onReady,
    onStateChange,
    onError,
    onAutoplayBlocked,
  },
})
```

The layout should provide at least a 480×270 16:9 player on ordinary desktop
screens and never shrink its viewport below 200×200. Put it in the Now Playing
artwork area or an always-visible player panel; do not create a hidden, zero-sized,
off-screen, or covered iframe.

The page must send an appropriate origin/referrer. The IFrame API documents error
153 when client identification such as the HTTP Referer is absent. If the Go
server serves the SPA, its current `Referrer-Policy: no-referrer` must be replaced
for HTML with a compatible policy such as `strict-origin-when-cross-origin`, and
`origin` should be supplied to the player. CSP must allow the selected YouTube
frame and API script hosts.

### Product limitations that remain

The official player is simpler and substantially more stable than extraction, but
it is not a generic audio element:

- video and YouTube player UI must remain visible;
- YouTube may show ads and MELO must not block or alter them;
- some owners disable embedding (IFrame errors 101/150);
- removed, private, age/region-restricted, or otherwise unavailable videos still
  cannot play;
- unmuted autoplay can be blocked until a user gesture;
- browser/background/PWA playback cannot be promised;
- provider branding and player behavior remain under YouTube's control; and
- a pure audio-only skin is not a compliant use of the IFrame API.

Search should prefer embeddable/syndicated videos, and error 101/150 should remove
only the failed candidate and continue. This is ordinary unavailable-media
handling, not format extraction.

## Search, albums, artists, and radio

There are two sensible migration stages.

### Stage A — fastest playback simplification

Keep the current YouTube Music metadata search, radio, recommendation, and LRCLIB
code temporarily. Those paths return IDs and metadata and are independent of the
zero-format playback failure. Replace only web playback with the iframe. This is
the smallest way to prove the architecture with Believer, Thunder, Demons, and an
eight-transition Song Radio run.

### Stage B — clean official metadata path

Move web search to the YouTube Data API:

1. `search.list` with `type=video`, `videoEmbeddable=true`, and
   `videoSyndicated=true`;
2. one batched `videos.list` call for durations, status, and thumbnails;
3. `relatedToVideoId` search or MELO's own history/artist queries for radio; and
4. server-side caching and frontend debounce.

Keep the API key on the backend and restrict it in Google Cloud. The official quota
page currently lists a default allocation of 100 `search.list` calls per day and
10,000 daily units for other methods, so caching is essential and a quota increase
would be required for meaningful public scale.

The Data API is video-centric, not a complete music catalogue. Song/album/artist
facets will be less rich than YouTube Music metadata. MELO can either:

- present albums and artists derived from saved track metadata, as it already does;
- retain the current metadata provider as a non-critical enrichment; or
- adopt a licensed music catalogue API later.

Do not add two simultaneous search providers in the first migration. Stage A is
for proving playback. Stage B replaces metadata only when the product accepts the
quota and catalogue tradeoffs.

## Frontend boundary

The current `Backend` interface mixes data operations with media acquisition. Split
it into two responsibilities:

```ts
interface DataBackend {
  search(...): Promise<SearchResponse>
  radio(...): Promise<RadioSession>
  getLyrics(...): Promise<LyricsResult>
  getState(): Promise<AppState>
  // account/library/playlist/session operations
}

interface PlaybackAdapter {
  load(track: Track, startAt: number, autoplay: boolean): Promise<void>
  play(): Promise<void>
  pause(): void
  stop(): void
  seek(seconds: number): void
  setVolume(value: number): void
  setMuted(value: boolean): void
  setRate(value: number): void
  subscribe(listener: (event: PlaybackEvent) => void): () => void
  dispose(): void
}
```

Implementations:

```text
Wails/Desktop: HtmlAudioPlaybackAdapter
  └── calls App.GetPlayable, then uses the existing HTMLAudioElement

Web: YouTubeIframePlaybackAdapter
  └── loads Track.sourceId directly into one visible YT.Player
```

This is the only intentional desktop/web difference. Queue order, discovery,
dedupe, current-track transaction rules, history, and session state remain above
the adapter. The tested queue engine is not the source of web complexity and does
not need to be redesigned.

The current `frontend/src/audio/engine.ts` can become the desktop/audio adapter.
The web iframe adapter should emit the same state/position/ended/error shape so
`frontend/src/state/playback.ts` needs only transport wiring rather than a second
queue implementation.

## Concrete migration plan

### Phase 0 — isolated feasibility spike (1–2 days)

1. Add a development-only visible IFrame player surface.
2. Load Believer, Thunder, and Demons directly by source ID.
3. Verify real Chrome, Edge, Firefox, and mobile behavior with a click gesture.
4. Verify play, pause, seek, volume, rate availability, end event, and embed-error
   handling.
5. Run at least eight audible transitions while the MELO Queue panel stays open.
6. Confirm the player remains visible and policy-compliant.

Stop here if the required music IDs are not embeddable or if a visible video player
is unacceptable to the product. Do not build another extraction workaround.

### Phase 1 — transport replacement (2–4 days)

1. Introduce `PlaybackAdapter` and adapt the existing audio engine.
2. Add `YouTubeIframePlaybackAdapter` with one stable iframe instance.
3. Select iframe for web and HTMLAudio/Wails for desktop.
4. Remove web `getPlayable`, resolver prefetch, invalidation, expiry recovery, and
   signed-source assumptions.
5. Commit playback state on the iframe's `PLAYING` event; preserve the existing
   generation/stale-event guards.
6. Map `ENDED`, buffering, autoplay-blocked, and error codes into the existing
   playback event model.
7. Derive lyrics position from iframe time, not a second independent clock.

### Phase 2 — hosted backend reduction (1–2 days)

1. Remove resolve/stream routes and media dependencies from `server/main.go` and
   `server/api` composition.
2. Remove Python/yt-dlp from the hosted Docker image.
3. Remove playback signing and stream-specific production configuration.
4. Serve the built React app and JSON API from one origin.
5. Keep all desktop dependency management unchanged.

### Phase 3 — metadata decision (2–5 days)

Choose exactly one web search source for launch:

- retain existing metadata search for fastest delivery, or
- implement official YouTube Data API search with aggressive cache and quota
  monitoring.

Do not block the playback migration on album/artist enrichment.

### Phase 4 — cleanup and acceptance

- Delete web-only resolver diagnostics, retry UI, and stream recovery code after
  the iframe path passes production verification.
- Retain the provider investigation documents as historical rationale.
- Run existing queue/state regressions against a fake `PlaybackAdapter`.
- Add real-browser tests for user-gesture playback, iframe errors, ended exactly
  once, rapid A→B→C switches, reload restore, and mobile layout.
- Re-run desktop Wails build and smoke tests to prove its local audio path did not
  change.

## Acceptance criteria

The simplified web architecture is ready only when all are true:

1. Believer, Thunder, and Demons start through the visible official player from a
   real browser without `/resolve` or `/stream` requests.
2. Ten independent tracks and at least eight Song Radio transitions are audible.
3. `PLAYING` is the only event that commits a candidate as current.
4. Ended and explicit Next advance once each.
5. An unembeddable/private video skips only itself and refills discovery.
6. Search, likes, library, playlists, history, radio, recommendations, lyrics, and
   click-to-seek still work within provider limitations.
7. Autoplay-blocked state asks for a user gesture rather than retrying endlessly.
8. The iframe is visible and meets minimum dimensions.
9. The hosted container contains no yt-dlp/Python media resolver and relays no
   media bytes.
10. Desktop playback and its loopback proxy continue to pass unchanged.

## Alternatives considered

| Option | Simplicity | Reliability | Product cost | Verdict |
| --- | --- | --- | --- | --- |
| Official visible YouTube IFrame + data-only MELO backend | High | Best available for YouTube-hosted playback | Visible video, ads, embed/autoplay limits | **Recommended** |
| Static SPA + local browser storage + IFrame | Highest | Similar playback reliability | Loses accounts/cross-device state; API-key/quota concerns | Good prototype or personal mode |
| Separate hosted yt-dlp microservice | Superficially simple | Same datacenter/provider failure | Still extraction, media URLs, proxy bandwidth and maintenance | Do not pursue |
| Public Invidious/Piped-style relay | Low operational ownership | Depends on another extraction relay | External availability, policy and privacy risk | Do not pursue |
| Local companion service | Moderate | Similar to desktop on user network | Requires installation; not a true web-only app | Optional personal mode only |
| Spotify Web Playback SDK | Moderate | Official | User OAuth and full Premium required; commercial restrictions; different catalogue | Separate product decision |
| Apple Music MusicKit | Moderate | Official | Apple developer setup, user subscription/auth, different catalogue | Separate product decision |
| SoundCloud widget | High | Official for its hosted tracks | Catalogue mismatch | Niche provider option |
| MELO-owned/licensed audio in object storage/CDN | Simple runtime | Highest control | Rights, catalogue ingestion, storage/CDN cost | Correct answer for a true custom audio-only product |

## Final recommendation

Build the Phase 0 IFrame spike before changing production code. If a visible
YouTube player is acceptable and the required tracks embed successfully, proceed
with the IFrame architecture and remove hosted media extraction entirely. That is
the shortest implementation path and the largest reliability simplification.

If a visible provider player is unacceptable, stop investing in hosted yt-dlp.
Select a licensed web playback SDK or licensed MELO media catalogue first; then use
a normal HTMLAudioElement with provider-supported URLs. There is no lightweight
proxy design that turns arbitrary YouTube extraction into a simple, reliable
public web music backend.

## Primary references

- YouTube IFrame Player API reference:
  <https://developers.google.com/youtube/iframe_api_reference>
- YouTube API Services Developer Policies:
  <https://developers.google.com/youtube/terms/developer-policies>
- YouTube Data API quota calculator:
  <https://developers.google.com/youtube/v3/determine_quota_cost>
- YouTube Data API `search.list` reference:
  <https://developers.google.com/youtube/v3/docs/search/list>
- yt-dlp YouTube PO Token Guide:
  <https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide>
- Spotify Web Playback SDK (alternative provider context):
  <https://developer.spotify.com/documentation/web-playback-sdk>
