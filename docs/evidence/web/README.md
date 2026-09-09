# Web deployment verification — commit `793a393`

`793a393` = `5817a2e` (Player UX pass 2: integrated YouTube playback, learning
Autoplay queue) **+** one web-target commit that makes the static site work in
a browser (fixture backend + real YouTube IFrame player in browser builds,
pure-static Dockerfile for Railway). No resolver, stream proxy, or yt-dlp
exists anywhere in the deployed code.

## Live deployments

| URL | What it serves | Status |
| --- | --- | --- |
| https://musicapp-i4s8uo7cd-rp-1bc2.vercel.app | **This commit** (Vercel deployment of `arena/01a085b6-musicapp`) | Live, public, verified |
| https://musicapp-rp-1bc2.vercel.app | Old build from branch `arena/01a0817d-musicapp` (the `/resolve`+`/stream` Railway architecture) | Stale — needs the Vercel production branch flipped |
| https://musicapp-production-9257.up.railway.app | Old `melo-api` v3.1.0 Go server | Stale — repoint Railway to the new branch to build the static Dockerfile |
| `gh-pages` branch (repo) | Pages build of this commit (`/musicapp` base) | Pushed; enable in Settings → Pages → Deploy from branch → `gh-pages` / root |

## Deployment verification

- Vercel deployment for SHA `793a393` reported **success** (GitHub deployment
  id 6350566891, live URL above).
- Served assets are **byte-identical to the local production build** of this
  commit: `assets/index-B0OvBfNo.js`, `assets/mockBackend-B_ETLdtL.js`,
  `assets/index-DN7jvAhV.css` (content-hash match).
- The deployed `mockBackend` chunk serves the full 77-track fixture catalogue
  (verified live: Kolaveri / Rowdy Baby / Katchi Sera / … Dhanush, Anirudh,
  Sai Abhyankar, A.R. Rahman + Western catalog).
- The deployed app boots cleanly on the fixture backend (rendered library
  view, no backend-unavailable error state).
- Bundle greps (local build, identical bytes to deployed): `Up next`,
  `Autoplay`, `Playing from YouTube`, `Now playing` present;
  `getPlayable`, `yt-dlp`, `/resolve`, `/stream`, `installResolver`,
  `PlayableSource` — **0 occurrences**.

## Production-bundle smoke run (vite preview + headless Chromium, DOM-only)

11/11 checks — see `prod-bundle-smoke-report.json` and the screenshots:

1. prod bundle boots without backend error
2. offline transport toast shown (YouTube unreachable in the sandbox)
3. search returns Kolaveri from the fixture catalogue
4. Now Playing opens with the selected track
5. playback position advances (offline transport) — 0:02 → 0:06
6. queue shows Now playing section
7. queue shows Up next section
8. queue shows Autoplay section
9. autoplay buffer populated (16 rows)
10. Next skips through autoplay tracks (4 clicks)
11. zero resolver/stream/getPlayable requests (42 requests recorded)

## Full regression suites on the same commit

- 144/144 vitest (`npm test`)
- 17/17 e2e checks (`npm run e2e`): 100% of the last 8 served autoplay tracks
  from the learned Tamil-film cluster across 8 distinct artists; buffer
  22→13→22 rolling refill; explicit queue plays before autoplay; 0 forbidden
  requests in 174; history records 18 completed / 13 skipped / 26 with
  listened seconds.
