import { useState } from 'react'
import { formatCount, displayArtist } from '../lib/format'
import { library } from '../state/libraryStore'
import { playback, usePlayer } from '../state/playback'
import { ui } from '../state/uiStore'
import { Artwork } from './Artwork'
import { CloseIcon, DownIcon, PlusIcon, RadioIcon, TrashIcon, UpIcon } from './Icons'
import { RepeatButton, ShuffleButton } from './MiniPlayer'
import { EmptyState } from './States'

/** How many autoplay suggestions are listed; the rest stay queued. */
const AUTOPLAY_VISIBLE = 10

const RADIO_SOURCE_LABELS: Record<string, string> = {
  'ytmusic-next': 'Based on this song',
  'yt-dlp-mix': 'Based on this song',
  'session-mix': 'Based on your session',
  'seed-artist': 'More from this artist',
  'fixture-radio': 'Fixture radio',
}

export function QueuePanel() {
  const queue = usePlayer((s) => s.queue)
  const index = usePlayer((s) => s.index)
  const autoQueue = usePlayer((s) => s.autoQueue)
  const contextLabel = usePlayer((s) => s.contextLabel)
  const radioSource = usePlayer((s) => s.radioSource)
  const status = usePlayer((s) => s.status)
  const current = usePlayer((s) => s.current)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')

  const upcoming = queue.slice(index + 1)
  // The queue, in the exact order the panel shows it: now playing, the user's
  // explicit choices, then MELO's autoplay suggestions.
  const visibleOrder = [...(current ? [current] : []), ...upcoming, ...autoQueue]

  const saveQueueAsPlaylist = () => {
    void library.createPlaylist(name || 'Queue', visibleOrder).then(() => {
      ui.toast('Queue saved as a playlist')
      setSaving(false)
      setName('')
    })
  }

  return (
    <aside className="panel" aria-label="Play queue">
      <div className="panel-head">
        <div>
          <h2>Queue</h2>
          {contextLabel && <div className="muted" style={{ fontSize: 12 }}>{contextLabel}</div>}
        </div>
        <div className="row" style={{ gap: 2 }}>
          <ShuffleButton />
          <RepeatButton />
          <button className="icon-btn" onClick={() => ui.toggleQueue(false)} aria-label="Close queue" type="button">
            <CloseIcon size={17} />
          </button>
        </div>
      </div>

      <div className="panel-body">
        {current && (
          <>
            <div className="queue-group-title">Now playing</div>
            <div className="track-row compact" data-current="true">
              <Artwork src={current.artwork} alt={current.title} style={{ width: 44, height: 44 }} />
              <div className="track-main">
                <div className="track-title">{current.title}</div>
                <div className="track-sub">{status === 'loading' ? 'Loading…' : displayArtist(current)}</div>
              </div>
            </div>
          </>
        )}

        <div className="queue-group-title">
          <span>Up next {upcoming.length > 0 && `· ${formatCount(upcoming.length, 'song')}`}</span>
          {upcoming.length > 0 && (
            <button className="link" onClick={() => playback.clearUpcoming()} type="button" style={{ color: 'var(--text-3)' }}>
              Clear
            </button>
          )}
        </div>

        {upcoming.length === 0 && autoQueue.length === 0 && (
          <EmptyState title="Nothing queued" message="Add songs with “Play next” or “Add to queue”. MELO radio keeps playing after them." />
        )}

        {upcoming.map((track, i) => {
          const queueIndex = index + 1 + i
          return (
            <div
              className="track-row compact"
              key={`${track.id}-${queueIndex}`}
              role="button"
              tabIndex={0}
              onClick={() => void playback.playQueueIndex(queueIndex)}
              onKeyDown={(e) => e.key === 'Enter' && void playback.playQueueIndex(queueIndex)}
            >
              <Artwork src={track.artwork} alt={track.title} style={{ width: 44, height: 44 }} />
              <div className="track-main">
                <div className="track-title">{track.title}</div>
                <div className="track-sub">{displayArtist(track) || 'Unknown artist'}</div>
              </div>
              <div className="track-end">
                <div className="row-actions">
                  <button
                    className="icon-btn sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      playback.reorderQueue(queueIndex, Math.max(index + 1, queueIndex - 1))
                    }}
                    aria-label="Move up"
                    type="button"
                  >
                    <UpIcon size={14} />
                  </button>
                  <button
                    className="icon-btn sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      playback.reorderQueue(queueIndex, Math.min(queue.length - 1, queueIndex + 1))
                    }}
                    aria-label="Move down"
                    type="button"
                  >
                    <DownIcon size={14} />
                  </button>
                  <button
                    className="icon-btn sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      playback.removeFromQueue(queueIndex)
                    }}
                    aria-label="Remove from queue"
                    type="button"
                  >
                    <CloseIcon size={14} />
                  </button>
                </div>
              </div>
            </div>
          )
        })}

        {autoQueue.length > 0 && (
          <>
            <div className="queue-group-title">
              <span className="row" style={{ gap: 6 }}>
                <RadioIcon size={13} /> Autoplay · MELO radio
                {radioSource && (
                  <span className="muted" style={{ fontSize: 11 }}>
                    {RADIO_SOURCE_LABELS[radioSource] ?? radioSource}
                  </span>
                )}
              </span>
              <button className="link" onClick={() => playback.clearAutoplay()} type="button" style={{ color: 'var(--text-3)' }}>
                Clear
              </button>
            </div>
            {autoQueue.slice(0, AUTOPLAY_VISIBLE).map((track, i) => (
              <div
                className="track-row compact"
                key={`auto-${track.id}`}
                role="button"
                tabIndex={0}
                onClick={() => void playback.playDiscovered(track)}
                onKeyDown={(e) => e.key === 'Enter' && void playback.playDiscovered(track)}
                style={{ opacity: 0.72 }}
              >
                <Artwork src={track.artwork} alt={track.title} style={{ width: 44, height: 44 }} />
                <div className="track-main">
                  <div className="track-title">{track.title}</div>
                  <div className="track-sub">{displayArtist(track) || 'Unknown artist'}</div>
                </div>
                <div className="track-end">
                  <button
                    className="icon-btn sm"
                    onClick={(e) => {
                      e.stopPropagation()
                      playback.removeFromAutoQueue(i)
                    }}
                    aria-label="Remove from autoplay"
                    type="button"
                  >
                    <CloseIcon size={14} />
                  </button>
                </div>
              </div>
            ))}
            {autoQueue.length > AUTOPLAY_VISIBLE && (
              <div className="muted" style={{ fontSize: 12, padding: '6px 10px' }}>
                + {formatCount(autoQueue.length - AUTOPLAY_VISIBLE, 'more song')} queued
              </div>
            )}
          </>
        )}
      </div>

      <div className="panel-foot">
        {saving ? (
          <form
            style={{ display: 'flex', gap: 8, width: '100%' }}
            onSubmit={(e) => {
              e.preventDefault()
              saveQueueAsPlaylist()
            }}
          >
            <input
              className="input"
              autoFocus
              value={name}
              placeholder="Playlist name"
              onChange={(e) => setName(e.target.value)}
              aria-label="Playlist name"
            />
            <button className="btn primary" type="submit">
              Save
            </button>
          </form>
        ) : (
          <>
            <button
              className="btn ghost"
              onClick={() => setSaving(true)}
              disabled={visibleOrder.length === 0}
              type="button"
              style={{ flex: 1 }}
            >
              <PlusIcon size={15} /> Save as playlist
            </button>
            <button
              className="btn ghost"
              onClick={() => playback.setQueue([])}
              disabled={queue.length === 0}
              aria-label="Clear queue"
              title="Clear queue"
              type="button"
            >
              <TrashIcon size={15} />
            </button>
          </>
        )}
      </div>
    </aside>
  )
}
