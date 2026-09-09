import type { PlaybackAdapter } from './adapter'
import { ResolvedUrlPlaybackAdapter } from './resolvedUrlAdapter'
import { createYouTubeIframeAdapter, youtubeIframeSpikeEnabled } from './youtubeIframe'

/** Composition root: queue/state code receives one transport-agnostic adapter. */
export function createPlaybackAdapter(): PlaybackAdapter {
  return youtubeIframeSpikeEnabled()
    ? createYouTubeIframeAdapter()
    : new ResolvedUrlPlaybackAdapter()
}
