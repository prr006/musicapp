import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { activeLineIndex, sanitizeTimedLines, useLyricsStore } from '../state/lyricsStore'
import { playback, usePlayer } from '../state/playback'
import { usePosition } from '../state/positionChannel'
import { EmptyState, ErrorState } from './States'
import { LyricsIcon } from './Icons'

/**
 * How long manual scrolling suspends auto-follow before the pane quietly
 * returns to tracking the current line.
 */
const FOLLOW_RESUME_MS = 6000

/** A single usable timestamp is not a synced experience — fall back to plain. */
const MIN_TIMED_LINES = 2

/**
 * Lyrics follow the player's real position: this component subscribes to the
 * position channel only, computes the active line and scrolls it into view.
 * There is no independent lyric timer, so pause freezes it, seek jumps it and
 * speed changes cannot drift.
 *
 * Auto-scroll yields to the user: wheel/scrollbar/touch interaction suspends
 * following (so the pane never fights a reader), a pill offers an explicit
 * return to the current line, and following quietly resumes after a pause.
 */
export function LyricsPane() {
  const status = useLyricsStore((s) => s.status)
  const result = useLyricsStore((s) => s.result)
  const error = useLyricsStore((s) => s.error)
  const lyricsTrackId = useLyricsStore((s) => s.trackId)
  const currentId = usePlayer((s) => s.current?.id ?? null)
  const position = usePosition()
  const containerRef = useRef<HTMLDivElement>(null)
  const activeElRef = useRef<HTMLDivElement | null>(null)
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track the previous active index to detect actual line transitions.
  const prevActiveRef = useRef<number>(-1)

  const [following, setFollowing] = useState(true)

  const rawLines = result?.lines ?? []
  // Stale guard at render time: never show a previous track's lyrics.
  const matches = lyricsTrackId === currentId
  const timed = useMemo(() => (result?.synced ? sanitizeTimedLines(result.lines) : []), [result])
  const synced = matches && timed.length >= MIN_TIMED_LINES
  const active = synced ? activeLineIndex(timed, position, result?.offset ?? 0) : -1

  // A new track always starts following again; a stale timer from the previous
  // song must never scroll the next one.
  useEffect(() => {
    setFollowing(true)
    prevActiveRef.current = -1
    if (resumeTimer.current) {
      clearTimeout(resumeTimer.current)
      resumeTimer.current = null
    }
  }, [currentId])

  useEffect(
    () => () => {
      if (resumeTimer.current) clearTimeout(resumeTimer.current)
    },
    [],
  )

  /**
   * Callback ref: fires when the active line's DOM element mounts/unmounts.
   * This is more reliable than a conditional `ref={i === active ? activeRef : undefined}`
   * because it guarantees the ref is set at the exact right moment in the
   * React lifecycle — before effects run.
   */
  const setActiveEl = useCallback((el: HTMLDivElement | null) => {
    activeElRef.current = el
  }, [])

  /**
   * Scroll the active lyric line into view, centered in the container.
   *
   * IMPORTANT: We MUST NOT use scrollIntoView() because it scrolls ALL
   * scrollable ancestors — including overflow:hidden parents like .np-body,
   * .now-playing, .main, and body. This causes the entire NowPlaying layout
   * (and potentially the page) to shift when lyrics follow playback.
   *
   * Instead, we compute the target scrollTop for the lyrics container alone
   * using getBoundingClientRect geometry. This ensures ONLY the lyrics pane
   * scrolls — artwork, title, controls, and the page remain perfectly still.
   */
  const centerActive = useCallback(() => {
    const el = activeElRef.current
    const container = containerRef.current
    if (!el || !container) return

    const containerRect = container.getBoundingClientRect()
    const activeRect = el.getBoundingClientRect()
    const targetTop =
      container.scrollTop +
      (activeRect.top - containerRect.top) -
      container.clientHeight / 2 +
      activeRect.height / 2

    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' })
    } else {
      container.scrollTop = Math.max(0, targetTop)
    }
  }, [])

  // Auto-scroll only while following, and only when the active line changes —
  // position ticks alone never touch the scroller.
  // Using requestAnimationFrame ensures the DOM has painted the new ref before
  // we attempt to scroll to it.
  useEffect(() => {
    if (!following || active < 0) return
    if (active === prevActiveRef.current) return
    prevActiveRef.current = active
    requestAnimationFrame(() => centerActive())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, following])

  /** User took over the scroller: stop following, resume quietly later. */
  const suspendFollow = () => {
    if (resumeTimer.current) clearTimeout(resumeTimer.current)
    setFollowing(false)
    resumeTimer.current = setTimeout(() => {
      resumeTimer.current = null
      setFollowing(true)
    }, FOLLOW_RESUME_MS)
  }

  const resumeFollow = () => {
    if (resumeTimer.current) {
      clearTimeout(resumeTimer.current)
      resumeTimer.current = null
    }
    setFollowing(true)
    // When the user returns mid-line, `active` hasn't changed so the effect
    // above won't fire. Force a re-center.
    prevActiveRef.current = -1
    requestAnimationFrame(() => centerActive())
  }

  const seekToLine = (time: number) => {
    playback.seek(Math.max(0, time - (result?.offset ?? 0)))
    // Seeking via a lyric line is an intentional jump: follow it again.
    resumeFollow()
  }

  if (!currentId) {
    return <EmptyState icon={<LyricsIcon size={20} />} title="No song playing" message="Lyrics appear when playback starts." />
  }
  if (!matches || status === 'loading') {
    return (
      <div className="lyrics-pane" aria-busy="true">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="skeleton" style={{ height: 20, width: `${70 - i * 4}%`, marginBottom: 18 }} />
        ))}
      </div>
    )
  }
  if (status === 'error') {
    return <ErrorState title="Lyrics unavailable" message={error ?? 'The lyrics service could not be reached.'} />
  }
  if (status === 'empty' || !result) {
    return <EmptyState icon={<LyricsIcon size={20} />} title="No lyrics found" message="LRCLIB has no lyrics for this track yet." />
  }
  if (result.instrumental) {
    return <EmptyState icon={<LyricsIcon size={20} />} title="Instrumental" message="This track has no lyrics." />
  }

  // Claimed synced but the timing data is unusable (malformed / incomplete):
  // never pretend it is synced — show the words as plain lyrics instead.
  if (!synced) {
    const text = result.plain || rawLines.map((l) => l.text).filter(Boolean).join('\n')
    if (!text) {
      return <EmptyState icon={<LyricsIcon size={20} />} title="No lyrics found" message="The lyrics for this track had no usable text." />
    }
    return (
      <div className="lyrics-pane" ref={containerRef}>
        <p className="lyric-plain">{text}</p>
      </div>
    )
  }

  return (
    <div className="lyrics-wrap">
      <div
        className="lyrics-pane"
        ref={containerRef}
        aria-label="Synced lyrics"
        onWheel={suspendFollow}
        onTouchMove={suspendFollow}
        onKeyDown={(e) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
            suspendFollow()
          }
        }}
      >
        {timed.map((line, i) => (
          <div
            key={`${line.time}-${i}`}
            ref={i === active ? setActiveEl : undefined}
            className={`lyric-line ${i === active ? 'active' : ''} ${i < active ? 'passed' : ''}`}
            aria-current={i === active ? 'true' : undefined}
            onClick={() => seekToLine(line.time)}
            role="button"
            tabIndex={-1}
          >
            {line.text || '♪'}
          </div>
        ))}
        <div style={{ height: '40%' }} />
      </div>
      {!following && active >= 0 && (
        <button
          className="lyrics-follow-btn"
          onClick={resumeFollow}
          aria-label="Return to the current line"
          title="Return to the current line"
          type="button"
        >
          <LyricsIcon size={13} />
          <span>Current line</span>
        </button>
      )}
    </div>
  )
}
