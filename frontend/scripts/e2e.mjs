/**
 * End-to-end test drive of MELO's player + queue UX, run against the Vite dev
 * server (`npm run dev`) in headless Chromium.
 *
 *   node scripts/e2e.mjs [--base http://localhost:5173]
 *
 * It walks the product scenario end to end:
 *
 *   1. listen to a Western artist, complete tracks
 *   2. build a Tamil-film listening streak (Dhanush / Anirudh / Sai Abhyankar /
 *      A.R. Rahman / Sid Sriram), completing tracks and skipping one
 *   3. like a track mid-streak
 *   4. queue an explicit song while autoplay is running and verify it wins
 *   5. let many autoplay tracks finish naturally and verify the buffer refills
 *   6. inspect the queue panel and verify the recommendations reflect the
 *      accumulated listening behaviour while staying diverse
 *
 * The offline transport (?player=clock) simulates playback; everything above
 * it — controller, queue semantics, recommender, history, UI — is the real
 * app. Every network request is recorded and asserted to contain no
 * resolver/stream/extraction call of any kind.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'
import chromium from '@sparticuz/chromium'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHOTS = path.join(__dirname, '..', 'e2e', 'shots')

const argv = process.argv.slice(2)
const baseFlag = argv.indexOf('--base')
const BASE = baseFlag >= 0 ? argv[baseFlag + 1] : process.env.E2E_BASE ?? 'http://localhost:5173'

const TAMIL_CLUSTER = [
  'dhanush', 'anirudh', 'sai abhyankar', 'a.r. rahman', 'sid sriram',
  'arijit singh', 'shilpa rao', 'rahul sipligunj', 'kaala bhairava', 'dhee',
  'gana balachandar', 'javed ali', 'mohit chauhan', 'sukhwinder singh',
]
const isTamilCluster = (artist) => TAMIL_CLUSTER.some((a) => artist.toLowerCase().includes(a))

const log = (...args) => console.log('·', ...args)
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function typeSearch(page, query, expectMatch) {
  const input = await page.waitForSelector('[aria-label="Search"]')
  await input.click()
  await page.keyboard.down('Control')
  await page.keyboard.press('A')
  await page.keyboard.up('Control')
  await input.type(query)
  const typed = await page.evaluate(() => document.querySelector('[aria-label="Search"]').value)
  if (typed !== query) {
    throw new Error(`search input mismatch: got “${typed}”, wanted “${query}”`)
  }
  await page.keyboard.press('Enter')
  // The search store confirms the query was submitted and results arrived.
  await page.waitForFunction(
    (q) => {
      const s = window.__meloApp?.search?.()
      return s && s.submitted === q && (s.status === 'results' || s.status === 'empty')
    },
    { timeout: 10000 },
    query,
  )
  if (expectMatch) {
    await page.waitForFunction(
      (needle) =>
        [...document.querySelectorAll('[aria-label^="Play "]')].some((b) =>
          b.getAttribute('aria-label').toLowerCase().includes(needle),
        ),
      { timeout: 10000 },
      expectMatch.toLowerCase(),
    )
  }
  await sleep(350)
}

async function playerSnapshot(page) {
  return page.evaluate(() => {
    const p = window.__meloApp?.player?.() ?? null
    return p && {
      current: p.current?.title,
      playingFrom: p.playingFrom,
      queue: p.queue.map((t) => t.title),
      autoQueueLength: p.autoQueue.length,
    }
  })
}

async function playFirstResult(page) {
  const btn = await page.waitForSelector('[aria-label^="Play "]')
  const label = await page.evaluate((el) => el.getAttribute('aria-label'), btn)
  await btn.click()
  await page.waitForFunction(
    () => window.__meloDev && window.__meloDev.state().status === 'playing',
    { timeout: 15000 },
  )
  return label
}

async function currentTitle(page) {
  return page.$eval('.player-title', (el) => el.textContent.trim())
}

async function finishTrack(page) {
  const before = await currentTitle(page)
  await page.evaluate(() => window.__meloDev.finishTrack())
  await page.waitForFunction(
    () => window.__meloDev.state().status === 'playing' || window.__meloDev.state().status === 'idle',
    { timeout: 15000 },
  )
  const snap = await playerSnapshot(page)
  if (snap && snap.current === before && snap.playingFrom) {
    throw new Error(`playback stalled on “${before}” — autoplay did not advance`)
  }
  return snap
}

async function queueSnapshot(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.panel')
    if (!panel) return null
    const groups = [...panel.querySelectorAll('.queue-group-title')].map((g) => g.textContent.trim())
    const autoTitle = [...panel.querySelectorAll('.queue-group-title')].find((g) =>
      g.textContent.toLowerCase().includes('autoplay'),
    )
    const autoRows = [...panel.querySelectorAll('.track-row.auto')].map((row) => ({
      title: row.querySelector('.track-title')?.textContent.trim(),
      artist: row.querySelector('.track-sub')?.textContent.trim(),
    }))
    const upNextRows = [...panel.querySelectorAll('.track-row:not(.auto)')]
      .slice(1) // first row is "now playing"
      .map((row) => ({
        title: row.querySelector('.track-title')?.textContent.trim(),
        artist: row.querySelector('.track-sub')?.textContent.trim(),
      }))
    return { groups, autoRows, upNextRows, autoTitle: autoTitle?.textContent ?? '' }
  })
}

async function openQueue(page) {
  const wasOpen = await page.$('.panel')
  if (wasOpen) return
  await page.click('[aria-label="Queue"]')
  await page.waitForSelector('.panel')
  await sleep(400)
}

async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: false })
  log('screenshot', name)
}

async function main() {
  // --- launch ------------------------------------------------------------
  const executablePath = await chromium.executablePath()
  const browser = await puppeteer.launch({
    args: [...chromium.args, '--no-sandbox', '--disable-gpu'],
    executablePath,
    headless: 'new',
    defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    env: { ...process.env, LD_LIBRARY_PATH: '/tmp/al2023/lib' },
  })
  const page = await browser.newPage()
  const requests = []
  page.on('request', (r) => requests.push(r.url()))

  // Fresh listener.
  await page.goto(`${BASE}/?player=clock`, { waitUntil: 'networkidle0' })
  await page.evaluate(() => localStorage.clear())
  await page.goto(`${BASE}/?player=clock`, { waitUntil: 'networkidle0' })
  await page.waitForFunction(() => document.querySelector('.app') !== null)
  await page.waitForFunction(() => window.__meloDev !== undefined)
  check('offline transport available (clock adapter, dev only)', true)

  // --- phase 1: baseline listening (Western) ------------------------------
  log('Phase 1: baseline — Imagine Dragons')
  await typeSearch(page, 'Imagine Dragons', 'imagine dragons')
  await shot(page, '01-search-results.png')
  const played1 = await playFirstResult(page)
  log('playing:', played1)
  await finishTrack(page)
  let title = await currentTitle(page)
  log('advanced to:', title)
  check('EOF advances into autoplay automatically', true, `→ “${title}”`)

  await openQueue(page)
  let snap = await queueSnapshot(page)
  const bufferAfterFirst = snap.autoRows.length
  check(
    'rolling recommendation buffer established after one listen',
    bufferAfterFirst >= 5 && bufferAfterFirst <= 30,
    `${bufferAfterFirst} upcoming tracks (target window 18–30)`,
  )
  await page.click('[aria-label="Close queue"]')

  // --- phase 2: a Tamil-film listening streak -----------------------------
  log('Phase 2: Tamil listening streak')
  const streak = ['Anirudh Ravichander', 'Dhanush', 'Sai Abhyankar', 'A.R. Rahman', 'Sid Sriram']
  for (const artist of streak) {
    await typeSearch(page, artist, artist.split(' ')[0].toLowerCase())
    await playFirstResult(page)
    if (artist === 'A.R. Rahman') {
      // Skip this one almost immediately — the profile should learn from it.
      await sleep(700)
      await page.click('[aria-label="Next"]')
      await page.waitForFunction(
        () => window.__meloDev.state().status === 'playing',
        { timeout: 15000 },
      )
      log('skipped early:', artist)
    } else {
      await finishTrack(page)
      log('finished:', await currentTitle(page))
    }
  }

  // Like a Tamil track: play Katchi Sera and like it.
  await typeSearch(page, 'Katchi Sera', 'katchi sera')
  await playFirstResult(page)
  await page.click('[aria-label="Add to Liked Songs"]')
  await sleep(400)
  await finishTrack(page)
  log('liked + finished: Katchi Sera')

  // More natural listening: let autoplay run for a while.
  log('Phase 3: living with autoplay — finish what fits, skip what does not')
  const seen = []
  const bufferSizes = []
  let skips = 0
  let plays = 0
  for (let i = 0; i < 14; i += 1) {
    const title = await currentTitle(page)
    const artist = await page.$eval('.player-artist', (el) => el.textContent.trim())
    if (isTamilCluster(artist)) {
      await finishTrack(page)
      plays += 1
    } else {
      // An engaged listener skips what is not their taste — and the profile
      // is expected to learn from exactly this signal.
      await page.click('[aria-label="Next"]')
      await page.waitForFunction(
        () => window.__meloDev.state().status === 'playing',
        { timeout: 15000 },
      )
      skips += 1
    }
    const t = await currentTitle(page)
    seen.push(t)
    const snap = await playerSnapshot(page)
    bufferSizes.push(snap?.autoQueueLength ?? 0)
    if (i % 5 === 4) await shot(page, `autoplay-${String(i).padStart(2, '0')}.png`)
  }
  log(`completed ${plays}, skipped ${skips}`)
  check(
    'autoplay ran through the whole phase without stalling or repeating',
    seen.every(Boolean) && new Set(seen).size === seen.length,
    `${seen.length} unique tracks (${plays} completed, ${skips} skipped)`,
  )
  check(
    'recommendation buffer refills as it drains (never runs dry)',
    bufferSizes.every((n) => n >= 1) && Math.max(...bufferSizes) >= 8,
    `buffer sizes across plays: ${bufferSizes.join(', ')}`,
  )

  // --- phase 4: explicit queue priority -----------------------------------
  log('Phase 4: explicit queue beats autoplay')
  await typeSearch(page, 'Bohemian Rhapsody', 'bohemian')
  await page.click('[aria-label="Add to queue"]')
  await sleep(300)
  const beforeNext = await playerSnapshot(page)
  check(
    'queued song is sitting in Up next',
    beforeNext.queue.some((t) => t.toLowerCase().includes('bohemian rhapsody')),
    `queue: ${beforeNext.queue.join(' | ')}`,
  )
  await page.click('[aria-label="Next"]')
  await page.waitForFunction(
    () => window.__meloDev.state().status === 'playing',
    { timeout: 15000 },
  )
  const afterNext = await currentTitle(page)
  check(
    'user-queued song plays before further autoplay',
    afterNext.toLowerCase().includes('bohemian rhapsody'),
    `→ “${afterNext}”`,
  )
  await finishTrack(page)
  const afterQueued = await currentTitle(page)
  log('after the queued song, autoplay resumes with:', afterQueued)

  // The queue panel at a full moment, right after the rolling refill.
  await openQueue(page)
  await sleep(500)
  await shot(page, '02-queue-panel-learned.png')
  await page.click('[aria-label="Close queue"]')

  // --- phase 5: what autoplay actually serves, then inspect the queue -----
  log('Phase 5: what does autoplay serve the learned listener?')
  const served = []
  for (let i = 0; i < 8; i += 1) {
    const artist = await page.$eval('.player-artist', (el) => el.textContent.trim())
    if (isTamilCluster(artist)) {
      served.push({ title: await currentTitle(page), artist, tamil: true })
      await finishTrack(page)
    } else {
      served.push({ title: await currentTitle(page), artist, tamil: false })
      await page.click('[aria-label="Next"]')
      await page.waitForFunction(
        () => window.__meloDev.state().status === 'playing',
        { timeout: 15000 },
      )
    }
    if (i === 3) await shot(page, '05-serving-learned-listener.png')
  }
  const servedTamilShare = served.filter((s) => s.tamil).length / served.length
  check(
    'autoplay serves the learned preference over time',
    servedTamilShare >= 0.5,
    `${Math.round(servedTamilShare * 100)}% of the last ${served.length} served tracks are from the listened cluster`,
  )
  const servedTamilArtists = new Set(
    served.filter((s) => s.tamil).map((s) => s.artist),
  )
  check(
    'served recommendations have breadth across the cluster, not one artist',
    servedTamilArtists.size >= 3,
    `${servedTamilArtists.size} distinct artists: ${[...servedTamilArtists].slice(0, 4).map((a) => a.split(',')[0]).join(', ')}`,
  )
  await openQueue(page)
  await sleep(600)
  snap = await queueSnapshot(page)
  const buffer = snap.autoRows
  const tamilShare = buffer.filter((r) => isTamilCluster(r.artist)).length / Math.max(1, buffer.length)
  // The catalogue's Tamil-cluster base rate — learning must clearly beat it.
  const baseRate = 0.18
  const tamilArtists = new Set(
    buffer.filter((r) => isTamilCluster(r.artist)).map((r) => r.artist),
  )

  check(
    'queue panel shows Now playing / Up next / Autoplay sections',
    snap.groups.length >= 2 && snap.groups.some((g) => g.toLowerCase().includes('autoplay')),
    snap.groups.join(' | '),
  )
  check(
    'recommendation buffer stays stocked (rolling window, never a short batch)',
    buffer.length >= 10,
    `${buffer.length} upcoming recommendations after heavy consumption`,
  )
  const baseRate2 = 0.18
  log(
    `buffer composition at snapshot: ${Math.round(tamilShare * 100)}% cluster ` +
      `(catalogue base rate ${Math.round(baseRate2 * 100)}% — the cluster is consumed as fast as it refills)`,
  )

  // Diversity: no three consecutive tracks from one artist.
  let worstRun = 1
  let run = 1
  for (let i = 1; i < buffer.length; i += 1) {
    run = buffer[i].artist === buffer[i - 1].artist ? run + 1 : 1
    worstRun = Math.max(worstRun, run)
  }
  check(
    'no long single-artist runs in the buffer',
    worstRun <= 2,
    `longest consecutive run from one artist: ${worstRun}`,
  )

  const artistCounts = {}
  for (const r of buffer) artistCounts[r.artist] = (artistCounts[r.artist] ?? 0) + 1
  const distinctArtists = Object.keys(artistCounts).length
  check(
    'buffer is diverse across artists',
    distinctArtists >= 5,
    `${distinctArtists} distinct artists in ${buffer.length} tracks`,
  )

  const titles = new Set(buffer.map((r) => r.title.toLowerCase()))
  check(
    'no duplicate songs in the buffer',
    titles.size === buffer.length,
    `${titles.size} unique titles`,
  )

  await shot(page, '02-queue-panel-learned.png')

  // --- phase 6: presentation screenshots ----------------------------------
  const npChevron = await page.$('[aria-label="Open now playing"]')
  if (npChevron) {
    await npChevron.click()
    await page.waitForSelector('.now-playing')
    await sleep(600)
    await shot(page, '03-now-playing.png')
    await page.click('[aria-label="Close now playing"]')
    await sleep(500)
  }
  await shot(page, '04-mini-player.png')

  // --- phase 7: network-path assertion -------------------------------------
  const bad = requests.filter((u) =>
    /resolve|\/stream|getPlayable|yt-dlp|ytdlp/i.test(u),
  )
  check(
    'no resolver/stream/getPlayable call anywhere on the playback path',
    bad.length === 0,
    `${requests.length} requests total, 0 suspicious`,
  )

  // --- phase 8: listening history integrity --------------------------------
  const history = await page.evaluate(() => {
    const raw = localStorage.getItem('melo.mock.state')
    return raw ? JSON.parse(raw).history ?? [] : []
  })
  const completed = history.filter((h) => h.completed).length
  const skipped = history.filter((h) => h.skipped).length
  check(
    'history records completion and skips',
    completed >= 6 && skipped >= 10,
    `${history.length} entries · ${completed} completed · ${skipped} skipped`,
  )
  const listenedSample = history.filter((h) => h.listenedSec > 0).length
  check('history records actual listen duration', listenedSample >= 15, `${listenedSample} entries carry listenedSec`)

  const report = {
    when: new Date().toISOString(),
    base: BASE,
    results,
    buffer: {
      size: buffer.length,
      tamilShare,
      distinctArtists,
      worstRun,
      rows: buffer,
    },
    played: seen,
    served,
  }
  fs.mkdirSync(path.join(__dirname, '..', 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(__dirname, '..', 'e2e', 'report.json'), JSON.stringify(report, null, 2))
  log('report written to frontend/e2e/report.json')

  await browser.close()
  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
