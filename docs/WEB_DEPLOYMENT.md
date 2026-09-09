# MELO Web: local development and deployment

MELO now has two runtime adapters over one React application:

```text
Wails desktop -> WailsBackend -> existing App methods / loopback stream proxy
Browser        -> WebBackend   -> HTTPS MELO API / signed stream tickets
```

The browser never imports Wails bindings, executes `yt-dlp`, reads the filesystem,
or receives provider request headers. The API resolves provider IDs and returns a
short-lived URL scoped to that one ID. The API streams bytes only because current
provider CDN responses require server-side headers and generally do not permit a
browser-origin request; this is a bounded, signed media path, not an open proxy.

## Production verification status (2026-09-09)

The hosted architecture is live:

- Frontend: <https://musicapp-rp-1bc2.vercel.app>
- API: <https://musicapp-production-9257.up.railway.app>
- Vercel builds `frontend/` and Railway builds the root Dockerfile from
  `arena/01a0817d-musicapp`. Railway remains at one replica with `/data` mounted
  for the file repository.

Verified in production:

- `/health`, `/ready`, and sanitized diagnostics return successful responses.
- Exact-origin credentialed CORS, the signed same-API resolve/stream path, real
  provider search, metadata/artwork, and multi-track resolution work from the
  public frontend.
- Audible browser playback, pause/resume, seeking, several automatic track
  transitions, explicit-over-discovery priority, Song Radio, synced lyrics, and
  lyric-click seek were manually exercised on the public deployment.
- CI run `34268753016` passes Go tests/vet/build, the Windows desktop cross-build,
  119 frontend tests and production bundle build, plus the production-container
  health/readiness/CORS/request-ID smoke test. The queue regression suite includes
  five radio transitions, proactive refill, failure preservation, stale-request
  handoff, queue priority, search isolation, and multi-refill canonical dedupe.

The queue-controller repair that maintains a five-to-eight item discovery buffer
is deployed. On 2026-09-09, a fresh audible production run started Song Radio
from “Believer” by Imagine Dragons and passed at least five Next transitions:
the Autoplay buffer stayed populated at roughly five to eight items, showed no
empty/duplicate buffer, and retained explicit-queue priority.

The shared parity revision extracts ordering, projection, prefetch order,
incremental append, canonical reconciliation, and failed-candidate removal into
`frontend/src/domain/queueEngine.ts`. That domain and `PlaybackController` are
shared by Wails and web; `WebBackend` remains transport/cache only. Its first
production candidate was not accepted: a fresh Believer run exposed visual
`CURRENT` advancement before the selected stream was audibly playing.

The current repair makes each transition transactional. Resolution and media
loading are provisional; current metadata, queue cursor, discovery consumption,
lyrics, history, and Media Session state commit only after
`HTMLAudioElement.play()` succeeds. A rejected candidate is removed alone and the
canonical explicit-first alternative is attempted while the prior committed
current remains visible. Duplicate ended events and stale refill/radio responses
cannot enqueue a second or superseded transition. Local validation passes 135
frontend tests and the production build, including buffering-time resolver/refill
completion, rejected `play()`, eight radio transitions, and stale-command guards.
CI run `34315314253` also passed frontend, Go, Windows Wails, and production
container jobs, and the transactional revision deployed successfully.

Its first production retest could not begin the transition run: Believer remained
buffering and never became audible. Direct API checks then reproduced
`media_unavailable` for Believer, Thunder, Demons, and other popular music IDs
while a control ID still resolved, isolating a provider-client compatibility
failure rather than a queue cursor mutation. The resolver now makes one bounded
`android_vr` fallback for its token-free progressive MP4 before the existing
embedded/TV fallback; it does not enable missing-token formats, add credentials,
or bypass access restrictions. A fresh live eight-transition audible run remains
required after that fallback deploys and is unverified until recorded below.

Still unverified in production: invalid/expired-ticket recovery, account
register/logout/relogin and cross-account isolation, library/playlist persistence
across a Railway restart, responsive Chrome/Firefox/Edge coverage, Media Session,
and PWA installation. These remain checklist items rather than claimed results.

## Local development

