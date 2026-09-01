import { SPEEDS } from '../lib/defaults'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback, usePlayer } from '../state/playback'
import { ui, useUIStore } from '../state/uiStore'
import { Artwork } from './Artwork'
import { ChevronDown, HeartIcon, LyricsIcon, QueueIcon, SpeedIcon } from './Icons'
import { LyricsPane } from './LyricsPane'
import { ProgressRow, TransportButtons, VolumeControl } from './MiniPlayer'

export function NowPlaying() {
  const current = usePlayer((s) => s.current)
  const status = usePlayer((s) => s.status)
  const error = usePlayer((s) => s.error)
  const speed = usePlayer((s) => s.speed)
  const lyricsOpen = useUIStore((s) => s.lyricsOpen)
  const queueOpen = useUIStore((s) => s.queueOpen)
  const liked = useLibraryStore((s) => (current ? s.liked.some((t) => t.id === current.id) : false))
  const showLyrics = useLibraryStore((s) => s.settings.showLyrics)

  const withLyrics = lyricsOpen && showLyrics

  return (
    <section className="now-playing" aria-label="Now playing">
      <div className="np-head">
        <button className="icon-btn" onClick={() => ui.toggleNowPlaying(false)} aria-label="Close now playing" type="button">
          <ChevronDown size={20} />
        </button>
        <div className="muted" style={{ fontSize: 12, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          {status === 'loading' ? 'Loading' : status === 'playing' ? 'Playing' : status === 'error' ? 'Error' : 'Paused'}
        </div>
        <div className="row">
          {showLyrics && (
            <button
              className={`icon-btn ${withLyrics ? 'active' : ''}`}
              onClick={() => ui.toggleLyrics(!lyricsOpen)}
              aria-label="Toggle lyrics"
              aria-pressed={withLyrics}
              title={withLyrics ? 'Hide lyrics (Y)' : 'Show lyrics (Y)'}
              type="button"
            >
              <LyricsIcon size={18} />
            </button>
          )}
          <button
            className={`icon-btn ${queueOpen ? 'active' : ''}`}
            onClick={() => ui.toggleQueue()}
            aria-label="Queue"
            aria-pressed={queueOpen}
            title="Queue (Q)"
            type="button"
          >
            <QueueIcon size={18} />
          </button>
        </div>
      </div>

      <div className={`np-body ${withLyrics ? '' : 'solo'}`}>
        <div className="np-art-col">
          {current ? (
            <>
              <Artwork
                src={current.artwork}
                alt={current.title}
                className={`np-art ${status === 'loading' ? 'skeleton' : ''}`}
              />
              <div>
                <h1 className="np-title">{current.title}</h1>
                <div className="np-artist">
                  <button
                    type="button"
                    onClick={() => ui.navigate({ name: 'artist', artist: current.artist.split(',')[0].trim() })}
                  >
                    {current.artist || 'Unknown artist'}
                  </button>
                  {current.album && (
                    <>
                      <span className="dot-sep" />
                      <button
                        type="button"
                        onClick={() =>
                          ui.navigate({
                            name: 'album',
                            key: `${current.album.toLowerCase()}|${current.artist.split(',')[0].trim().toLowerCase()}`,
                          })
                        }
                      >
                        {current.album}
                      </button>
                    </>
                  )}
                </div>
                {error && <div className="inline-error" style={{ marginTop: 14 }}>{error}</div>}
              </div>

              <div className="np-controls">
                <ProgressRow />
                <div className="np-buttons">
                  <button
                    className={`icon-btn ${liked ? 'active' : ''}`}
                    onClick={() => void library.toggleLike(current)}
                    aria-label={liked ? 'Unlike' : 'Like'}
                    aria-pressed={liked}
                    type="button"
                  >
                    <HeartIcon size={19} filled={liked} />
                  </button>
                  <TransportButtons />
                  <div className="row" style={{ position: 'relative' }}>
                    <SpeedIcon size={16} />
                    <select
                      className="input"
                      style={{ width: 76, height: 32 }}
                      value={speed}
                      aria-label="Playback speed"
                      onChange={(e) => playback.setSpeed(Number(e.target.value))}
                    >
                      {SPEEDS.map((s) => (
                        <option key={s} value={s}>
                          {s}×
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <VolumeControl />
                </div>
              </div>
            </>
          ) : (
            <div className="state">
              <h3>Nothing playing</h3>
              <p>Search for something and press play.</p>
            </div>
          )}
        </div>

        {withLyrics && <LyricsPane />}
      </div>
    </section>
  )
}
