import { Artwork } from './Artwork'
import { PlayIcon } from './Icons'

interface Props {
  title: string
  subtitle?: string
  artwork?: string
  round?: boolean
  onOpen: () => void
  onPlay?: () => void
}

export function MediaCard({ title, subtitle, artwork, round, onOpen, onPlay }: Props) {
  return (
    <div className="card">
      <button
        type="button"
        onClick={onOpen}
        style={{ width: '100%', textAlign: 'left' }}
        aria-label={`Open ${title}`}
      >
        <Artwork src={artwork} alt={title} round={round} />
        <div className="card-title">{title}</div>
        {subtitle && <div className="card-sub">{subtitle}</div>}
      </button>
      {onPlay && (
        <button
          className="play-fab"
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onPlay()
          }}
          aria-label={`Play ${title}`}
        >
          <PlayIcon size={17} />
        </button>
      )}
    </div>
  )
}
