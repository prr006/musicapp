/** Minimal inline icon set (stroke-based, 20px grid) — no icon dependency. */
import type { SVGProps } from 'react'

type Props = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 18, children, ...rest }: Props & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const HomeIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M3 10.2 12 3l9 7.2V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z" />
  </Icon>
)

export const SearchIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.2-3.2" />
  </Icon>
)

export const LibraryIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M4 4v16M9 4v16" />
    <path d="m14 5 5 15" />
  </Icon>
)

export const PlayIcon = (p: Props) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <path d="M8 5.5v13a1 1 0 0 0 1.53.85l10.2-6.5a1 1 0 0 0 0-1.7L9.53 4.65A1 1 0 0 0 8 5.5" />
  </Icon>
)

export const PauseIcon = (p: Props) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <rect x="7" y="5" width="3.6" height="14" rx="1.1" />
    <rect x="13.4" y="5" width="3.6" height="14" rx="1.1" />
  </Icon>
)

export const NextIcon = (p: Props) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <path d="M6 6.2v11.6a1 1 0 0 0 1.54.84l8.2-5.8a1 1 0 0 0 0-1.68l-8.2-5.8A1 1 0 0 0 6 6.2" />
    <rect x="16.8" y="5.4" width="2.4" height="13.2" rx="1.1" />
  </Icon>
)

export const PrevIcon = (p: Props) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <path d="M18 6.2v11.6a1 1 0 0 1-1.54.84l-8.2-5.8a1 1 0 0 1 0-1.68l8.2-5.8A1 1 0 0 1 18 6.2" />
    <rect x="4.8" y="5.4" width="2.4" height="13.2" rx="1.1" />
  </Icon>
)

export const StopIcon = (p: Props) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </Icon>
)

export const ShuffleIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M16 4h4v4M20 4l-6.5 6.5M16 20h4v-4M20 20l-5-5M4 4l4.5 4.5M4 20l7-7" />
  </Icon>
)

export const RepeatIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M17 3l3 3-3 3" />
    <path d="M20 6H8a4 4 0 0 0-4 4v1" />
    <path d="M7 21l-3-3 3-3" />
    <path d="M4 18h12a4 4 0 0 0 4-4v-1" />
  </Icon>
)

export const RepeatOneIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M17 3l3 3-3 3" />
    <path d="M20 6H8a4 4 0 0 0-4 4v1" />
    <path d="M7 21l-3-3 3-3" />
    <path d="M4 18h12a4 4 0 0 0 4-4v-1" />
    <path d="M11.4 10.5l1.3-.7v4.4" strokeWidth={2} />
  </Icon>
)

export const HeartIcon = ({ filled, ...p }: Props & { filled?: boolean }) => (
  <Icon {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="M12 20.2s-7.5-4.4-7.5-9.4A4.3 4.3 0 0 1 12 8.1a4.3 4.3 0 0 1 7.5 2.7c0 5-7.5 9.4-7.5 9.4" />
  </Icon>
)

export const ThumbDownIcon = ({ filled, ...p }: Props & { filled?: boolean }) => (
  <Icon {...p} fill={filled ? 'currentColor' : 'none'}>
    <path d="M7 4.5h9.4a1.6 1.6 0 0 1 1.55 1.2l1.5 6.1a1.6 1.6 0 0 1-1.56 2H14l.7 3.3a1.9 1.9 0 0 1-3.7.7L9.4 14H7a1.6 1.6 0 0 1-1.6-1.6V6.1A1.6 1.6 0 0 1 7 4.5" />
    <path d="M7 4.5A1.6 1.6 0 0 0 5.4 6.1v6.3A1.6 1.6 0 0 0 7 14h2.4" />
  </Icon>
)

export const RadioIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="2.2" />
    <path d="M8 8a5.6 5.6 0 0 0 0 8M16 8a5.6 5.6 0 0 1 0 8" />
    <path d="M5.2 5.2a9.6 9.6 0 0 0 0 13.6M18.8 5.2a9.6 9.6 0 0 1 0 13.6" />
  </Icon>
)

export const VolumeIcon = ({ level = 2, ...p }: Props & { level?: 0 | 1 | 2 }) => (
  <Icon {...p}>
    <path d="M4 9.5h3.2L12 5.6v12.8L7.2 14.5H4z" />
    {level === 0 ? (
      <path d="m16.5 9.5 4 5M20.5 9.5l-4 5" />
    ) : (
      <>
        <path d="M15.8 9.4a3.6 3.6 0 0 1 0 5.2" />
        {level === 2 && <path d="M18.4 7.2a7 7 0 0 1 0 9.6" />}
      </>
    )}
  </Icon>
)

export const QueueIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M4 6h11M4 12h11M4 18h7" />
    <path d="M17.5 12.4v5.9" />
    <circle cx="19.4" cy="18.4" r="1.8" />
  </Icon>
)

export const LyricsIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M5 5h14M5 10h9M5 15h12M5 20h6" />
  </Icon>
)

export const MoreIcon = (p: Props) => (
  <Icon {...p} fill="currentColor" stroke="none">
    <circle cx="12" cy="5.5" r="1.6" />
    <circle cx="12" cy="12" r="1.6" />
    <circle cx="12" cy="18.5" r="1.6" />
  </Icon>
)

export const PlusIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const CloseIcon = (p: Props) => (
  <Icon {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </Icon>
)

export const ChevronLeft = (p: Props) => (
  <Icon {...p}>
    <path d="m14.5 5-7 7 7 7" />
  </Icon>
)

export const ChevronRight = (p: Props) => (
  <Icon {...p}>
    <path d="m9.5 5 7 7-7 7" />
  </Icon>
)

export const ChevronDown = (p: Props) => (
  <Icon {...p}>
    <path d="m5 9 7 7 7-7" />
  </Icon>
)

export const SettingsIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1" />
  </Icon>
)

export const TrendingIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M3 17l5-5 4 3 5-6" />
    <path d="M14 9h4v4" />
  </Icon>
)

export const ClockIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.2" />
    <path d="M12 7.5V12l3 1.8" />
  </Icon>
)

export const AlbumIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.2" />
    <circle cx="12" cy="12" r="2.2" />
  </Icon>
)

export const ArtistIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="12" cy="8.4" r="3.6" />
    <path d="M5 20c.7-3.6 3.4-5.4 7-5.4s6.3 1.8 7 5.4" />
  </Icon>
)

export const TrashIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M4.5 7h15M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
    <path d="M6.5 7l.8 12.1A1.4 1.4 0 0 0 8.7 20.4h6.6a1.4 1.4 0 0 0 1.4-1.3L17.5 7" />
  </Icon>
)

export const SpeedIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M12 20a8 8 0 1 1 8-8" />
    <path d="m12 12 4.2-3.4" />
  </Icon>
)

export const MoonIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M20 13.5A8.5 8.5 0 0 1 10.5 4a7 7 0 1 0 9.5 9.5Z" />
  </Icon>
)

export const AlertIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="8.4" />
    <path d="M12 8v4.6M12 16h.01" />
  </Icon>
)

export const MusicIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M9 18V6.4l10-2v11.2" />
    <circle cx="6.6" cy="18" r="2.6" />
    <circle cx="16.6" cy="15.6" r="2.6" />
  </Icon>
)

export const DownIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M12 5v14M6 13l6 6 6-6" />
  </Icon>
)

export const UpIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M12 19V5M6 11l6-6 6 6" />
  </Icon>
)
