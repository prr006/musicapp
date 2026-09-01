import { memo, useEffect, useState } from 'react'
import { initials } from '../lib/format'

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
 * Shows the provider's real artwork with a fit strategy that depends on the
 * source image's actual shape:
 *
 *   - square album / YouTube Music artwork  → object-fit: cover (clean fill)
 *   - rectangular 16:9 video thumbnails     → object-fit: contain over a
 *     blurred, zoomed copy of the same image, so nothing important is cropped
 *   - round (artist)                        → always cover, circular crop
 *
 * When a track genuinely has no artwork — or the URL fails — it degrades to the
 * title's initials rather than substituting a decorative stand-in image.
 */
export const Artwork = memo(function Artwork({ src, alt, className = '', round, style }: Props) {
  const [status, setStatus] = useState<'idle' | 'loaded' | 'failed'>('idle')
  const [preserve, setPreserve] = useState(false)

  useEffect(() => {
    setStatus('idle')
    setPreserve(false)
  }, [src])

  const showFallback = !src || status === 'failed'
  const fill = !round && preserve ? 'contain' : 'cover'
  const showBlur = !round && preserve && status === 'loaded'

  return (
    <div className={`artwork ${round ? 'round' : ''} ${className}`} style={style}>
      {!showFallback && showBlur && (
        <img className="artwork-fill" src={src} alt="" aria-hidden="true" draggable={false} />
      )}
      {!showFallback && (
        <img
          className={`artwork-img ${fill} ${status === 'loaded' ? 'loaded' : ''}`}
          src={src}
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
