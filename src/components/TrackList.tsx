/**
 * Track list + per-row context menu (spec §19).
 * Every action is a command; liked state comes from the library mirror.
 * `onRemove`/`onMove` let playlist & history views reuse the same list.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import * as api from "@/app/api";
import { Icon } from "@/components/Icon";
import { Artwork } from "@/components/Artwork";
import { useStore } from "@/app/store";
import { playbackStore } from "@/app/stores/playback";
import { isLiked, libraryStore, usePlaylists } from "@/app/stores/library";
import { pushToast } from "@/app/stores/ui";
import { formatTime } from "@/lib/format";
import { artistLine, type Track } from "@/types/domain";

interface CtxState {
  x: number;
  y: number;
  track: Track;
  index: number;
  playlistOpen: boolean;
}

export function TrackList({
  tracks,
  showAlbum = true,
  onRemove,
  removeLabel = "Remove",
  onMove,
  secondary,
  emptyHint = "Nothing here yet.",
}: {
  tracks: Track[];
  showAlbum?: boolean;
  onRemove?: (track: Track, index: number) => void;
  removeLabel?: string;
  onMove?: (index: number, up: boolean) => void;
  secondary?: (track: Track, index: number) => ReactNode;
  emptyHint?: string;
}) {
  const [ctx, setCtx] = useState<CtxState | null>(null);
  const currentTrackId = useStore(playbackStore, (s) => s.currentTrack?.id ?? null);
  const liked = useStore(libraryStore, (s) => s.data?.liked ?? null);
  const playlists = usePlaylists();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setCtx(null), []);

  useEffect(() => {
    if (!ctx) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node)) return; // clicks inside stay
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
  }, [ctx, close]);

  if (tracks.length === 0) {
    return <div className="state-block small"><p>{emptyHint}</p></div>;
  }

  return (
    <>
      <div className="track-list" role="list">
        {tracks.map((track, i) => {
          const current = track.id === currentTrackId;
          const trackLiked = isLiked(liked, track.id);
          return (
            <div
              key={`${track.id}-${i}`}
              role="listitem"
              tabIndex={0}
              className={`track-row${current ? " current" : ""}`}
              title={`Play “${track.title}”`}
              onClick={() => void api.playNow(track)}
              onKeyDown={(e) => {
                // Row is keyboard-focusable; Enter plays. Secondary buttons
                // swallow their own keys (they never bubble to the row).
                if (e.key === "Enter") {
                  e.preventDefault();
                  void api.playNow(track);
                }
              }}
            >
              <button
                className="track-index"
                title="Play"
                onClick={(e) => {
                  e.stopPropagation();
                  void api.playNow(track);
                }}
                style={{ background: "none", cursor: "pointer" }}
              >
                {current ? <Icon name="note" size={13} filled /> : i + 1}
              </button>
              <Artwork track={track} size={40} rounded={6} />
              <div className="track-meta">
                <span className="track-title">{track.title}</span>
                <span className="track-artist">
                  {artistLine(track)}
                  {secondary ? "" : track.album?.title ? ` · ${track.album.title}` : ""}
                </span>
                {secondary && <span className="track-artist">{secondary(track, i)}</span>}
              </div>
              {showAlbum && <span className="track-album">{track.album?.title ?? "—"}</span>}
              <span className="track-dur">{formatTime(track.durationSecs)}</span>
              <button
                className={`icon-button${trackLiked ? " accent" : ""}`}
                style={{ width: 30, height: 30 }}
                title={trackLiked ? "Remove from favorites" : "Add to favorites"}
                onClick={(e) => {
                  e.stopPropagation();
                  void api
                    .toggleFavorite(track)
                    .then((now) => pushToast(now ? "Added to favorites" : "Removed from favorites", "success"))
                    .catch((err) => pushToast(String(err), "error"));
                }}
              >
                <Icon name={trackLiked ? "heart-filled" : "heart"} size={14} />
              </button>
              {onMove && (
                <div style={{ display: "flex" }} onClick={(e) => e.stopPropagation()}>
                  <button
                    className="icon-button"
                    style={{ width: 26, height: 30 }}
                    title="Move up"
                    disabled={i === 0}
                    onClick={() => onMove(i, true)}
                  >
                    <Icon name="chevron-up" size={13} />
                  </button>
                  <button
                    className="icon-button"
                    style={{ width: 26, height: 30 }}
                    title="Move down"
                    disabled={i === tracks.length - 1}
                    onClick={() => onMove(i, false)}
                  >
                    <Icon name="chevron-down" size={13} />
                  </button>
                </div>
              )}
              <button
                className="icon-button"
                style={{ width: 30, height: 30 }}
                title="More options"
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  setCtx({ x: rect.left - 190, y: rect.bottom + 6, track, index: i, playlistOpen: false });
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
            icon={isLiked(liked, ctx.track.id) ? "heart-filled" : "heart"}
            label={isLiked(liked, ctx.track.id) ? "Remove from favorites" : "Add to favorites"}
            close={close}
            onClick={() => {
              void api
                .toggleFavorite(ctx.track)
                .then((now) => pushToast(now ? "Added to favorites" : "Removed from favorites", "success"))
                .catch((e) => pushToast(String(e), "error"));
            }}
          />

          <div className="ctx-sep" />
          {!ctx.playlistOpen ? (
            <CtxItem
              icon="playlist"
              label="Add to playlist…"
              close={() => {}}
              onClick={() => setCtx({ ...ctx, playlistOpen: true })}
            />
          ) : (
            <div className="ctx-submenu">
              <div className="ctx-subhead">Add to playlist</div>
              {playlists.length === 0 && <div className="ctx-note">No playlists yet</div>}
              {playlists.map((pl) => (
                <CtxItem
                  key={pl.id}
                  icon="playlist"
                  label={pl.title}
                  close={close}
                  onClick={() => {
                    void api
                      .addTracksToPlaylist(pl.id, [ctx.track])
                      .then(() => pushToast(`Added to “${pl.title}”`, "success"))
                      .catch((e) => pushToast(String(e), "error"));
                  }}
                />
              ))}
              <NewPlaylistRow track={ctx.track} onDone={close} />
            </div>
          )}
          <div className="ctx-sep" />

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
                pushToast("Local tracks have no shareable link", "info");
              }
            }}
          />
          {onRemove && (
            <CtxItem
              icon="x"
              label={removeLabel}
              close={close}
              onClick={() => onRemove(ctx.track, ctx.index)}
            />
          )}
        </div>
      )}
    </>
  );
}

function NewPlaylistRow({ track, onDone }: { track: Track; onDone: () => void }) {
  const [title, setTitle] = useState("");
  return (
    <form
      className="ctx-new-playlist"
      onSubmit={(e) => {
        e.preventDefault();
        const name = title.trim();
        if (!name) return;
        void api
          .createPlaylist(name)
          .then((pl) => api.addTracksToPlaylist(pl.id, [track]))
          .then(() => pushToast(`Created “${name}”`, "success"))
          .catch((e) => pushToast(String(e), "error"));
        onDone();
      }}
    >
      <input
        autoFocus
        placeholder="New playlist name…"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <button className="button ghost" type="submit" style={{ padding: "3px 10px", fontSize: 12 }}>
        Create
      </button>
    </form>
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
