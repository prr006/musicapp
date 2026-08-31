/**
 * Artwork rendering: remote images when available, generated gradient tiles
 * (from track colors or a hash) otherwise. No network for the sample catalog.
 */

import { useMemo } from "react";

import { trackColors } from "@/app/ipc/sampleData";
import type { Track } from "@/types/domain";

export function Artwork({
  track,
  size,
  rounded = 8,
  className,
}: {
  track: Track | null;
  size: number;
  rounded?: number;
  className?: string;
}) {
  const [a, b] = useMemo(() => (track ? trackColors(track) : ["#3a3f4d", "#23262f"]), [track]);
  const initials = track ? initialsOf(track.title) : "♪";

  if (track?.artwork) {
    return (
      <img
        src={track.artwork}
        alt=""
        width={size}
        height={size}
        className={className}
        style={{ borderRadius: rounded, objectFit: "cover" }}
        loading="lazy"
        draggable={false}
      />
    );
  }

  return (
    <div
      className={className}
      style={{
        width: size,
        height: size,
        borderRadius: rounded,
        background: `linear-gradient(135deg, ${a}, ${b})`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        color: "rgba(255,255,255,0.85)",
        fontSize: Math.max(11, size * 0.22),
        fontWeight: 700,
        letterSpacing: "0.04em",
        userSelect: "none",
      }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

function initialsOf(title: string): string {
  const words = title.split(/\s+/).filter(Boolean).slice(0, 2);
  return words.map((w) => w[0]!.toUpperCase()).join("") || "♪";
}
