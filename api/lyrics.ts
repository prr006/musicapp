/**
 * MELO lyrics backend — Vercel serverless function.
 *
 * GET /api/lyrics?videoId=<11-char YouTube id>
 *
 * Why this exists: YouTube Music's InnerTube endpoints do not send CORS
 * headers, so browsers cannot call them directly. This endpoint performs
 * the exact-video lookup server-side (no search, no title ambiguity) and
 * returns ONLY Melo's normalized lyric shape — never the raw YTM payload.
 *
 * Data sources: YouTube Music timed lyrics (exact videoId) only. This is a
 * free, legitimately accessible InnerTube web-client endpoint using the same
 * public client key the web player already ships. No paid APIs, no keys.
 * LRCLIB remains the fallback and lives in the frontend resolver
 * (frontend/src/lib/webLyrics.ts) — this endpoint never replaces it.
 *
 * Responses:
 *   200 { found: true, videoId, lines: [{time,text}], plain }
 *   404 { found: false }                       — no timed lyrics for this video
 *   400 { found: false, reason }               — invalid videoId
 *
 * Caching (bounded, per instance):
 *   - successful results: 24h (timed lyrics are static per video)
 *   - negative results:    1h (catalog gaps rarely fill quickly)
 *   - at most MAX_ENTRIES entries (FIFO eviction)
 *   - in-flight requests for the same videoId are coalesced
 */

const INNERTUBE_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const NEXT_URL = `https://music.youtube.com/youtubei/v1/next?alt=json&key=${INNERTUBE_KEY}`
const BROWSE_URL = `https://music.youtube.com/youtubei/v1/browse?alt=json&key=${INNERTUBE_KEY}`

const WEB_REMIX_CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00' }
const BROWSE_CLIENTS = [
  { clientName: 'ANDROID_MUSIC', clientVersion: '7.21.50' },
  { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00' },
  { clientName: 'ANDROID_MUSIC', clientVersion: '6.09.51' },
]

const UPSTREAM_TIMEOUT_MS = 8000
const MAX_ENTRIES = 500
const POSITIVE_TTL_MS = 24 * 3600 * 1000
const NEGATIVE_TTL_MS = 3600 * 1000

export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/

export interface TimedLine {
  time: number
  text: string
}

interface CacheEntry {
  exp: number
  status: number
  body: string
  hit: boolean
}

const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<CacheEntry>>()

function putCache(videoId: string, entry: CacheEntry): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (!oldest.done) cache.delete(oldest.value)
  }
  cache.set(videoId, entry)
}

/** Test hook: resets the module cache. */
export function __resetLyricsCache(): void {
  cache.clear()
  inflight.clear()
}

async function fetchJson(url: string, body: unknown, timeoutMs = UPSTREAM_TIMEOUT_MS): Promise<any | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function pageTypeOf(node: any): string | null {
  const ep = node?.browseEndpoint
  if (!ep) return null
  return (
    ep?.browseEndpointContextMusicConfig?.pageType ??
    ep?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType ??
    null
  )
}

function trackLyricsBrowseId(root: unknown): string | null {
  const stack: any[] = [root]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue
    if (node.browseEndpoint && pageTypeOf(node) === 'MUSIC_PAGE_TYPE_TRACK_LYRICS') {
      return node.browseEndpoint.browseId ?? null
    }
    for (const k of Object.keys(node)) {
      const v = (node as any)[k]
      if (Array.isArray(v)) {
        for (const el of v) stack.push(el)
      } else if (v && typeof v === 'object') {
        stack.push(v)
      }
    }
  }
  return null
}

/** Normalizes timedLyricsData to Melo's LyricLine shape; drops bad entries. */
export function normalizeTimedLines(root: unknown): TimedLine[] {
  const raw: { timeMs: number; text: string }[] = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const n = node as any
    const model = n.timedLyricsModel
    if (model?.lyricsData?.timedLyricsData) {
      for (const item of model.lyricsData.timedLyricsData) {
        const t = Number(item?.cueRange?.startTimeMilliseconds)
        const text = typeof item?.lyricLine === 'string' ? item.lyricLine : ''
        if (Number.isFinite(t) && t >= 0 && text.trim()) raw.push({ timeMs: t, text: text.trim() })
      }
      return
    }
    for (const k of Object.keys(n)) {
      const v = n[k]
      if (Array.isArray(v)) {
        for (const el of v) walk(el)
      } else if (v && typeof v === 'object') {
        walk(v)
      }
    }
  }
  walk(root)
  raw.sort((a, b) => a.timeMs - b.timeMs)
  return raw.map((l) => ({ time: l.timeMs / 1000, text: l.text }))
}

/**
 * Exact-video YTM timed lyrics. No search step: the videoId identifies the
 * recording, so a same-duration different song can never be substituted.
 */
export async function ytmTimedLyricsForVideo(videoId: string): Promise<{ lines: TimedLine[]; plain: string } | null> {
  const nextRes = await fetchJson(NEXT_URL, {
    context: { client: WEB_REMIX_CLIENT },
    videoId,
  })
  if (!nextRes) return null
  const browseId = trackLyricsBrowseId(nextRes)
  if (!browseId) return null
  for (const client of BROWSE_CLIENTS) {
    const browseRes = await fetchJson(BROWSE_URL, { context: { client }, browseId })
    if (!browseRes) continue
    const lines = normalizeTimedLines(browseRes)
    if (lines.length >= 2) {
      return { lines, plain: lines.map((l) => l.text).join('\n') }
    }
  }
  return null
}

function notFound(videoId: string): CacheEntry {
  return { exp: Date.now() + NEGATIVE_TTL_MS, status: 404, body: JSON.stringify({ found: false, videoId }), hit: false }
}

async function resolveVideo(videoId: string): Promise<CacheEntry> {
  const now = Date.now()
  const cached = cache.get(videoId)
  if (cached && cached.exp > now) {
    return { ...cached, hit: true }
  }
  if (cached) cache.delete(videoId)
  const ongoing = inflight.get(videoId)
  if (ongoing) return ongoing
  const job = (async (): Promise<CacheEntry> => {
    try {
      const ytm = await ytmTimedLyricsForVideo(videoId)
      if (ytm) {
        const entry: CacheEntry = {
          exp: Date.now() + POSITIVE_TTL_MS,
          status: 200,
          body: JSON.stringify({ found: true, videoId, lines: ytm.lines, plain: ytm.plain }),
          hit: false,
        }
        putCache(videoId, entry)
        return entry
      }
      const neg = notFound(videoId)
      putCache(videoId, neg)
      return neg
    } catch {
      return notFound(videoId)
    } finally {
      inflight.delete(videoId)
    }
  })()
  inflight.set(videoId, job)
  return job
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any): Promise<void> {
  let videoId = ''
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    videoId = url.searchParams.get('videoId') ?? ''
  } catch {
    videoId = ''
  }
  if (!VIDEO_ID_RE.test(videoId)) {
    res.status(400).json({ found: false, reason: 'invalid videoId' })
    return
  }
  const entry = await resolveVideo(videoId)
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('X-Cache', entry.hit ? 'HIT' : 'MISS')
  res.setHeader(
    'Cache-Control',
    entry.status === 200 ? 'public, s-maxage=86400, stale-while-revalidate=3600' : 'public, s-maxage=300',
  )
  res.status(entry.status).send(entry.body)
}
