import { useCallback, useRef, useState } from 'react'

interface Props {
  value: number
  max: number
  buffered?: number
  disabled?: boolean
  ariaLabel: string
  onChange: (value: number) => void
  onPreview?: (value: number | null) => void
  step?: number
}

/**
 * Pointer + keyboard scrubber. While dragging it reports a preview value so
 * the caller can show the target time without touching the real transport
 * position until the pointer is released.
 */
export function Scrubber({ value, max, buffered = 0, disabled, ariaLabel, onChange, onPreview, step = 5 }: Props) {
  const railRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState(false)
  const [dragValue, setDragValue] = useState(0)

  const valueAt = useCallback(
    (clientX: number): number => {
      const rail = railRef.current
      if (!rail || max <= 0) return 0
      const rect = rail.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      return ratio * max
    },
    [max],
  )

  const shown = dragging ? dragValue : value
  const pct = max > 0 ? Math.max(0, Math.min(100, (shown / max) * 100)) : 0
  const bufferedPct = max > 0 ? Math.max(0, Math.min(100, (buffered / max) * 100)) : 0

  return (
    <div
      className={`scrubber ${dragging ? 'dragging' : ''} ${disabled ? 'disabled' : ''}`}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={ariaLabel}
      aria-valuemin={0}
      aria-valuemax={Math.round(max)}
      aria-valuenow={Math.round(shown)}
      aria-disabled={disabled}
      onKeyDown={(e) => {
        if (disabled) return
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
          e.preventDefault()
          onChange(Math.min(max, value + step))
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
          e.preventDefault()
          onChange(Math.max(0, value - step))
        } else if (e.key === 'Home') {
          e.preventDefault()
          onChange(0)
        } else if (e.key === 'End') {
          e.preventDefault()
          onChange(max)
        }
      }}
      onPointerDown={(e) => {
        if (disabled) return
        e.currentTarget.setPointerCapture(e.pointerId)
        const next = valueAt(e.clientX)
        setDragging(true)
        setDragValue(next)
        onPreview?.(next)
      }}
      onPointerMove={(e) => {
        if (!dragging) return
        const next = valueAt(e.clientX)
        setDragValue(next)
        onPreview?.(next)
      }}
      onPointerUp={(e) => {
        if (!dragging) return
        const next = valueAt(e.clientX)
        setDragging(false)
        onPreview?.(null)
        onChange(next)
      }}
      onPointerCancel={() => {
        setDragging(false)
        onPreview?.(null)
      }}
    >
      <div className="rail" ref={railRef}>
        <div className="buffer" style={{ width: `${bufferedPct}%` }} />
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="knob" style={{ left: `${pct}%` }} />
    </div>
  )
}
