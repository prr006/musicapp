import { useEffect, useRef, useState } from 'react'
import { YTPlayerHost } from '../audio/ytPlayer'
import { usePlayer } from '../state/playback'

/**
 * The docked home of the YouTube playback surface.
 *
 * The IFrame API's Player never reports onReady on a DETACHED element, so the
 * host container must live inside the document from before the first load.
 * This component is mounted once in the app shell at boot and keeps the
 * container attached at all times:
 *
 *   - while the expanded Now Playing is closed, the container sits in this
 *     small, visible docked card (bottom-right, above the mini player);
 *   - when the expanded player opens, <YTPlayerSurface/> MOVES the same
 *     container (with its live iframe) into the artwork column — playback
 *     never restarts because the view changed;
 *   - when it closes, the surface returns here.
 *
 * The iframe is therefore never detached, never display:none and never
 * off-screen: it is always a real, visible element — compact while docked,
 * larger inside the expanded player. It is simply never the primary UI.
 */
export function YTPlayerDock() {
  const ref = useRef<HTMLDivElement>(null)
  const [docked, setDocked] = useState(false)
  const hasTrack = usePlayer((s) => !!s.current)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    YTPlayerHost.get().setDock(el)
    YTPlayerHost.get().attachTo(el)
    setDocked(YTPlayerHost.get().isDockedHere(el))
    const off = YTPlayerHost.get().onMove(() => setDocked(YTPlayerHost.get().isDockedHere(el)))
    return () => off()
  }, [])

  return (
    <div className="yt-dock" data-active={docked && hasTrack ? 'true' : 'false'} aria-hidden={!(docked && hasTrack)}>
      <div ref={ref} className="yt-dock-inner" />
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
 */
export function YTPlayerSurface({ videoId }: { videoId: string | null }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!hostRef.current) return
    // Moving the same container between parents preserves the live iframe —
    // playback never restarts because the view changed.
    YTPlayerHost.get().attachTo(hostRef.current)
    setVisible(true)
    // When this view unmounts (collapse/navigate), the surface must NOT end
    // up detached inside the removed node: it returns to the app-shell dock,
    // where it stays attached and visible for the whole page lifetime.
    return () => YTPlayerHost.get().attachToDock()
  }, [videoId])

  return (
    <div className="yt-surface" data-active={videoId ? 'true' : 'false'} aria-label="Playback video">
      <div className="yt-surface-inner" ref={hostRef} />
      {!visible && <div className="yt-surface-placeholder" aria-hidden="true" />}
    </div>
  )
}