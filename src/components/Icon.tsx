/** Inline SVG icon set — no icon-font/network dependency. */

export type IconName =
  | "play"
  | "pause"
  | "next"
  | "previous"
  | "shuffle"
  | "repeat"
  | "repeat-one"
  | "heart"
  | "heart-filled"
  | "queue"
  | "volume"
  | "volume-mute"
  | "search"
  | "home"
  | "library"
  | "album"
  | "artist"
  | "playlist"
  | "download"
  | "clock"
  | "plus"
  | "x"
  | "chevron-up"
  | "chevron-down"
  | "lyrics"
  | "settings"
  | "expand"
  | "share"
  | "more"
  | "offline"
  | "note";

const PATHS: Record<IconName, string> = {
  play: "M8 5.14v13.72L19 12 8 5.14z",
  pause: "M7 5h3.5v14H7V5zm6.5 0H17v14h-3.5V5z",
  next: "M6 5.14L15 12l-9 6.86V5.14zM16.5 5H19v14h-2.5V5z",
  previous: "M18 5.14V19l-9-6.86 9-6.86zM5 5h2.5v14H5V5z",
  shuffle:
    "M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z",
  repeat: "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z",
  "repeat-one":
    "M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1.25L10 10.2l.75 1.15.95-.6V15H13z",
  heart: "M12 20.3l-1.5-1.35C5.4 14.47 2 11.4 2 7.65 2 4.6 4.4 2.2 7.45 2.2c1.72 0 3.37.8 4.55 2.17 1.18-1.37 2.83-2.17 4.55-2.17C19.6 2.2 22 4.6 22 7.65c0 3.75-3.4 6.82-8.5 11.3L12 20.3z",
  "heart-filled": "M12 20.3l-1.5-1.35C5.4 14.47 2 11.4 2 7.65 2 4.6 4.4 2.2 7.45 2.2c1.72 0 3.37.8 4.55 2.17 1.18-1.37 2.83-2.17 4.55-2.17C19.6 2.2 22 4.6 22 7.65c0 3.75-3.4 6.82-8.5 11.3L12 20.3z",
  queue: "M3 6h13v2H3V6zm0 4h13v2H3v-2zm0 4h9v2H3v-2zm15-9v9.15A2.98 2.98 0 0016.5 13a3 3 0 103 3V7h2.5V5H18z",
  volume: "M4 9v6h3.5L12 19V5L7.5 9H4zm12.5 3a4.5 4.5 0 00-2.5-4.03v8.05A4.5 4.5 0 0016.5 12zM14 3.23v2.06a7 7 0 010 13.42v2.06a9 9 0 000-17.54z",
  "volume-mute": "M4 9v6h3.5L12 19V5L7.5 9H4zm15.7 6.3l-1.4 1.4L16 14.4l-2.3 2.3-1.4-1.4 2.3-2.3-2.3-2.3 1.4-1.4L16 11.6l2.3-2.3 1.4 1.4-2.3 2.3 2.3 2.3z",
  search: "M15.5 14h-.79l-.28-.27a6.5 6.5 0 10-.7.7l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0A4.5 4.5 0 119 5a4.5 4.5 0 010 9z",
  home: "M12 3l9 8h-3v9h-5v-6h-2v6H6v-9H3l9-8z",
  library: "M4 4h2v16H4V4zm4 0h2v16H8V4zm5.2.4l1.9-.5 4.4 15.4-1.9.5L13.2 4.4z",
  album: "M12 2a10 10 0 100 20 10 10 0 000-20zm0 14a4 4 0 110-8 4 4 0 010 8zm0-5.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z",
  artist: "M12 2a5 5 0 015 5 5 5 0 01-5 5 5 5 0 01-5-5 5 5 0 015-5zm0 12c4.4 0 8 2.2 8 5v3H4v-3c0-2.8 3.6-5 8-5z",
  playlist: "M3 6h13v2H3V6zm0 4h13v2H3v-2zm0 4h9v2H3v-2zm14-9v9.15A2.98 2.98 0 0015.5 13a3 3 0 103 3V7h2.5V5H17z",
  download: "M12 3v10.17l3.59-3.58L17 11l-5 5-5-5 1.41-1.41L12 13.17V3zM5 18h14v2H5v-2z",
  clock: "M12 2a10 10 0 100 20 10 10 0 000-20zm1 11h-5v-2h3V6h2v7z",
  plus: "M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5z",
  x: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  "chevron-up": "M12 8l6 6-1.4 1.4L12 10.8l-4.6 4.6L6 14l6-6z",
  "chevron-down": "M12 16l-6-6 1.4-1.4L12 13.2l4.6-4.6L18 10l-6 6z",
  lyrics: "M4 4h16v2H4V4zm0 5h10v2H4V9zm0 5h16v2H4v-2zm0 5h10v2H4v-2z",
  settings: "M12 8a4 4 0 100 8 4 4 0 000-8zm9 4c0-.6-.05-1.18-.15-1.74l2.1-1.6-2-3.46-2.5 1a8.7 8.7 0 00-3-1.74L15 2H9l-.45 2.46a8.7 8.7 0 00-3 1.74l-2.5-1-2 3.46 2.1 1.6c-.1.56-.15 1.14-.15 1.74s.05 1.18.15 1.74l-2.1 1.6 2 3.46 2.5-1a8.7 8.7 0 003 1.74L9 22h6l.45-2.46a8.7 8.7 0 003-1.74l2.5 1 2-3.46-2.1-1.6c.1-.56.15-1.14.15-1.74z",
  expand: "M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 0h2v6h-6v-2h4v-4z",
  share: "M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81a3 3 0 100-6 3 3 0 00-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9a3 3 0 000 6c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65a2.92 2.92 0 105.92 0 2.92 2.92 0 00-3-2.92z",
  more: "M12 8a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4zm0 6a2 2 0 110-4 2 2 0 010 4z",
  offline: "M2.4 1.7L1 3.1l2.7 2.7A10 10 0 002 12a10 10 0 0010 10c2.4 0 4.6-.85 6.3-2.3l2.6 2.6 1.4-1.4L2.4 1.7zM12 20a8 8 0 01-8-8c0-1.5.4-2.9 1.1-4.1l11 11A7.9 7.9 0 0112 20zm6.3-2.9l1.5 1.5A8 8 0 0012 4c-1.2 0-2.4.3-3.4.8l1.5 1.5A6 6 0 0118 12c0 .9-.2 1.7-.5 2.5l.8 1.6z",
  note: "M12 3v10.55A4 4 0 1014 17V7h4V3h-6z",
};

export function Icon({
  name,
  size = 18,
  filled = false,
}: {
  name: IconName;
  size?: number;
  filled?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={filled ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ display: "block" }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
