import { memo, useEffect, useState } from 'react'
import { initials } from '../lib/format'

interface Props {
  src?: string
  alt: string
  className?: string
  round?: boolean
  style?: React.CSSProperties
}

/**
 * Shows the provider's real artwork. When a track genuinely has no artwork —
 * or the URL fails — it degrades to the title's initials rather than
 * substituting a decorative stand-in image.
 */
export const Artwork = memo(function Artwork({ src, alt, className = '', round, style }: Props) {
  const [status, setStatus] = useState<'idle' | 'loaded' | 'failed'>('idle')

  useEffect(() => {
    setStatus('idle')
  }, [src])

  const showFallback = !src || status === 'failed'

  return (
    <div className={`artwork ${round ? 'round' : ''} ${className}`} style={style}>
      {!showFallback && (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          draggable={false}
          className={status === 'loaded' ? 'loaded' : ''}
          onLoad={() => setStatus('loaded')}
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
