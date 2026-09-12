/**
 * Exact-video lyrics client for the MELO lyrics backend (GET /api/lyrics).
 *
 * The backend resolves YouTube Music timed lyrics for one exact videoId
 * server-side (browsers cannot call InnerTube directly — no CORS headers).
 * This module is the first step of the web resolver chain:
 *
 *   exact-video YTM (/api/lyrics) → LRCLIB (lib/webLyrics) → no lyrics
 *
 * Failures of any kind (endpoint missing, timeout, malformed payload, no
 * lyrics) reject so the caller falls back to LRCLIB. Only a strictly
 * validated payload with ≥2 timed lines resolves.
 */
import type { LyricLine } from '../bridge/types'

export interface ExactVideoLyrics {
  lines: LyricLine[]
  plain: string
}

const ENDPOINT_TIMEOUT_MS = 9000

function isValidLine(l: unknown): l is LyricLine {
  if (!l || typeof l !== 'object') return false
  const line = l as { time?: unknown; text?: unknown }
  return (
    typeof line.time === 'number' &&
    Number.isFinite(line.time) &&
    line.time >= 0 &&
    typeof line.text === 'string' &&
    line.text.trim().length > 0
  )
}

/**
 * Fetches normalized timed lyrics for one exact YouTube videoId.
 * Rejects on any failure so the resolver falls back to LRCLIB.
 */
export async function fetchExactVideoLyrics(
  videoId: string,
  timeoutMs = ENDPOINT_TIMEOUT_MS,
): Promise<ExactVideoLyrics> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`/api/lyrics?videoId=${encodeURIComponent(videoId)}`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`lyrics backend responded ${res.status}`)
    const data: unknown = await res.json()
    if (!data || typeof data !== 'object') throw new Error('malformed lyrics response')
    const body = data as { found?: unknown; videoId?: unknown; lines?: unknown; plain?: unknown }
    if (body.found !== true) throw new Error('no lyrics for this video')
    if (body.videoId !== videoId) throw new Error('videoId mismatch')
    if (!Array.isArray(body.lines) || body.lines.length < 2 || !body.lines.every(isValidLine)) {
      throw new Error('insufficient timed lines')
    }
    return {
      lines: body.lines.map((l) => ({ time: (l as LyricLine).time, text: (l as LyricLine).text })),
      plain: typeof body.plain === 'string' ? body.plain : body.lines.map((l) => (l as LyricLine).text).join('\n'),
    }
  } finally {
    clearTimeout(timer)
  }
}
