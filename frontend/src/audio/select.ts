/**
 * Chooses the playback provider for this environment.
 *
 * - Packaged app (Wails bindings present): the YouTube IFrame adapter, always.
 * - Browser dev (VITE_MELO_MOCK): prefer the real YouTube player — a browser
 *   with network access gets genuine playback — but fall back to the offline
 *   ClockAdapter when the IFrame API cannot be reached (CI, sandboxes), so
 *   the queue/autoplay experience stays testable offline.
 * - `?player=clock|youtube|audio` forces a provider in dev builds only.
 */
import type { AdapterChoice } from './adapter'
import { hasNativeBackend } from '../bridge/backend'
import { ClockAdapter } from './clockAdapter'
import { HtmlAudioAdapter } from './htmlAudioAdapter'
import { YouTubeIframeAdapter, loadYouTubeApi } from './youtubeAdapter'

const PROBE_TIMEOUT_MS = 5000

function forced(): string | null {
  if (import.meta.env.PROD) return null
  try {
    return new URLSearchParams(window.location.search).get('player')
  } catch {
    return null
  }
}

async function probeYouTube(timeoutMs: number): Promise<boolean> {
  try {
    await Promise.race([
      loadYouTubeApi(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ])
    return true
  } catch {
    return false
  }
}

export async function selectAdapter(): Promise<AdapterChoice> {
  const pick = forced()
  if (pick === 'clock') return { adapter: new ClockAdapter(), degraded: false }
  if (pick === 'audio') return { adapter: new HtmlAudioAdapter(), degraded: false }

  if (hasNativeBackend()) {
    // The packaged app always plays through the YouTube IFrame.
    return { adapter: new YouTubeIframeAdapter(), degraded: false }
  }

  // A browser deployment — the dev server, CI, or the public static site —
  // plays through the same real YouTube IFrame player as the packaged app.
  // Offline (no IFrame API), fall back to the silent transport so the UI,
  // queue, recommender and history flows stay honest and testable.
  if (await probeYouTube(PROBE_TIMEOUT_MS)) {
    return { adapter: new YouTubeIframeAdapter(), degraded: false }
  }
  return { adapter: new ClockAdapter(), degraded: true }
}
