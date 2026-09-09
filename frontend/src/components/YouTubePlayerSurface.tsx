import { useEffect, useRef, useState } from 'react'
import type { Track } from '../bridge/types'
import { isYouTubeIframeAdapter } from '../audio/youtubeIframe'
import { playback, usePlayer } from '../state/playback'

export const IFRAME_SPIKE_TRACKS: Track[] = [
  {
    id: 'yt:Kx7B-XvmFtE', sourceId: 'Kx7B-XvmFtE', source: 'youtube', url: '',
    title: 'Believer', artist: 'Imagine Dragons', album: 'Evolve',
    artwork: 'https://i.ytimg.com/vi/Kx7B-XvmFtE/hqdefault.jpg', duration: 204, explicit: false,
  },
  {
    id: 'yt:9ssQKlLxBdQ', sourceId: '9ssQKlLxBdQ', source: 'youtube', url: '',
    title: 'Thunder', artist: 'Imagine Dragons', album: 'Evolve',
    artwork: 'https://i.ytimg.com/vi/9ssQKlLxBdQ/hqdefault.jpg', duration: 187, explicit: false,
  },
  {
    id: 'yt:J1aVXLHQRd4', sourceId: 'J1aVXLHQRd4', source: 'youtube', url: '',
    title: 'Demons', artist: 'Imagine Dragons', album: 'Night Visions',
    artwork: 'https://i.ytimg.com/vi/J1aVXLHQRd4/hqdefault.jpg', duration: 177, explicit: false,
  },
]

/**
 * Policy-compliant mount for the spike transport: the official player remains
 * visible, uncovered and large enough for native video controls at all times.
 */
export function YouTubePlayerSurface() {
  const hostRef = useRef<HTMLDivElement>(null)
  const current = usePlayer((state) => state.current)
  const [lastEvent, setLastEvent] = useState('waiting for player')
  const [playingEvents, setPlayingEvents] = useState(0)
  const [embedErrors, setEmbedErrors] = useState(0)
  const adapter = isYouTubeIframeAdapter(playback.adapter) ? playback.adapter : null

  useEffect(() => {
    if (!adapter || !hostRef.current) return
    const unmount = adapter.mount(hostRef.current)
    const unsubscribe = adapter.subscribe((event) => {
      if (event.type === 'state') {
        setLastEvent(`state:${event.snapshot.status}`)
        if (event.snapshot.status === 'playing') setPlayingEvents((count) => count + 1)
      } else {
        setLastEvent(event.type)
        if (event.type === 'error') setEmbedErrors((count) => count + 1)
      }
    })
    return () => {
      unsubscribe()
      unmount()
    }
  }, [adapter])

  if (!adapter) return null

  return (
    <section className="youtube-spike" aria-label="YouTube IFrame playback prototype">
      <div className="youtube-spike-head">
        <div className="youtube-spike-copy">
          <strong>Visible YouTube player</strong>
          <span>{current ? `${current.title} · ${current.artist}` : 'Select a song below to test the adapter'}</span>
        </div>
        <div className="youtube-spike-events" aria-live="polite">
          <span>{lastEvent}</span>
          <span>PLAYING events {playingEvents}</span>
          {embedErrors > 0 && <span className="danger">Embed errors {embedErrors}</span>}
        </div>
      </div>
      <div className="youtube-spike-body">
        <div className="youtube-iframe-host" ref={hostRef} data-testid="youtube-iframe-host" />
        <div className="youtube-spike-tests">
          <span className="youtube-spike-label">Known source IDs</span>
          {IFRAME_SPIKE_TRACKS.map((track) => (
            <button className="btn ghost" type="button" key={track.sourceId} onClick={() => void playback.play(track)}>
              {track.title}
            </button>
          ))}
          <button
            className="btn ghost"
            type="button"
            onClick={() => void playback.startRadio('song', IFRAME_SPIKE_TRACKS[0].sourceId, IFRAME_SPIKE_TRACKS[0])}
          >
            Believer Song Radio
          </button>
          <small>Provider PLAYING events are instrumentation, not proof that sound was heard.</small>
        </div>
      </div>
    </section>
  )
}
