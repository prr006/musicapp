import { useEffect, useRef, useState } from 'react'
import { YTPlayerHost } from '../audio/ytPlayer'
import { usePlayer } from '../state/playback'

/**
 * The docked home of the YouTube playback surface.
 *
 * The IFrame API's Player never reports onReady on a DETACHED element, so
 * the host container must live inside the document from before the first load.
 * This component is mounted once in the app shell at boot and keeps the
 * container attached at all times:
 *
 *   - The container lives inside a permanently mounted host element that is
 *     NEVER moved between DOM parents;
 *   - Visual repositioning (dock ↔ expanded) is handled entirely by CSS
 *     transitions on the host element;
 *   - While the expanded Now Playing is closed, the host appears as a small
 *     docked card (bottom-right, above the mini player);
 *   - When the expanded player opens, CSS repositions the same container
 *     into the artwork column — playback never restarts because the view
 *     changed, and the iframe's DOM parent never changes;
 *   - When it closes, CSS transitions the host back to the dock position.
 */
export function YTPlayerDock() {
  const outerRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<'dock' | 'expanded'>('dock')
  const hasTrack = usePlayer((s) => !!s.current)

  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    YTPlayerHost.get().setPermanentHost(el)
    const initialView = YTPlayerHost.get().view
    setView(initialView)
    // Set the initial data-view attribute on the outer dock element
    if (outerRef.current) outerRef.current.dataset.view = initialView
    return YTPlayerHost.get().onViewChange((v) => {
      setView(v)
      if (outerRef.current) outerRef.current.dataset.view = v
    })
  }, [])

  const isDocked = view === 'dock'

  return (
    <div ref={outerRef} className="yt-dock" data-active={isDocked && hasTrack ? 'true' : 'false'} aria-hidden={!(isDocked && hasTrack)}>
      <div ref={innerRef} className="yt-dock-inner" />
    </div>
  )
}

/**
 * The unobtrusive host for the YouTube playback surface inside the expanded
 * Now Playing view.
 *
 * The iframe is the legitimate playback provider's player — but in MELO it is
 * a detail of the expanded Now Playing view, not the product: a compact,
 * rounded video panel floating beneath the artwork, with the artwork,
 * metadata and lyrics remaining the primary visual elements. It is always
 * visible (never hidden or off-screen) and can be clicked to interact
 * directly, but it never competes with Melo's own controls.
 *
 * IMPORTANT: This component does NOT move the iframe between DOM parents.
 * The iframe lives in a permanently mounted host element registered by
 * <YTPlayerDock/>. This component only signals the host to switch its
 * visual mode (dock ↔ expanded) via CSS transitions.
 */
export function YTPlayerSurface({ videoId }: { videoId: string | null }) {
  const surfaceRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!videoId) {
      YTPlayerHost.get().setView('dock')
      return
    }
    // Signal the host to expand its visual mode. The host element handles
    // the CSS transition — no DOM movement occurs.
    YTPlayerHost.get().setView('expanded')
    // When this view unmounts (collapse/navigate), return to dock mode.
    return () => YTPlayerHost.get().setView('dock')
  }, [videoId])

  // Align the host element over this surface placeholder via CSS custom properties.
  useEffect(() => {
    if (!surfaceRef.current || !videoId) return
    if (typeof ResizeObserver === 'undefined') return
    // The host element is the .yt-dock div (always present in App.tsx).
    const dockEl = surfaceRef.current.closest('.yt-dock') as HTMLElement | null
      ?? document.querySelector('.yt-dock') as HTMLElement | null
    if (!dockEl) return
    const updatePosition = () => {
      const surfaceRect = surfaceRef.current?.getBoundingClientRect()
      if (!surfaceRect) return
      dockEl.style.setProperty('--yt-x', `${surfaceRect.left}px`)
      dockEl.style.setProperty('--yt-y', `${surfaceRect.top}px`)
      dockEl.style.setProperty('--yt-w', `${surfaceRect.width}px`)
      dockEl.style.setProperty('--yt-h', `${surfaceRect.height}px`)
    }
    updatePosition()
    const ro = new ResizeObserver(updatePosition)
    ro.observe(surfaceRef.current)
    window.addEventListener('resize', updatePosition)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', updatePosition)
    }
  }, [videoId])

  return (
    <div className="yt-surface" data-active={videoId ? 'true' : 'false'} aria-label="Playback video" ref={surfaceRef}>
      <div className="yt-surface-inner" />
      <div className="yt-surface-placeholder" aria-hidden="true" />
    </div>
  )
}