/**
 * Queue drawer (spec §4): current + upcoming (drag to reorder) and history.
 * All mutations are commands; the view re-renders from the queue store.
 * Single click jumps to an item; row action buttons stop propagation.
 */

import { useEffect, useRef, useState } from "react";

import * as api from "@/app/api";
import { Artwork } from "@/components/Artwork";
import { Icon } from "@/components/Icon";
import { useStore } from "@/app/store";
import { queueStore } from "@/app/stores/playback";
import { toggleQueue, pushToast } from "@/app/stores/ui";
import { artistLine, type QueueItem } from "@/types/domain";
import { formatTime } from "@/lib/format";

export function QueuePanel() {
  const view = useStore(queueStore, (s) => s);
  const [tab, setTab] = useState<"queue" | "history">("queue");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState("");
  const activeRef = useRef<HTMLDivElement | null>(null);

  // Keep the current item in view when tracks auto-advance.
  useEffect(() => {
    activeRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [view.current?.id]);

  const items = tab === "queue" ? view.upcoming : view.history;

  function saveAsPlaylist(e: React.FormEvent) {
    e.preventDefault();
    const name = title.trim();
    if (!name) return;
    void api
      .saveQueueAsPlaylist(name)
      .then(() => pushToast(`Queue saved as “${name}”`, "success"))
      .catch((err) => pushToast(String(err), "error"));
    setTitle("");
    setSaving(false);
  }

  return (
    <aside className="queue-panel" role="dialog" aria-label="Queue">
      <div className="queue-head">
        <h3>Queue</h3>
        <button
          className={`icon-button${view.shuffle ? " toggled" : ""}`}
          style={{ width: 30, height: 30 }}
          title={`Shuffle ${view.shuffle ? "on" : "off"}`}
          onClick={() => void api.setShuffle(!view.shuffle)}
        >
          <Icon name="shuffle" size={14} />
        </button>
        <button
          className={`icon-button${view.repeat !== "off" ? " toggled" : ""}`}
          style={{ width: 30, height: 30 }}
          title={`Repeat: ${view.repeat}`}
          onClick={() =>
            void api.setRepeat(view.repeat === "off" ? "all" : view.repeat === "all" ? "one" : "off")
          }
        >
          <Icon name={view.repeat === "one" ? "repeat-one" : "repeat"} size={14} />
        </button>
        {tab === "queue" && view.upcoming.length > 1 && (
          <button
            className="button ghost"
            style={{ padding: "5px 12px", fontSize: 12 }}
            onClick={() => void api.shuffleUpcoming()}
            title="Reshuffle the upcoming order (keeps the current track)"
          >
            Shuffle list
          </button>
        )}
        {tab === "queue" && view.upcoming.length > 0 && (
          <>
            <button
              className="button ghost"
              style={{ padding: "5px 12px", fontSize: 12 }}
              onClick={() => setSaving((s) => !s)}
              title="Save current + upcoming as a playlist"
            >
              Save as playlist
            </button>
            <button
              className="button ghost"
              style={{ padding: "5px 12px", fontSize: 12 }}
              onClick={() => void api.clearUpcoming()}
              title="Clear upcoming (keeps current)"
            >
              Clear
            </button>
          </>
        )}
        <button className="icon-button" style={{ width: 30, height: 30 }} onClick={toggleQueue} title="Close (Q)">
          <Icon name="x" size={15} />
        </button>
      </div>

      {saving && (
        <form className="inline-form" style={{ margin: "0 10px 10px" }} onSubmit={saveAsPlaylist}>
          <input
            autoFocus
            placeholder="Playlist name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button className="button" type="submit" style={{ padding: "5px 12px", fontSize: 12 }}>
            Save
          </button>
        </form>
      )}

      <div className="queue-tabs">
        <button
          className={`queue-tab${tab === "queue" ? " active" : ""}`}
          onClick={() => setTab("queue")}
        >
          Upcoming ({view.upcoming.length})
        </button>
        <button
          className={`queue-tab${tab === "history" ? " active" : ""}`}
          onClick={() => setTab("history")}
        >
          History ({view.history.length})
        </button>
      </div>

      <div className="queue-body">
        {tab === "queue" && view.current && (
          <>
            <div className="queue-item current" ref={activeRef}>
              <Artwork track={view.current.track} size={40} rounded={6} />
              <div style={{ minWidth: 0 }}>
                <div className="qi-title">{view.current.track.title}</div>
                <div className="qi-artist" style={{ color: "var(--accent)" }}>
                  Now playing · {artistLine(view.current.track)}
                </div>
              </div>
              <span className="track-dur" style={{ fontSize: 11 }}>
                {formatTime(view.current.track.durationSecs)}
              </span>
            </div>
            <div
              style={{
                height: 1,
                background: "var(--border-subtle)",
                margin: "6px 8px 10px",
              }}
            />
          </>
        )}

        {items.length === 0 ? (
          <div className="queue-empty">
            {tab === "queue"
              ? "Nothing queued. Add songs with “Add to queue” or start a playlist."
              : "Nothing played yet."}
          </div>
        ) : (
          items.map((item, i) => (
            <QueueRow
              key={item.id}
              item={item}
              index={i}
              isHistory={tab === "history"}
              dragging={dragIndex === i}
              dragOver={overIndex === i && dragIndex !== null && dragIndex !== i}
              onDragStart={() => setDragIndex(i)}
              onDragOver={(e) => {
                if (tab !== "queue") return;
                e.preventDefault();
                setOverIndex(i);
              }}
              onDrop={() => {
                if (dragIndex != null && tab === "queue") {
                  void api.reorderQueue(dragIndex, i);
                }
                setDragIndex(null);
                setOverIndex(null);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function QueueRow({
  item,
  isHistory,
  dragging,
  dragOver,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  item: QueueItem;
  index: number;
  isHistory: boolean;
  dragging: boolean;
  dragOver: boolean;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  return (
    <div
      className={`queue-item${dragging ? " dragging" : ""}`}
      style={dragOver ? { outline: "2px solid var(--accent)", outlineOffset: -2 } : undefined}
      draggable={!isHistory}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
      onClick={() => void api.jumpTo(item.id)}
      title={isHistory ? "Play again" : "Play from here"}
    >
      <Artwork track={item.track} size={40} rounded={6} />
      <div style={{ minWidth: 0 }}>
        <div className="qi-title">{item.track.title}</div>
        <div className="qi-artist">{artistLine(item.track)}</div>
      </div>
      <div style={{ display: "flex", gap: 0 }} onClick={(e) => e.stopPropagation()}>
        {!isHistory && (
          <>
            <button
              className="icon-button"
              style={{ width: 26, height: 26 }}
              title="Move up"
              onClick={() => void api.moveQueueItem(item.id, true)}
            >
              <Icon name="chevron-up" size={13} />
            </button>
            <button
              className="icon-button"
              style={{ width: 26, height: 26 }}
              title="Move down"
              onClick={() => void api.moveQueueItem(item.id, false)}
            >
              <Icon name="chevron-down" size={13} />
            </button>
            <button
              className="icon-button"
              style={{ width: 26, height: 26 }}
              title="Remove"
              onClick={() => void api.removeFromQueue(item.id)}
            >
              <Icon name="x" size={12} />
            </button>
          </>
        )}
        {isHistory && (
          <button
            className="icon-button"
            style={{ width: 26, height: 26 }}
            title="Play again"
            onClick={() => void api.jumpTo(item.id)}
          >
            <Icon name="play" size={13} filled />
          </button>
        )}
      </div>
    </div>
  );
}
