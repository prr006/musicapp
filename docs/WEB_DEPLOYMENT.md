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

## Desktop verification

Web work does not alter the Wails-bound `App` surface. Desktop selection checks
for `window.go.main.App` before importing the web adapter. Build it as before:

```bash
cd frontend && npm run build && cd ..
wails build
```

Desktop continues to use local `%AppData%/MELO` state and its loopback capability
proxy. Hosted accounts never replace or migrate desktop state automatically.
