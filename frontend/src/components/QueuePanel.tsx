import { useState } from 'react'
import { formatCount } from '../lib/format'
import { library } from '../state/libraryStore'
import { playback, usePlayer } from '../state/playback'
import { ui } from '../state/uiStore'
import { Artwork } from './Artwork'
import { CloseIcon, DownIcon, PlusIcon, TrashIcon, UpIcon } from './Icons'
import { EmptyState } from './States'

export function QueuePanel() {
  const queue = usePlayer((s) => s.queue)
  const index = usePlayer((s) => s.index)
  const autoQueue = usePlayer((s) => s.autoQueue)
  const contextLabel = usePlayer((s) => s.contextLabel)
  const status = usePlayer((s) => s.status)
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')

  const upcoming = queue.slice(index + 1)
  const current = index >= 0 ? queue[index] : null

  return (
    <aside className="panel" aria-label="Play queue">
      <div className="panel-head">
        <div>
          <h2>Queue</h2>
          {contextLabel && <div className="muted" style={{ fontSize: 12 }}>{contextLabel}</div>}
        </div>
        <button className="icon-btn" onClick={() => ui.toggleQueue(false)} aria-label="Close queue" type="button">
          <CloseIcon size={17} />
        </button>
      </div>

      <div className="panel-body">
        {current && (
          <>
            <div className="queue-group-title">Now playing</div>
            <div className="track-row compact" data-current="true">
              <Artwork src={current.artwork} alt={current.title} style={{ width: 44, height: 44 }} />
              <div className="track-main">
                <div className="track-title">{current.title}</div>
                <div className="track-sub">{status === 'loading' ? 'Loading…' : current.artist}</div>
              </div>
            </div>
          </>
        )}

        <div className="queue-group-title">
          <span>Next up {upcoming.length > 0 && `· ${formatCount(upcoming.length, 'song')}`}</span>
          {upcoming.length > 0 && (
            <button className="link" onClick={() => playback.clearUpcoming()} type="button" style={{ color: 'var(--text-3)' }}>
              Clear
            </button>
          )}
        </div>

        {upcoming.length === 0 && autoQueue.length === 0 && (
          <EmptyState title="Nothing queued" message="Add songs with “Play next” or “Add to queue”." />
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
                <div className="track-sub">{track.artist}</div>
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
              <span>Autoplay · based on your listening</span>
              <button className="link" onClick={() => playback.clearAutoplay()} type="button" style={{ color: 'var(--text-3)' }}>
                Clear
              </button>
            </div>
            {autoQueue.slice(0, 10).map((track) => (
              <div
                className="track-row compact"
                key={`auto-${track.id}`}
                role="button"
                tabIndex={0}
                onClick={() => void playback.play(track)}
                onKeyDown={(e) => e.key === 'Enter' && void playback.play(track)}
                style={{ opacity: 0.72 }}
              >
                <Artwork src={track.artwork} alt={track.title} style={{ width: 44, height: 44 }} />
                <div className="track-main">
                  <div className="track-title">{track.title}</div>
                  <div className="track-sub">{track.artist}</div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      <div className="panel-foot">
        {saving ? (
          <form
            style={{ display: 'flex', gap: 8, width: '100%' }}
            onSubmit={(e) => {
              e.preventDefault()
              void library.createPlaylist(name || 'Queue', queue).then(() => {
                ui.toast('Queue saved as a playlist')
                setSaving(false)
                setName('')
              })
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
              disabled={queue.length === 0}
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
