import { useState } from 'react'
import { displayArtist, formatTime } from '../lib/format'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback, usePlayer } from '../state/playback'
import { useBuffered, useDuration, usePosition } from '../state/positionChannel'
import { ui, useUIStore } from '../state/uiStore'
import { Artwork } from './Artwork'
import {
  ChevronDown, HeartIcon, LyricsIcon, NextIcon, PauseIcon, PlayIcon, PrevIcon,
  QueueIcon, RepeatIcon, RepeatOneIcon, ShuffleIcon, StopIcon, VolumeIcon,
} from './Icons'
import { Scrubber } from './Scrubber'

/**
 * Only this component re-renders on position ticks. The right-hand readout
 * shows the total duration; hovering, focusing or clicking it flips to the
 * remaining time so both are available without adding a second row.
 */
function ProgressRow({ compact = false }: { compact?: boolean }) {
  const position = usePosition()
  const duration = useDuration()
  const buffered = useBuffered()
  const [preview, setPreview] = useState<number | null>(null)
  const [hovered, setHovered] = useState(false)
  const [pinnedRemaining, setPinnedRemaining] = useState(false)
  const disabled = usePlayer((s) => !s.current)
  const shown = preview ?? position
  const showRemaining = duration > 0 && (hovered || pinnedRemaining)
  const rightLabel = duration > 0
    ? showRemaining
      ? `−${formatTime(Math.max(0, duration - shown))}`
      : formatTime(duration)
    : '--:--'

  return (
    <div className="scrubber-row">
      <span className="time">{formatTime(shown)}</span>
      <Scrubber
        value={shown}
        max={duration}
        buffered={buffered}
        disabled={disabled || duration <= 0}
        ariaLabel="Seek"
        onChange={(v) => playback.seek(v)}
        onPreview={setPreview}
      />
      <span
        className={`time time-toggle ${showRemaining ? 'remaining' : ''}`}
        title={duration > 0 ? (showRemaining ? 'Show total duration' : 'Show time remaining') : undefined}
        tabIndex={duration > 0 ? 0 : -1}
        aria-label={duration > 0 ? (showRemaining ? 'Time remaining' : 'Total duration') : 'Duration unknown'}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        onClick={() => setPinnedRemaining((p) => !p)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setPinnedRemaining((p) => !p)
          }
        }}
      >
        {rightLabel}
      </span>
      {compact && null}
    </div>
  )
}

function VolumeControl() {
  const volume = usePlayer((s) => s.volume)
  const muted = usePlayer((s) => s.muted)
  const level = muted || volume === 0 ? 0 : volume < 0.5 ? 1 : 2

  return (
    <div className="volume">
      <button
        className="icon-btn"
        onClick={() => playback.toggleMute()}
        aria-label={muted ? 'Unmute' : 'Mute'}
        aria-pressed={muted}
        title={muted ? 'Unmute (M)' : 'Mute (M)'}
        type="button"
      >
        <VolumeIcon size={18} level={level} />
      </button>
      <Scrubber
        value={muted ? 0 : volume}
        max={1}
        step={0.05}
        ariaLabel="Volume"
        onChange={(v) => playback.setVolume(v)}
      />
    </div>
  )
}

export function ShuffleButton() {
  const shuffle = usePlayer((s) => s.shuffle)
  return (
    <button
      className={`icon-btn ${shuffle ? 'active' : ''}`}
      onClick={() => playback.toggleShuffle()}
      aria-label="Shuffle"
      aria-pressed={shuffle}
      title={`Shuffle ${shuffle ? 'on' : 'off'} (S)`}
      type="button"
    >
      <ShuffleIcon size={17} />
    </button>
  )
}

export function RepeatButton() {
  const repeat = usePlayer((s) => s.repeat)
  const label = repeat === 'one' ? 'Repeat one' : repeat === 'all' ? 'Repeat all' : 'Repeat off'
  return (
    <button
      className={`icon-btn ${repeat !== 'off' ? 'active' : ''}`}
      onClick={() => playback.cycleRepeat()}
      aria-label={label}
      title={`${label} (R)`}
      type="button"
    >
      {repeat === 'one' ? <RepeatOneIcon size={17} /> : <RepeatIcon size={17} />}
    </button>
  )
}

