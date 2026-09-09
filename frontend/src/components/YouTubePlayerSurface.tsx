import { useEffect, useRef } from 'react'
import { isYouTubeIframeAdapter } from '../audio/youtubeIframe'
import { playback, usePlayer } from '../state/playback'

/**
 * Persistent, policy-compliant provider video for the web adapter. The 200px
 * viewport is intentionally the smallest supported presentation; it is never
 * hidden, cropped, covered, or used as an off-screen audio element. MELO owns
 * transport controls, while YouTube keeps its visible video/branding surface.
 */
export function YouTubePlayerSurface() {
  const hostRef = useRef<HTMLDivElement>(null)
  const current = usePlayer((state) => state.current)
  const status = usePlayer((state) => state.status)
  const adapter = isYouTubeIframeAdapter(playback.adapter) ? playback.adapter : null

  useEffect(() => {
    if (!adapter || !hostRef.current) return
    return adapter.mount(hostRef.current)
  }, [adapter])

  if (!adapter) return null

  return (
    <aside className="youtube-provider" aria-label="YouTube video providing playback">
      <div className="youtube-iframe-host" ref={hostRef} data-testid="youtube-iframe-host" />
      <div className="youtube-provider-meta">
        <span className={`youtube-provider-dot ${status}`} aria-hidden="true" />
        <span>{current ? `Video · ${current.title}` : 'YouTube playback video'}</span>
      </div>
    </aside>
  )
}
