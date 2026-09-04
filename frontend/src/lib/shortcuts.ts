import { useEffect } from 'react'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback, usePlayer } from '../state/playback'
import { ui } from '../state/uiStore'

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

/**
 * A focused scrubber owns its arrow keys (seek ±5s / volume ±5%). The global
 * handler must not re-apply them — otherwise one ArrowRight seeks twice (or
 * nudges the volume AND the playhead). Non-arrow shortcuts still apply.
 */
function isSliderTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || !el.closest) return false
  return !!el.closest('[role="slider"]')
}

/** Global shortcuts. They mirror the list shown in Settings. */
export function useKeyboardShortcuts(): void {
  const current = usePlayer((s) => s.current)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = isTypingTarget(e.target)
      const mod = e.ctrlKey || e.metaKey

      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        ui.navigate({ name: 'search' })
        window.dispatchEvent(new Event('melo:focus-search'))
        return
      }
      if (e.key === 'Escape') {
        ui.toggleQueue(false)
        ui.toggleNowPlaying(false)
        return
      }
      if (typing) return

      // The scrubber already handled plain arrows; modifiers (Ctrl/Cmd+arrow
      // = previous/next track) still fall through to the global handler.
      const onSlider = isSliderTarget(e.target)
      if (onSlider && (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'ArrowDown') && !mod) {
        return
      }

      if (mod && e.key === 'ArrowRight') {
        e.preventDefault()
        void playback.next()
        return
      }
      if (mod && e.key === 'ArrowLeft') {
        e.preventDefault()
        void playback.previous()
        return
      }
      if (mod) return

      switch (e.key) {
        case ' ':
          e.preventDefault()
          void playback.toggle()
          break
        case 'ArrowRight':
          e.preventDefault()
          playback.seekBy(5)
          break
        case 'ArrowLeft':
          e.preventDefault()
          playback.seekBy(-5)
          break
        case 'ArrowUp':
          e.preventDefault()
          playback.setVolume(Math.min(1, usePlayer.getState().volume + 0.05))
          break
        case 'ArrowDown':
          e.preventDefault()
          playback.setVolume(Math.max(0, usePlayer.getState().volume - 0.05))
          break
        default:
          break
      }

      switch (e.key.toLowerCase()) {
        case 'm':
          playback.toggleMute()
          break
        case 's':
          playback.toggleShuffle()
          break
        case 'r':
          playback.cycleRepeat()
          break
        case 'l':
          if (current) void library.toggleLike(current)
          break
        case 'q':
          ui.toggleQueue()
          break
        case 'y':
          if (useLibraryStore.getState().settings.showLyrics) ui.toggleLyrics()
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current])
}
