import { useEffect, useMemo, useRef } from 'react'
import { activeLineIndex, useLyricsStore } from '../state/lyricsStore'
import { playback, usePlayer } from '../state/playback'
import { usePosition } from '../state/positionChannel'
import { EmptyState, ErrorState } from './States'
import { LyricsIcon } from './Icons'

/**
 * Lyrics follow the player's real position: this component subscribes to the
 * position channel only, computes the active line and scrolls it into view.
 * There is no independent lyric timer, so pause freezes it, seek jumps it and
 * speed changes cannot drift.
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

  const lines = useMemo(() => result?.lines ?? [], [result])
  // Stale guard at render time: never show a previous track's lyrics.
  const matches = lyricsTrackId === currentId
  const active = matches && result?.synced ? activeLineIndex(lines, position, result.offset) : -1

  useEffect(() => {
    const el = activeRef.current
    const container = containerRef.current
    if (!el || !container) return
    const top = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2
    container.scrollTo({ top, behavior: 'smooth' })
  }, [active])

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
  if (!result.synced) {
    return (
      <div className="lyrics-pane" ref={containerRef}>
        <p className="lyric-plain">{result.plain}</p>
      </div>
    )
  }

  return (
    <div className="lyrics-pane" ref={containerRef} aria-label="Synced lyrics">
      {lines.map((line, i) => (
        <div
          key={`${line.time}-${i}`}
          ref={i === active ? activeRef : undefined}
          className={`lyric-line ${i === active ? 'active' : ''} ${i < active ? 'passed' : ''}`}
          onClick={() => playback.seek(Math.max(0, line.time - (result.offset ?? 0)))}
          role="button"
          tabIndex={-1}
        >
          {line.text || '♪'}
        </div>
      ))}
      <div style={{ height: '40%' }} />
    </div>
  )
}
