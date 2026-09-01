import { memo, useState } from 'react'
import type { Track } from '../bridge/types'
import { formatTime } from '../lib/format'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback, usePlayer } from '../state/playback'
import { Artwork } from './Artwork'
import { HeartIcon, MoreIcon, PlayIcon, PlusIcon } from './Icons'
import { TrackMenu } from './TrackMenu'

interface Props {
  track: Track
  index?: number
  showAlbum?: boolean
  compact?: boolean
  onPlay: () => void
  menuExtra?: { label: string; onSelect: () => void; danger?: boolean }[]
  trailing?: React.ReactNode
}

/**
 * A single row. One click on the row plays the track; the trailing buttons are
 * independent controls and never trigger playback (their handlers stop
 * propagation explicitly).
 */
export const TrackRow = memo(function TrackRow({
  track,
  index,
  showAlbum = true,
  compact = false,
  onPlay,
  menuExtra,
  trailing,
}: Props) {
  const liked = useLibraryStore((s) => s.liked.some((t) => t.id === track.id))
  const isCurrent = usePlayer((s) => s.current?.id === track.id)
  const status = usePlayer((s) => (s.current?.id === track.id ? s.status : 'idle'))
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    fn()
  }

  return (
    <>
      <div
        className={`track-row ${compact ? 'compact' : ''}`}
        data-current={isCurrent}
        role="button"
        tabIndex={0}
        onClick={onPlay}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onPlay()
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
        aria-label={`Play ${track.title} by ${track.artist}`}
      >
        {!compact && index !== undefined && (
          <div className="track-index">
            <span className="num">{index + 1}</span>
            <span className="glyph">
              {isCurrent && status === 'playing' ? (
                <span className="equalizer" aria-label="Now playing">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <PlayIcon size={13} />
              )}
            </span>
          </div>
        )}
        <Artwork src={track.artwork} alt={track.title} style={{ width: 44, height: 44 }} />
        <div className="track-main">
          <div className="track-title">
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.title}</span>
            {track.explicit && <span className="badge">E</span>}
            {isCurrent && status === 'loading' && <span className="spinner" aria-label="Loading" />}
          </div>
          <div className="track-sub">{track.artist || 'Unknown artist'}</div>
        </div>
        {!compact && showAlbum && <div className="track-album">{track.album}</div>}
        <div className="track-end">
          <div className="row-actions">
            <button
              className={`icon-btn sm ${liked ? 'active' : ''}`}
              onClick={stop(() => void library.toggleLike(track))}
              aria-label={liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
              aria-pressed={liked}
              title={liked ? 'Liked' : 'Like'}
              type="button"
            >
              <HeartIcon size={15} filled={liked} />
            </button>
            <button
              className="icon-btn sm"
              onClick={stop(() => playback.addToQueue([track]))}
              aria-label="Add to queue"
              title="Add to queue"
              type="button"
            >
              <PlusIcon size={15} />
            </button>
            <button
              className="icon-btn sm"
              onClick={stop(() => setMenu({ x: 0, y: 0 }))}
              onMouseDown={(e) => {
                e.stopPropagation()
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                setMenu({ x: rect.left - 190, y: rect.bottom + 6 })
              }}
              aria-label="More options"
              aria-haspopup="menu"
              title="More"
              type="button"
            >
              <MoreIcon size={15} />
            </button>
          </div>
          {trailing}
          {track.duration > 0 && <span>{formatTime(track.duration)}</span>}
        </div>
      </div>
      {menu && <TrackMenu track={track} anchor={menu} onClose={() => setMenu(null)} extra={menuExtra} />}
    </>
  )
})
