import { SPEEDS } from '../lib/defaults'
import { displayArtist, formatTime } from '../lib/format'
import { library, useLibraryStore } from '../state/libraryStore'
import { playback, usePlayer } from '../state/playback'
import { useSleepTimerRemaining } from '../state/timerChannel'
import { ui, useUIStore } from '../state/uiStore'
import { Artwork } from './Artwork'
import { ChevronDown, HeartIcon, LyricsIcon, MoonIcon, QueueIcon, SpeedIcon, ThumbDownIcon } from './Icons'
import { LyricsPane } from './LyricsPane'
import { ProgressRow, TransportButtons, VolumeControl } from './MiniPlayer'

const SLEEP_PRESETS = [15, 30, 45, 60]

/** Live countdown readout. Isolated on timerChannel so its per-second updates
 *  never re-render the expanded player — mirroring the position channel. */
function SleepTimerStatus() {
  const remaining = useSleepTimerRemaining()
  if (remaining === null) return null
  return (
    <span className="muted" style={{ fontSize: 11.5, fontVariantNumeric: 'tabular-nums', minWidth: 38 }} aria-label="Sleep timer remaining">
      {formatTime(Math.ceil(remaining / 1000))}
    </span>
  )
}

export function NowPlaying() {
  const current = usePlayer((s) => s.current)
  const status = usePlayer((s) => s.status)
  const error = usePlayer((s) => s.error)
  const speed = usePlayer((s) => s.speed)
  const lyricsOpen = useUIStore((s) => s.lyricsOpen)
  const queueOpen = useUIStore((s) => s.queueOpen)
  const liked = useLibraryStore((s) => (current ? s.liked.some((t) => t.id === current.id) : false))
  const disliked = useLibraryStore((s) => (current ? s.disliked.some((t) => t.id === current.id) : false))
  const showLyrics = useLibraryStore((s) => s.settings.showLyrics)
  const sleepTimer = usePlayer((s) => s.sleepTimer)

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
                  {current.artist ? (
                    <button
                      type="button"
                      onClick={() => ui.navigate({ name: 'artist', artist: current.artist.split(',')[0].trim() })}
                    >
                      {displayArtist(current)}
                    </button>
                  ) : (
                    <span>{displayArtist(current) || 'Unknown artist'}</span>
                  )}
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
                  <button
                    className={`icon-btn ${disliked ? 'active' : ''}`}
                    onClick={() => void library.setDisliked(current, !disliked)}
                    aria-label={disliked ? 'Allow recommendations again' : 'Don’t recommend this song'}
                    aria-pressed={disliked}
                    title={disliked ? 'Allow recommendations again' : 'Don’t recommend this song'}
                    type="button"
                  >
                    <ThumbDownIcon size={18} filled={disliked} />
                  </button>
                  <TransportButtons />
                  <div className={`np-aux ${speed !== 1 ? 'active' : ''}`}>
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
                  <div className={`np-aux ${sleepTimer ? 'active' : ''}`}>
                    <MoonIcon size={16} />
                    <select
                      className="input"
                      style={{ width: 108, height: 32 }}
                      value={sleepTimer ? (sleepTimer.mode === 'endOfTrack' ? 'end' : String(sleepTimer.minutes)) : 'off'}
                      aria-label="Sleep timer"
                      onChange={(e) => {
                        const v = e.target.value
                        playback.setSleepTimer(v === 'off' ? null : v === 'end' ? 'endOfTrack' : Number(v))
                      }}
                    >
                      <option value="off">Sleep · Off</option>
                      {SLEEP_PRESETS.map((m) => (
                        <option key={m} value={m}>
                          {m} min
                        </option>
                      ))}
                      <option value="end">End of track</option>
                    </select>
                    <SleepTimerStatus />
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
