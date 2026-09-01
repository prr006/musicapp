import type { ReactNode } from 'react'
import { AlertIcon, MusicIcon } from './Icons'

export function EmptyState({
  icon,
  title,
  message,
  action,
}: {
  icon?: ReactNode
  title: string
  message?: string
  action?: ReactNode
}) {
  return (
    <div className="state">
      <div className="state-icon">{icon ?? <MusicIcon size={20} />}</div>
      <h3>{title}</h3>
      {message && <p>{message}</p>}
      {action}
    </div>
  )
}

export function ErrorState({
  title = 'Something needs your attention',
  message,
  onRetry,
  retryLabel = 'Try again',
}: {
  title?: string
  message: string
  onRetry?: () => void
  retryLabel?: string
}) {
  return (
    <div className="state error" role="alert">
      <div className="state-icon">
        <AlertIcon size={20} />
      </div>
      <h3>{title}</h3>
      <p>{message}</p>
      {onRetry && (
        <button className="btn ghost" onClick={onRetry} type="button">
          {retryLabel}
        </button>
      )}
    </div>
  )
}

export function LoadingRows({ count = 6 }: { count?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton skeleton-row" />
      ))}
    </div>
  )
}

export function LoadingCards({ count = 6 }: { count?: number }) {
  return (
    <div className="card-grid" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => (
        <div key={i}>
          <div className="skeleton" style={{ aspectRatio: 1, marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 12, width: '72%', marginBottom: 6 }} />
          <div className="skeleton" style={{ height: 10, width: '48%' }} />
        </div>
      ))}
    </div>
  )
}
