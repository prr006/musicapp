/**
 * Track list + per-row context menu (spec §19).
 * Options adapt to context (queue rows offer Move up/down; library rows
 * offer Play next / Add to queue / Share …).
 */

import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "@/app/api";
import { Icon } from "@/components/Icon";
import { Artwork } from "@/components/Artwork";
import { useStore } from "@/app/store";
import { playbackStore } from "@/app/stores/playback";
import { pushToast } from "@/app/stores/ui";
import { formatTime } from "@/lib/format";
import { artistLine, type Track } from "@/types/domain";

interface CtxState {
  x: number;
  y: number;
  track: Track;
  queueItemId?: string;
}

export function TrackList({ tracks, showAlbum = true }: { tracks: Track[]; showAlbum?: boolean }) {
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const currentTrackId = useStore(playbackStore, (s) => s.currentTrack?.id ?? null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setCtx(null), []);

  useEffect(() => {
    if (!ctx) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctx]);

  return (
    <>
      <div className="track-list" role="list">
        {tracks.map((track, i) => {
          const current = track.id === currentTrackId;
          return (
            <div
              key={track.id}
              role="listitem"
              className={`track-row${current ? " current" : ""}`}
              onDoubleClick={() => void api.playNow(track)}
            >
              <button
                className="track-index"
                title="Play"
                onClick={() => void api.playNow(track)}
                style={{ background: "none", cursor: "pointer" }}
              >
                {current ? <Icon name="note" size={13} filled /> : i + 1}
              </button>
              <Artwork track={track} size={40} rounded={6} />
              <div className="track-meta">
                <span className="track-title">{track.title}</span>
                <span className="track-artist">{artistLine(track)}</span>
              </div>
              {showAlbum && <span className="track-album">{track.album?.title ?? "—"}</span>}
              <span className="track-dur">{formatTime(track.durationSecs)}</span>
              <button
                className="icon-button"
                style={{ width: 30, height: 30 }}
                title="More options"
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setCtx({ x: rect.left - 180, y: rect.bottom + 6, track });
                }}
              >
                <Icon name="more" size={15} filled />
              </button>
            </div>
          );
        })}
      </div>

      {ctx && (
        <div className="ctx-menu" ref={menuRef} style={{ left: ctx.x, top: ctx.y }}>
          <CtxItem icon="play" label="Play now" close={close} onClick={() => void api.playNow(ctx.track)} />
          <CtxItem
            icon="queue"
            label="Play next"
            close={close}
            onClick={() => {
              void api.playNext([ctx.track]);
              pushToast("Playing next", "success");
            }}
          />
          <CtxItem
            icon="plus"
            label="Add to queue"
            close={close}
            onClick={() => {
              void api.addToQueue([ctx.track]);
              pushToast("Added to queue", "success");
            }}
          />
          <CtxItem
            icon="share"
            label="Copy link"
            close={close}
            onClick={() => {
              const url =
                ctx.track.source === "youtube"
                  ? `https://www.youtube.com/watch?v=${ctx.track.sourceId}`
                  : null;
              if (url) {
                void navigator.clipboard?.writeText(url);
                pushToast("Link copied", "success");
              } else {
                pushToast("No shareable link for local tracks", "info");
              }
            }}
          />
          <CtxItem
            icon="heart"
            label="Like (Phase 6)"
            close={close}
            onClick={() => pushToast("Favorites arrive in Phase 6", "info")}
          />
          <CtxItem
            icon="download"
            label="Download (Phase 10)"
            close={close}
            onClick={() => pushToast("Downloads arrive in Phase 10", "info")}
          />
        </div>
      )}
    </>
  );
}

function CtxItem({
  icon,
  label,
  onClick,
  close,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  label: string;
  onClick: () => void;
  close: () => void;
}) {
  return (
    <button
      className="ctx-item"
      onClick={() => {
        onClick();
        close();
      }}
    >
      <Icon name={icon} size={15} />
      {label}
    </button>
  );
}
