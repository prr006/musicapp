import { useEffect, useMemo, useRef, useState } from 'react'
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
  const activeRef = useRef<HTMLDivElement>(null)
  const resumeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  /** jsdom has no Element.scrollTo — fall back to scrollTop so tests pass. */
  const centerActive = () => {
    const el = activeRef.current
    const container = containerRef.current
    if (!el || !container) return
    const top = Math.max(0, el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2)
    if (typeof container.scrollTo === 'function') container.scrollTo({ top, behavior: 'smooth' })
    else container.scrollTop = top
  }

  // Auto-scroll only while following, and only when the active line changes —
  // position ticks alone never touch the scroller.
  useEffect(() => {
    if (!following || active < 0) return
    centerActive()
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
    // The effect above only re-centers when `active` changes; when the user
    // returns mid-line the index is unchanged, so center explicitly.
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
        onPointerDown={suspendFollow}
        onKeyDown={(e) => {
          // Keyboard scrolling through the pane is also the user taking over.
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(e.key)) {
            suspendFollow()
          }
        }}
      >
        {timed.map((line, i) => (
          <div
            key={`${line.time}-${i}`}
            ref={i === active ? activeRef : undefined}
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
