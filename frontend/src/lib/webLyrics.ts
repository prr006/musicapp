/**
 * Web lyrics client — LRCLIB (https://lrclib.net), CORS-open, no key.
 *
 * Lyrics are deliberately INDEPENDENT of playback: every failure mode here
 * (network down, no match, malformed timing) resolves to a well-defined
 * result and never touches the player.
 */
import type { LyricsQuery, LyricsResult } from '../bridge/types'

const LRCLIB_BASE = 'https://lrclib.net/api'

interface LrcLibHit {
  id: number
  trackName: string
  artistName: string
  albumName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

function cleanTitle(title: string): string {
  return (title || '')
    .replace(/\s*[\(\[](official|lyric[s]?|audio|video|visualizer|hd|4k|remaster(ed)?( [0-9]{4})?|.*(version|edit|mix)).*[\)\]]/gi, '')
    .replace(/\s*[-–—|].*$/, '') // "Artist - Song" tails from uploads
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanArtist(artist: string): string {
  return (artist || '').split(/,| & | feat\.? | ft\.? /i)[0]?.trim() ?? ''
}

/** Parses an LRC payload; drops malformed timing rather than trusting it. */
function parseLrc(lrc: string): { time: number; text: string }[] {
  const lines: { time: number; text: string }[] = []
  for (const raw of lrc.split('\n')) {
    const m = raw.match(/^\s*\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*(.*)$/)
    if (!m) continue
    const minutes = Number(m[1])
    const seconds = Number(m[2])
    const fraction = m[3] ? Number(`0.${m[3]}`) : 0
    const time = minutes * 60 + seconds + fraction
    if (!Number.isFinite(time) || time < 0) continue
    lines.push({ time, text: m[4].trim() })
  }
  lines.sort((a, b) => a.time - b.time)
  return lines
}

async function lrcFetch(path: string, timeoutMs = 10_000): Promise<LrcLibHit[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${LRCLIB_BASE}${path}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) return null
    const data = (await res.json()) as LrcLibHit[] | LrcLibHit
    clearTimeout(timer)
    return Array.isArray(data) ? data : [data]
  } catch {
    clearTimeout(timer)
    return null
  }
}

function bestMatch(hits: LrcLibHit[], duration: number): LrcLibHit | null {
  if (hits.length === 0) return null
  const scored = hits.map((hit) => {
    let score = 0
    if (hit.syncedLyrics) score += 3
    else if (hit.plainLyrics) score += 1
    if (duration > 0 && hit.duration && Math.abs(hit.duration - duration) < 8) score += 2
    return { hit, score }
  })
  scored.sort((a, b) => b.score - a.score)
  return scored[0].hit
}

export class LyricsNotFoundError extends Error {
  constructor() {
    super('No lyrics found.')
    this.name = 'LyricsNotFoundError'
  }
}

/** Fetches lyrics for a track; throws LyricsNotFoundError when none exist. */
export async function fetchWebLyrics(query: LyricsQuery): Promise<LyricsResult> {
  const title = cleanTitle(query.title)
  const artist = cleanArtist(query.artist)
  if (!title) throw new LyricsNotFoundError()

  // 1) precise query (title + artist) — best metadata match
  let hits = await lrcFetch(
    `/search?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist)}`,
  )
  let hit = bestMatch(hits ?? [], query.duration)

  // 2) relaxed query: title only
  if (!hit) {
    hits = await lrcFetch(`/search?track_name=${encodeURIComponent(title)}`)
    hit = bestMatch(hits ?? [], query.duration)
  }

  // 3) free-text query with everything we know
  if (!hit) {
    hits = await lrcFetch(`/search?q=${encodeURIComponent(`${title} ${artist}`.trim())}`)
    hit = bestMatch(hits ?? [], query.duration)
  }

  if (!hit) throw new LyricsNotFoundError()

  const synced = hit.syncedLyrics ? parseLrc(hit.syncedLyrics) : []
  if (!hit.plainLyrics && synced.length === 0) throw new LyricsNotFoundError()

  return {
    trackId: query.trackId,
    source: 'lrclib',
    synced: synced.length >= 2,
    lines: synced,
    plain: hit.plainLyrics ?? synced.map((l) => l.text).join('\n'),
    instrumental: !!hit.instrumental,
    offset: 0,
    matchedTitle: hit.trackName,
    matchedArtist: hit.artistName,
  }
}
