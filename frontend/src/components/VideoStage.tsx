/**
 * VideoStage — where the YouTube player lives in MELO's UI.
 *
 * The adapter (audio/youtubeAdapter.ts) owns one persistent stage node holding
 * the embedded player. This module docks that node into the UI:
 *
 *   - Now Playing open   → the video *is* the artwork. One presentation, no
 *                          second player tile competing with it.
 *   - Now Playing closed → the video shrinks into a small dock attached to
 *                          the player bar (the YouTube Music mini-player
 *                          pattern), always visible, never hidden.
 *
 * The stage is never re-created or moved in the DOM (which would reload the
 * video); it is only repositioned with fixed coordinates. While a player
 * exists it is always on-screen and at least 200×200px — the embedded
 * player's documented minimum. When playback is stopped the adapter destroys
 * the player entirely, so there is never a hidden idle iframe.
 */
import { useEffect, useRef, useState } from 'react'
import { playback } from '../state/playback'
import { usePlayerStore } from '../state/playerStore'
import { ui, useUIStore } from '../state/uiStore'
import { ChevronDown } from './Icons'

interface SlotEntry {
  el: HTMLElement
  priority: number
}

const slots = new Map<string, SlotEntry>()

function registerSlot(id: string, el: HTMLElement, priority: number): void {
  slots.set(id, { el, priority })
}

function unregisterSlot(id: string): void {
  slots.delete(id)
}

/**
 * A positioning target for the video surface. Renders nothing itself — it
 * marks the box the adapter's stage should occupy.
 */
export function VideoSlot({
  slotId,
  className = '',
  priority = 0,
}: {
  slotId: string
  className?: string
  priority?: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    registerSlot(slotId, el, priority)
    return () => unregisterSlot(slotId)
  }, [slotId, priority])
  return <div ref={ref} className={`video-slot ${className}`} data-video-slot={slotId} aria-hidden="true" />
}

/**
 * The single dock owner. Rendered once at app level. It positions the
 * adapter's stage over whichever slot is active, and shows the mini video
 * dock when Now Playing is closed.
 */
export function VideoDock() {
  const current = usePlayerStore((s) => s.current)
  const nowPlayingOpen = useUIStore((s) => s.nowPlayingOpen)
  const queueOpen = useUIStore((s) => s.queueOpen)
  const [surface, setSurface] = useState<HTMLElement | null>(null)
  const miniRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let raf = 0

    const apply = () => {
      raf = 0
      const stage = playback.adapter.videoSurface
      setSurface((prev) => (prev === stage ? prev : stage))
      if (!stage) return
      const { nowPlayingOpen: npOpen } = useUIStore.getState()
      const npSlot = slots.get('np')?.el ?? null
      const target = npOpen && npSlot ? npSlot : miniRef.current
      if (!target) return
      const rect = target.getBoundingClientRect()
      if (rect.width < 10 || rect.height < 10) return
      const s = stage.style
      s.left = `${rect.left}px`
      s.top = `${rect.top}px`
      s.width = `${rect.width}px`
      s.height = `${rect.height}px`
      let radius = '14px'
      try {
        const computed = getComputedStyle(target).borderRadius
        if (computed && computed !== 'auto') radius = computed
      } catch {
        /* keep default */
      }
      s.borderRadius = radius
    }

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(apply)
    }
    // Store changes move the dock target immediately (and again after the
    // layout settles — React commits after subscribe fires).
    const onStoreChange = () => {
      schedule()
      setTimeout(apply, 60)
      setTimeout(apply, 320)
    }

    const interval = setInterval(apply, 250)
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    const unsubUi = useUIStore.subscribe(onStoreChange)
    const unsubPlayer = usePlayerStore.subscribe(onStoreChange)
    apply()

    return () => {
      clearInterval(interval)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      unsubUi()
      unsubPlayer()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])

  const showMini = !!surface && !!current && !nowPlayingOpen
  if (!showMini) return null

  return (
    <div
      className="video-dock"
      ref={miniRef}
      style={{ right: queueOpen ? 396 : 20 }}
      onClick={() => ui.toggleNowPlaying(true)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => e.key === 'Enter' && ui.toggleNowPlaying(true)}
      aria-label="Open Now Playing"
      title="Open Now Playing"
    >
      <div className="video-dock-head">
        <span className="video-dock-label">Now playing</span>
        <ChevronDown size={14} />
      </div>
      <div className="video-dock-slot" />
    </div>
  )
}