Requirements: Go 1.23+, Node 20+, npm, and either `yt-dlp` on `PATH` or a path in
`MELO_YTDLP`. If `MELO_YTDLP` is omitted, the existing pinned/checksum-verified
MELO dependency manager installs its known version into `MELO_DATA_DIR/bin` when
first needed.

Terminal 1, from the repository root:

```bash
MELO_YTDLP="$(command -v yt-dlp)" go run ./server
```

Terminal 2:

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>. Vite proxies `/api` to
`http://127.0.0.1:8080`, so browser code does not call localhost directly when a
remote preview proxy is in use. No Wails installation is required.

One-command alternative:

```bash
./scripts/dev-web.sh
```

Docker alternative:

```bash
docker compose up --build
cd frontend && npm install && npm run dev
```

The development API uses isolated account JSON documents under `./data`. It is a
real persistent repository, not fixture data. To run the old UI fixture instead,
create `frontend/.env.development.local` containing `VITE_MELO_MOCK=1`.

## API environment

| Variable | Required in production | Meaning |
| --- | --- | --- |
| `ADDR` | no | listen address, default `:8080` |
| `MELO_ENV` | yes | set to `production` |
| `MELO_DATA_DIR` | yes | persistent storage path, `/data` in Docker |
| `MELO_YTDLP` | recommended outside Docker | resolver executable path |
| `CORS_ORIGINS` | yes | comma-separated exact frontend origins; never `*` |
| `SESSION_SECRET` | yes | at least 32 random bytes; signs HTTP-only sessions |
| `PLAYBACK_SIGNING_KEY` | yes | different random value; signs short media tickets |
| `COOKIE_SECURE` | yes | `true` behind HTTPS |
| `TRUST_PROXY_HEADERS` | Railway/Render | `true` to use the proxy-supplied client IP for limits |
| `SEARCH_TIMEOUT` | no | default `20s` |
| `RESOLVE_TIMEOUT` | no | default `45s` |
| `LYRICS_TIMEOUT` | no | default `15s` |
| `DATABASE_URL` | future adapter | reserved for the PostgreSQL repository implementation |

Generate secrets independently:

```bash
openssl rand -base64 48
openssl rand -base64 48
```

The file repository implements the same `server/store.Repository` and `Library`
interfaces targeted by PostgreSQL. The normalized production schema is at
`server/store/migrations/001_initial.sql`; it models users, tracks, artists,
albums, playlists/ordered tracks, likes, detailed history/play stats, and user
preferences. The current server deliberately stays zero-infrastructure for local
iteration; `DATABASE_URL` is not consumed until a PostgreSQL adapter is selected.
For multi-replica production today, keep Railway at one replica and attach a
persistent volume.

## Railway (backend) — exact steps

1. Push this repository to GitHub and create a **New Project -> Deploy from
   GitHub repo** in Railway.
2. Select the repository root. Railway detects `railway.json` and the root
   `Dockerfile`; do not set a custom start command.
3. Add a Railway volume mounted at **`/data`**. Keep one replica while using the
   file repository.
4. Add variables:

   ```text
   MELO_ENV=production
   MELO_DATA_DIR=/data
   COOKIE_SECURE=true
   TRUST_PROXY_HEADERS=true
   CORS_ORIGINS=https://your-melo.vercel.app,https://melo.example.com
   SESSION_SECRET=<first random value>
   PLAYBACK_SIGNING_KEY=<second independent random value>
   ```

   `ADDR=:8080` and `MELO_YTDLP=/usr/local/bin/yt-dlp` are already in the image.
5. In **Settings -> Networking**, generate a public HTTPS domain (for example,
   `https://melo-api-production.up.railway.app`).
6. Deploy. Railway checks `GET /ready`; verify both endpoints:

   ```bash
   curl https://YOUR-API/health
   curl https://YOUR-API/ready
   ```

7. If a custom API domain is used, point its DNS to Railway and add it there.
   Update the frontend variable below, then redeploy the frontend.

Provider resolution is CPU/network work and some hosts/providers may throttle a
shared datacenter IP. Search has an InnerTube primary and `yt-dlp` fallback.
Resolution is coalesced and cached only until the provider URL expiry. Search,
radio, recommendations, and lyrics have bounded TTL caches; search/resolve/stream
have per-client token buckets and provider failures open a short backoff circuit.

