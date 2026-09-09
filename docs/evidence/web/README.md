# Web deployment verification — latest: commit `4b4ad75`

## Commit lineage (all on `arena/01a085b6-musicapp`)

```
5817a2e  Player UX pass 2: integrated YouTube playback, learning Autoplay
793a393  feat(web): static web deployment target (fixture backend + YT IFrame in browser)
341e8ec  docs: web deployment evidence
76cf6c0  fix(web): SPA rewrites (vercel.json), structuredClone → JSON clone, boot isolation
48681f1  chore: untrack build output
58d8a9c  ci: GitHub Pages deploy workflow (runs once Pages is enabled)
4b4ad75  build: es2020 target (Chrome/Edge 85+, Firefox 78+, Safari 13.1+)
```

`76cf6c0` and `4b4ad75` exist because the first public deployment round failed
for real users — see "What was actually broken" below.

## Live deployments

| URL | What it serves | Status |
| --- | --- | --- |
| https://musicapp-1pg15wu5t-rp-1bc2.vercel.app | **`4b4ad75`** — Vercel deployment of this branch | Live, public, verified externally |
| https://musicapp-rp-1bc2.vercel.app | Old `arena/01a0817d-musicapp` build (previous session; `/resolve`+`/stream` architecture) | Stale until the Vercel production branch is flipped |
| `gh-pages` branch @ `1a08c25` | Pages build of `4b4ad75` (relative base, works at any path) | Pushed; publish = enable Pages in repo Settings |

## What was actually broken in the first deployment round (and is fixed)

1. **No SPA fallback** — `frontend/vercel.json` was missing, so any non-root
   route (e.g. `/library`) returned a Vercel 404 instead of the app. The old
   deployment branch had this config; my branch did not. Fixed in `76cf6c0`;
   `/search`, `/library` etc. now serve the app (verified externally).
2. **`structuredClone` in the shipped fixture backend** — needs Chrome/Edge
   98+ / Safari 15.4+. On older-but-common browsers `getState()` threw on
   every boot → error state instead of the catalogue. All local test
   environments masked it (modern Chromium; jsdom even polyfills it in
   `src/test/setup.ts`). Replaced with a JSON clone (state is JSON by
   design). Fixed in `76cf6c0`.
3. **Boot coupling** — adapter selection ran before backend init; a provider
   failure would have killed the whole boot. Now parallel, with a clock
   fallback; search/catalogue can never depend on the player (`76cf6c0`).
4. **`es2022` build target** — excluded Chrome/Edge 85–93 etc. Lowered to
   `es2020` (`4b4ad75`).

## External verification (platform fetcher — a real browser context outside
the sandbox — plus two headless-Chromium drives of the exact bundle)

- Root URL renders the MELO app (library home, no error state, no auth wall
  observed from an unauthenticated external context).
- Deep routes (`/search`, `/library`) serve the app — SPA rewrites live.
- Served assets are content-hash identical to the local build of `4b4ad75`:
  `assets/index-DJA-R_c_.js`, `assets/mockBackend-BpbYl6bu.js`,
  `assets/index-DN7jvAhV.css`. The bundle begins with the es2020 downleveling
  helpers, confirming the new target shipped.
- **Networked-browser simulation** (production bundle + faithful stub of the
  YouTube IFrame API via request interception — the path a normal browser
  with YouTube access takes): 14/14 checks — no page or console errors,
  search returns catalogue results, a real `YT.Player` is created,
  `playVideo` runs, position advances 0:02 → 0:05, the stage docks into Now
  Playing at 460×460 (always ≥ 200×200), settings volume applied (90), clean
  reload. See `report.json` + `0*-yt-path.png`.
- **Offline simulation** (clock fallback): 11/11 checks — boots, search,
  playback clock advances, queue sections, 16-row autoplay buffer, 0
  forbidden requests.
- Bundle greps: `getPlayable`, `yt-dlp`, `/resolve`, `/stream` — 0
  occurrences.
- Full suites on `4b4ad75`: 144/144 vitest, 17/17 e2e checks.

## Still pending (requires repo-owner clicks; no credentials exist for these)

1. **Vercel production URL**: flip Project → Settings → Git → Production
   Branch to `arena/01a085b6-musicapp` (or merge PR #2 and point production
   at `main`). Removes the preview-only Vercel Toolbar widget too.
2. **GitHub Pages**: Settings → Pages → either "Deploy from branch:
   `gh-pages` / root" (branch is current) or "GitHub Actions" (workflow
   `.github/workflows/deploy-pages.yml` is already pushed and will build +
   deploy on the next push / manual dispatch). Both my API token and the
   Actions GITHUB_TOKEN are denied Pages write ("Resource not accessible by
   integration"), so this cannot be automated from the agent side.