export function PlayButton({ size = 40 }: { size?: number }) {
  const status = usePlayer((s) => s.status)
  const hasTrack = usePlayer((s) => !!s.current)
  const loading = status === 'loading'

  return (
    <button
      className={`play-btn ${loading ? 'loading' : ''}`}
      style={{ width: size, height: size }}
      onClick={() => void playback.toggle()}
      disabled={!hasTrack}
      aria-label={status === 'playing' ? 'Pause' : 'Play'}
      title={status === 'playing' ? 'Pause (Space)' : 'Play (Space)'}
      type="button"
    >
      {loading ? (
        <span className="spinner" />
      ) : status === 'playing' ? (
        <PauseIcon size={size * 0.45} />
      ) : (
        <PlayIcon size={size * 0.45} />
      )}
    </button>
  )
}

export function TransportButtons() {
  const hasTrack = usePlayer((s) => !!s.current)
  return (
    <div className="transport">
      <ShuffleButton />
      <button
        className="icon-btn"
        onClick={() => void playback.previous()}
        disabled={!hasTrack}
        aria-label="Previous"
        title="Previous (Ctrl+Left)"
        type="button"
      >
        <PrevIcon size={19} />
      </button>
      <PlayButton />
      <button
        className="icon-btn"
        onClick={() => void playback.next()}
        disabled={!hasTrack}
        aria-label="Next"
        title="Next (Ctrl+Right)"
        type="button"
      >
        <NextIcon size={19} />
      </button>
      <RepeatButton />
    </div>
  )
}

export function MiniPlayer() {
  const current = usePlayer((s) => s.current)
  const status = usePlayer((s) => s.status)
  const error = usePlayer((s) => s.error)
  const liked = useLibraryStore((s) => (current ? s.liked.some((t) => t.id === current.id) : false))
  const queueOpen = useUIStore((s) => s.queueOpen)
  const npOpen = useUIStore((s) => s.nowPlayingOpen)

  return (
    <div className="player player-bar">
      <div className="player-track">
        {current ? (
          <>
            <Artwork
              src={current.artwork}
              alt={current.title}
              style={{ width: 56, height: 56 }}
              className={status === 'loading' ? 'skeleton' : ''}
            />
            <div className="player-meta">
              <div
                className="player-title"
                onClick={() => ui.toggleNowPlaying(true)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === 'Enter' && ui.toggleNowPlaying(true)}
              >
                {current.title}
              </div>
              <div className="player-artist">
                {status === 'loading' ? 'Loading…' : error ? error : displayArtist(current) || 'Unknown artist'}
              </div>
            </div>
            <button
              className={`icon-btn ${liked ? 'active' : ''}`}
              onClick={() => void library.toggleLike(current)}
              aria-label={liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
              aria-pressed={liked}
              title="Like (L)"
              type="button"
            >
              <HeartIcon size={17} filled={liked} />
            </button>
          </>
        ) : (
          <div className="player-meta">
            <div className="player-title" style={{ color: 'var(--text-3)' }}>
              Nothing playing
            </div>
            <div className="player-artist">Pick a song to get started</div>
          </div>
        )}
      </div>

      <div className="player-center">
        <TransportButtons />
        <ProgressRow />
      </div>

      <div className="player-right">
        <button
          className="icon-btn"
          onClick={() => playback.stop()}
          disabled={!current}
          aria-label="Stop"
          title="Stop"
          type="button"
        >
          <StopIcon size={15} />
        </button>
        <button
          className={`icon-btn ${npOpen ? 'active' : ''}`}
          onClick={() => ui.toggleLyrics(true)}
          aria-label="Lyrics"
          title="Lyrics (Y)"
          type="button"
        >
          <LyricsIcon size={17} />
        </button>
        <button
          className={`icon-btn ${queueOpen ? 'active' : ''}`}
          onClick={() => ui.toggleQueue()}
          aria-label="Queue"
          aria-pressed={queueOpen}
          title="Queue (Q)"
          type="button"
        >
          <QueueIcon size={17} />
        </button>
        <VolumeControl />
        <button
          className="icon-btn"
          onClick={() => ui.toggleNowPlaying(!npOpen)}
          aria-label={npOpen ? 'Close now playing' : 'Open now playing'}
          title="Now playing"
          type="button"
          style={{ transform: npOpen ? 'none' : 'rotate(180deg)' }}
        >
          <ChevronDown size={17} />
        </button>
      </div>
    </div>
  )
}

export { ProgressRow, VolumeControl }