## Vercel (frontend) — exact steps

1. **Add New -> Project**, import the same GitHub repository.
2. Set **Root Directory** to `frontend`.
3. Framework preset: **Vite**. The committed `vercel.json` uses
   `npm run build` and publishes `dist`.
4. Add this non-secret public build variable for Production and Preview:

   ```text
   VITE_MELO_API_URL=https://YOUR-RAILWAY-DOMAIN/api/v1
   ```

5. Deploy. Copy the final Vercel URL into the API's `CORS_ORIGINS` and redeploy
   Railway. Include each custom production origin explicitly.
6. Open the site, play a track, and check the browser install prompt. The service
   worker caches only the shell/static assets. API data and audio are always
   network-only.
7. For `melo.example.com`, add the domain in Vercel. For
   `api.melo.example.com`, add the domain in Railway. Update both environment
   values to these final origins.

No database key, signing key, password hash, provider header, or privileged
credential belongs in `VITE_*`; the API URL is intentionally the only frontend
environment value.

## Required post-deployment verification record

Run this checklist against the final public origins and record pass/fail plus the
browser/device used. An HTTP success from `/resolve` or `/stream` does **not**
count as audible-playback verification.

1. Record the final Vercel and Railway URLs. Confirm the frontend build contains
   only the final `/api/v1` URL, Railway has one replica and a `/data` volume, and
   `CORS_ORIGINS` contains only the final exact frontend origins. Record that the
   two secrets are independently set, but never copy their values into logs or
   documentation.
2. Check `/health`, `/ready`, and sanitized `/api/v1/diagnostics`. Confirm every
   response has `X-Request-ID` and Railway logs correlate failed stages without
   printing provider URLs, provider headers, cookies, or signed query strings.
3. In a clean browser profile, verify anonymous search and select one exact song.
   In DevTools, confirm `search -> resolve -> signed same-API stream`; seek to
   force a browser `Range` request and confirm `206` while listening for real,
   continuous audio. Repeat across at least three tracks and one track whose
   upstream requires server-side headers. Confirm metadata/duration/artwork and
   play, pause, seek, volume, speed, mute, next, and previous.
4. Start Song Radio from Believer and advance through at least eight tracks.
   Verify explicit queue and discovery queue remain separate, discovery stays at
   roughly five to eight ready items and refills before empty, no immediate
   canonical duplicates appear, a manual queue item outranks discovery, and one
   failed refill does not stall or destroy either queue.
5. Exercise an expired/invalid ticket (`403`) and an interrupted source. Confirm
   the browser performs only the bounded re-resolve/retry, resumes when possible,
   reports a stable actionable error when exhausted, and never receives an
   upstream URL or privileged header. Confirm resolving and buffering time out
   rather than remaining indefinite.
6. Verify song radio, lyrics matching, synced highlighting, and lyric-click seek.
   Like tracks; create, rename, reorder, duplicate, and delete a playlist; update
   preferences; and produce history/recommendations. Register, log out, log in,
   and confirm account isolation and restored state.
7. Restart the Railway service and confirm account state survives on `/data`.
   Confirm the secure HTTP-only session cookie works from the final frontend
   origin. If browser third-party-cookie policy blocks the Railway/Vercel domain
   pair, record the failure and move to same-site custom domains rather than
   weakening cookie or CORS settings.
8. Test current Chrome, Firefox, and Edge at desktop and mobile viewport sizes,
   including mobile navigation/transport, queue, lyrics, and settings. Verify
   Media Session actions/metadata where supported and graceful fallback where
   unsupported. Check the manifest, icons, installability, and shell-only service
   worker; API and audio requests must remain network-only.

Update this document and `COMPATIBILITY.md` with the date and concrete outcomes.
Anything skipped, browser-specific, or provider-specific must remain explicitly
marked unverified or failed.

## Desktop verification

Web work does not alter the Wails-bound `App` surface. Desktop selection checks
for `window.go.main.App` before importing the web adapter. Build it as before:

```bash
cd frontend && npm run build && cd ..
wails build
```

Desktop continues to use local `%AppData%/MELO` state and its loopback capability
proxy. Hosted accounts never replace or migrate desktop state automatically.
