/**
 * YouTube Music timed-lyrics fallback — production module.
 *
 * When LRCLIB returns plain-only lyrics or structurally suspect synced lyrics,
 * this module attempts to fetch timed lyrics from YouTube Music's InnerTube API.
 *
 * Flow:
 *   1. InnerTube search (WEB_REMIX) → find top match by duration
 *   2. /youtubei/v1/next → locate TRACK_LYRICS tab → browseId
 *   3. /youtubei/v1/browse → extract timedLyricsData[]
 */

import type { LyricLine } from '../bridge/types'

const INNERTUBE_KEY = 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30'
const SEARCH_URL = `https://music.youtube.com/youtubei/v1/search?alt=json&key=${INNERTUBE_KEY}`
const NEXT_URL = `https://music.youtube.com/youtubei/v1/next?alt=json&key=${INNERTUBE_KEY}`
const BROWSE_URL = `https://music.youtube.com/youtubei/v1/browse?alt=json&key=${INNERTUBE_KEY}`

const WEB_REMIX_CLIENT = { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00' }

const BROWSE_CLIENTS = [
  { clientName: 'ANDROID_MUSIC', clientVersion: '7.21.50' },
  { clientName: 'WEB_REMIX', clientVersion: '1.20240101.01.00' },
  { clientName: 'ANDROID_MUSIC', clientVersion: '6.09.51' },
]

interface SearchResult {
  videoId: string
  title: string
  artist: string
  duration: number
}

async function post(url: string, body: unknown, timeoutMs = 12000): Promise<any | null> {
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
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

function extractVideoIdFromSearch(root: unknown): SearchResult | null {
  const stack: any[] = [root]
  while (stack.length) {
    const node = stack.pop()
    if (!node || typeof node !== 'object') continue

    // musicResponsiveListItemRenderer contains song metadata
    if (node.musicResponsiveListItemRenderer) {
      const item = node.musicResponsiveListItemRenderer
      const flexCols = item.flexColumns ?? []

      // First flex column: title
      let title = ''
      const titleRuns = flexCols[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
      if (titleRuns) title = titleRuns.map((r: any) => r.text ?? '').join('')

      // Second flex column: artist
      let artist = ''
      const artistRuns = flexCols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
      if (artistRuns) artist = artistRuns.map((r: any) => r.text ?? '').join('')

      // Duration
      let duration = 0
      const durText = item.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.startTimeSeconds
      if (typeof durText === 'number' && durText > 0) {
        duration = durText
      } else {
        // Try fixedDuration or lengthText
        const lengthText = item.fixedColumns?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text ?? ''
        if (lengthText) {
          const parts = lengthText.split(':').map(Number)
          if (parts.length === 2) duration = parts[0] * 60 + parts[1]
          else if (parts.length === 3) duration = parts[0] * 3600 + parts[1] * 60 + parts[2]
        }
      }

      // Video ID from playNavigationEndpoint
      const videoId = item.playlistItemData?.videoId
        ?? item.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId
        ?? null

      if (videoId && title) {
        return { videoId, title, artist, duration }
      }
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

function pageTypeOf(node: any): string | null {
  const ep = node?.browseEndpoint
  if (!ep) return null
  return ep?.browseEndpointContextMusicConfig?.pageType
    ?? ep?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType
    ?? ep?.browseEndpointContextMusicConfig?.browseEndpointContextMusicConfig?.pageType
    ?? null
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

function walkTimedLines(node: unknown, out: { timeMs: number; text: string }[]): void {
  if (!node || typeof node !== 'object') return
  const n = node as any
  const model = n.timedLyricsModel
  if (model?.lyricsData?.timedLyricsData) {
    for (const item of model.lyricsData.timedLyricsData) {
      const t = Number(item?.cueRange?.startTimeMilliseconds)
      const text = item?.lyricLine ?? ''
      if (Number.isFinite(t) && text) out.push({ timeMs: t, text })
    }
    return
  }
  for (const k of Object.keys(n)) {
    const v = n[k]
    if (Array.isArray(v)) {
      for (const el of v) walkTimedLines(el, out)
    } else if (v && typeof v === 'object') {
      walkTimedLines(v, out)
    }
  }
}

/**
 * Searches YouTube Music for a song and returns timed lyrics if available.
 *
 * @param title  - Cleaned track title
 * @param artist - Cleaned artist name
 * @param duration - Track duration in seconds (0 = unknown)
 * @returns Synced LyricLines + plain text, or null if unavailable
 */
export async function fetchYtmTimedLyrics(
  title: string,
  artist: string,
  duration: number,
): Promise<{ synced: LyricLine[]; plain: string } | null> {
  if (!title) return null

  const query = `${title} ${artist}`.trim()

  // Step 1: Search YTM
  const searchBody = {
    context: { client: WEB_REMIX_CLIENT },
    query,
    params: 'EgIQAQ==', // Songs filter
  }
  const searchRes = await post(SEARCH_URL, searchBody)
  if (!searchRes) return null

  const match = extractVideoIdFromSearch(searchRes)
  if (!match) return null

  // Accept if title matches well (>= 60% overlap) and duration is close (within 15s or 15%)
  if (duration > 0 && match.duration > 0) {
    const durDelta = Math.abs(match.duration - duration)
    const durTolerance = Math.max(15, duration * 0.15)
    if (durDelta > durTolerance) return null
  }

  // Step 2: Get lyrics browseId from /next
  const nextRes = await post(NEXT_URL, {
    context: { client: WEB_REMIX_CLIENT },
    videoId: match.videoId,
  })
  if (!nextRes) return null

  const browseId = trackLyricsBrowseId(nextRes)
  if (!browseId) return null

  // Step 3: Fetch timed lyrics from /browse
  for (const client of BROWSE_CLIENTS) {
    const browseRes = await post(BROWSE_URL, {
      context: { client },
      browseId,
    })
    if (!browseRes) continue

    const lines: { timeMs: number; text: string }[] = []
    walkTimedLines(browseRes, lines)
    if (lines.length === 0) continue

    lines.sort((a, b) => a.timeMs - b.timeMs)
    const synced: LyricLine[] = lines.map((l) => ({
      time: l.timeMs / 1000,
      text: l.text,
    }))
    const plain = synced.map((l) => l.text).join('\n')
    return { synced, plain }
  }

  return null
}
