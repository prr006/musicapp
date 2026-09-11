import { memo, useEffect, useState } from 'react'
import { initials } from '../lib/format'
import { probeHDArtwork } from '../lib/webProvider'

interface Props {
  src?: string
  alt: string
  className?: string
  round?: boolean
  style?: React.CSSProperties
}

/** Ratios outside this band are treated as non-square (video thumbnails). */
const SQUARE_MIN = 0.8
const SQUARE_MAX = 1.25

/**
 * Extract the YouTube video ID from a thumbnail URL.
 * Matches: https://i.ytimg.com/vi/{VIDEO_ID}/sddefault.jpg
 */
function extractVideoId(url: string): string | null {
  const m = url.match(/i\.ytimg\.com\/vi\/([a-zA-Z0-9_-]{11})\//)
  return m ? m[1] : null
}

/**
 * Shows the provider's real artwork with a fit strategy that depends on the
 * source image's actual shape:
 *
 *   - square album / YouTube Music artwork  → object-fit: cover (clean fill)
 *   - rectangular 16:9 video thumbnails     → object-fit: contain over a
 *     blurred, zoomed copy of the same image, so nothing important is cropped
 *   - round (artist)                        → always cover, circular crop
 *
 * HD artwork probe: on mount, checks whether maxresdefault.jpg (1280×720)
 * exists for YouTube sources. If so, upgrades the src for crisp large display.
 * Falls back to sddefault.jpg (640×480) if HD is unavailable.
 */
export const Artwork = memo(function Artwork({ src, alt, className = '', round, style }: Props) {
  const [status, setStatus] = useState<'idle' | 'loaded' | 'failed'>('idle')
  const [preserve, setPreserve] = useState(false)
  const [displaySrc, setDisplaySrc] = useState(src)

  // Probe for HD artwork when src changes.
  useEffect(() => {
    setStatus('idle')
    setPreserve(false)
    setDisplaySrc(src)

    if (!src) return
    const videoId = extractVideoId(src)
    if (!videoId) return

    let cancelled = false
    probeHDArtwork(videoId).then((hd) => {
      if (cancelled) return
      if (hd) {
        setDisplaySrc(`https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`)
      }
      // If !hd, displaySrc stays as the fallback sddefault URL from bestArtwork().
    })
    return () => { cancelled = true }
  }, [src])

  const showFallback = !displaySrc || status === 'failed'
  const fill = !round && preserve ? 'contain' : 'cover'
  const showBlur = !round && preserve && status === 'loaded'

  return (
    <div className={`artwork ${round ? 'round' : ''} ${className}`} style={style}>
      {!showFallback && showBlur && (
        <img className="artwork-fill" src={displaySrc} alt="" aria-hidden="true" draggable={false} />
      )}
      {!showFallback && (
        <img
          className={`artwork-img ${fill} ${status === 'loaded' ? 'loaded' : ''}`}
          src={displaySrc}
          alt={alt}
          loading="lazy"
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget
            if (img.naturalWidth > 0 && img.naturalHeight > 0) {
              const ratio = img.naturalWidth / img.naturalHeight
              setPreserve(ratio < SQUARE_MIN || ratio > SQUARE_MAX)
            }
            setStatus('loaded')
          }}
          onError={() => setStatus('failed')}
        />
      )}
      {showFallback && (
        <div className="fallback" aria-hidden="true">
          {initials(alt)}
        </div>
      )}
    </div>
  )
})
