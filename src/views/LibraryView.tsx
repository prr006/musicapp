/**
 * Library views (spec §6): favorites, all songs, albums, artists, playlists
 * (full CRUD + reorder), and recently played with completion stats.
 * All data comes from the `library://updated` mirror; all edits are commands.
 */

import { useMemo, useState } from "react";

import * as api from "@/app/api";
import { Artwork } from "@/components/Artwork";
import { Icon } from "@/components/Icon";
import { TrackList } from "@/components/TrackList";
import { useLibrary, usePlaylists } from "@/app/stores/library";
import { openPlaylist, useUi } from "@/app/stores/ui";
import { pushToast } from "@/app/stores/ui";
import { allKnownTracks, groupAlbums, groupArtists } from "@/lib/collection";
import { formatTime } from "@/lib/format";
import type { LibraryData, PlaylistLite, Track } from "@/types/domain";

export type LibraryTab =
  | "liked"
  | "songs"
  | "albums"
  | "artists"
  | "playlists"
  | "recently-played";

function relTime(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function LibraryView({ view }: { view: LibraryTab }) {
  const library = useLibrary();
  const playlists = usePlaylists();
  const { openPlaylistId } = useUi();

  const known = useMemo(() => allKnownTracks(library), [library]);
  const albums = useMemo(() => groupAlbums(known), [known]);
  const artists = useMemo(() => groupArtists(known), [known]);

  if (!library) {
    return (
      <div className="state-block">
        <div className="spinner" />
        <p>Loading library…</p>
      </div>
    );
  }

  switch (view) {
    case "liked":
      return (
        <section>
          <PageHeader
            icon="heart"
            title="Liked Songs"
            sub={`${library.liked.length} track${library.liked.length === 1 ? "" : "s"}`}
            actions={
              library.liked.length > 0 && (
                <>
                  <button className="button" onClick={() => void api.startSequence(library.liked, false)}>
                    <Icon name="play" size={14} filled /> Play all
                  </button>
                  <button
                    className="button ghost"
                    onClick={() => void api.startSequence(library.liked, true)}
                  >
                    <Icon name="shuffle" size={14} /> Shuffle
                  </button>
                </>
              )
            }
          />
          <TrackList
            tracks={library.liked}
            emptyHint="No favorites yet — tap the ♥ on any track, in search results or Now Playing."
          />
        </section>
      );

    case "songs":
      return (
        <section>
          <PageHeader
            icon="note"
            title="Songs"
            sub={`${known.length} track${known.length === 1 ? "" : "s"} known to MELO`}
            actions={
              known.length > 0 && (
                <>
                  <button className="button" onClick={() => void api.startSequence(known, false)}>
                    <Icon name="play" size={14} filled /> Play all
                  </button>
                  <button className="button ghost" onClick={() => void api.startSequence(known, true)}>
                    <Icon name="shuffle" size={14} /> Shuffle
                  </button>
                </>
              )
            }
          />
          <TrackList
            tracks={known}
            emptyHint="Songs you play, like, or add to playlists will show up here."
          />
        </section>
      );

    case "albums":
      return <AlbumsView albums={albums} />;

    case "artists":
      return <ArtistsView artists={artists} />;

    case "playlists":
      return openPlaylistId ? (
        <PlaylistDetail
          playlist={playlists.find((p) => p.id === openPlaylistId) ?? null}
          library={library}
        />
      ) : (
        <PlaylistsView playlists={playlists} library={library} />
      );

    case "recently-played":
      return <RecentlyPlayed library={library} />;
  }
}

function PageHeader({
  icon,
  title,
  sub,
  actions,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  sub: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div className="page-head-icon">
        <Icon name={icon} size={22} filled />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <h2>{title}</h2>
        <p className="page-sub">{sub}</p>
      </div>
      <div className="page-head-actions">{actions}</div>
    </div>
  );
}

// ---- albums -----------------------------------------------------------------

function AlbumsView({ albums }: { albums: ReturnType<typeof groupAlbums> }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = albums.find((a) => a.albumId === openId) ?? null;

  if (open) {
    return (
      <section>
        <button className="button ghost back-link" onClick={() => setOpenId(null)}>
          <Icon name="chevron-up" size={13} /> All albums
        </button>
        <PageHeader
          icon="album"
          title={open.title}
          sub={`${open.artistName}${open.year ? ` · ${open.year}` : ""} · ${open.tracks.length} tracks`}
          actions={
            <>
              <button className="button" onClick={() => void api.startSequence(open.tracks, false)}>
                <Icon name="play" size={14} filled /> Play
              </button>
              <button className="button ghost" onClick={() => void api.startSequence(open.tracks, true)}>
                <Icon name="shuffle" size={14} /> Shuffle
              </button>
            </>
          }
        />
        <TrackList tracks={open.tracks} />
      </section>
    );
  }

  return (
    <section>
      <PageHeader icon="album" title="Albums" sub="Grouped from metadata on your tracks" />
      {albums.length === 0 ? (
        <div className="state-block">
          <div className="big">◎</div>
          <h3>No album metadata yet</h3>
          <p>
            MELO groups albums only when tracks actually carry album tags —
            plain YouTube rips usually don&apos;t, and pretending otherwise
            would lie to you. Play or like tagged music and albums appear here.
          </p>
        </div>
      ) : (
        <div className="grid">
          {albums.map((album) => (
            <button key={album.albumId} className="card" onClick={() => setOpenId(album.albumId)}>
              <Artwork track={album.tracks[0]} size={148} rounded={12} />
              <div className="card-title">{album.title}</div>
              <div className="card-sub">
                {album.year ? `${album.year} · ` : ""}
                {album.artistName}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ---- artists ------------------------------------------------------------------

function ArtistsView({ artists }: { artists: ReturnType<typeof groupArtists> }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = artists.find((a) => a.artistId === openId) ?? null;

  if (open) {
    return (
      <section>
        <button className="button ghost back-link" onClick={() => setOpenId(null)}>
          <Icon name="chevron-up" size={13} /> All artists
        </button>
        <PageHeader
          icon="artist"
          title={open.name}
          sub={`${open.tracks.length} track${open.tracks.length === 1 ? "" : "s"}`}
          actions={
            <>
              <button className="button" onClick={() => void api.startSequence(open.tracks, false)}>
                <Icon name="play" size={14} filled /> Play
              </button>
              <button className="button ghost" onClick={() => void api.startSequence(open.tracks, true)}>
                <Icon name="shuffle" size={14} /> Shuffle
              </button>
            </>
          }
        />
        <TrackList tracks={open.tracks} />
      </section>
    );
  }

  return (
    <section>
      <PageHeader icon="artist" title="Artists" sub="Grouped from the primary artist on your tracks" />
      {artists.length === 0 ? (
        <div className="state-block">
          <div className="big">♪</div>
          <h3>Nothing to group yet</h3>
          <p>Artists appear as you play and collect music.</p>
        </div>
      ) : (
        <div className="grid">
          {artists.map((artist) => (
            <button key={artist.artistId} className="card" onClick={() => setOpenId(artist.artistId)}>
              <div
                style={{
                  width: 148,
                  height: 148,
                  borderRadius: 999,
                  background: "linear-gradient(135deg, var(--accent), var(--accent-strong))",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 40,
                  fontWeight: 800,
                  color: "rgba(255,255,255,0.9)",
                }}
                aria-hidden="true"
              >
                {artist.name.slice(0, 1).toUpperCase()}
              </div>
              <div className="card-title">{artist.name}</div>
              <div className="card-sub">
                {artist.tracks.length} track{artist.tracks.length === 1 ? "" : "s"}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// ---- playlists ------------------------------------------------------------------

function PlaylistsView({ playlists, library }: { playlists: PlaylistLite[]; library: LibraryData }) {
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");

  function create(e: React.FormEvent) {
    e.preventDefault();
    const name = title.trim();
    if (!name) return;
    void api
      .createPlaylist(name)
      .then(() => pushToast(`Playlist “${name}” created`, "success"))
      .catch((err) => pushToast(String(err), "error"));
    setTitle("");
    setCreating(false);
  }

  return (
    <section>
      <PageHeader
        icon="playlist"
        title="Playlists"
        sub={`${playlists.length} playlist${playlists.length === 1 ? "" : "s"}`}
        actions={
          <button className="button" onClick={() => setCreating((c) => !c)}>
            <Icon name="plus" size={14} /> New playlist
          </button>
        }
      />

      {creating && (
        <form className="inline-form" onSubmit={create}>
          <input
            autoFocus
            placeholder="Playlist name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setCreating(false)}
          />
          <button className="button" type="submit">
            Create
          </button>
        </form>
      )}

      {playlists.length === 0 ? (
        <div className="state-block">
          <div className="big">≡</div>
          <h3>No playlists yet</h3>
          <p>Create one here, or use “Add to playlist…” on any track — you can also save the current queue as a playlist from the Queue panel.</p>
        </div>
      ) : (
        <div className="grid">
          {playlists.map((pl) => {
            const rows = library.playlistTracks[pl.id] ?? [];
            const count = rows.length || pl.trackCount;
            return (
              <button key={pl.id} className="card" onClick={() => openPlaylist(pl.id)}>
                <Artwork
                  track={rows.length > 0 ? trackById(library, rows[0].trackId) : null}
                  size={148}
                  rounded={12}
                />
                <div className="card-title">{pl.title}</div>
                <div className="card-sub">
                  {count} track{count === 1 ? "" : "s"}
                  {pl.updatedAt ? ` · ${relTime(pl.updatedAt)}` : ""}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

function trackById(library: LibraryData, id: string): Track | null {
  return library.tracks[id] ?? null;
}

function PlaylistDetail({ playlist, library }: { playlist: PlaylistLite | null; library: LibraryData }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");

  if (!playlist) {
    return (
      <div className="state-block">
        <div className="big">?</div>
        <h3>Playlist not found</h3>
        <p>It may have been deleted.</p>
      </div>
    );
  }

  const rows = library.playlistTracks[playlist.id] ?? [];
  const tracks = rows.map((r) => trackById(library, r.trackId)).filter((t): t is Track => !!t);

  async function guard(p: Promise<unknown>, ok: string) {
    try {
      await p;
      if (ok) pushToast(ok, "success");
    } catch (e) {
      pushToast(String(e), "error");
    }
  }

  return (
    <section>
      <button className="button ghost back-link" onClick={() => openPlaylist(null)}>
        <Icon name="chevron-up" size={13} /> All playlists
      </button>
      <PageHeader
        icon="playlist"
        title={playlist.title}
        sub={`${tracks.length} track${tracks.length === 1 ? "" : "s"}${playlist.description ? ` — ${playlist.description}` : ""}`}
        actions={
          <>
            <button
              className="button"
              disabled={tracks.length === 0}
              onClick={() => void api.startSequence(tracks, false)}
            >
              <Icon name="play" size={14} filled /> Play
            </button>
            <button
              className="button ghost"
              disabled={tracks.length === 0}
              onClick={() => void api.startSequence(tracks, true)}
            >
              <Icon name="shuffle" size={14} /> Shuffle
            </button>
            <button className="button ghost" onClick={() => setRenaming((r) => !r)}>
              Rename
            </button>
            <button
              className="button ghost"
              onClick={() =>
                void guard(
                  api.duplicatePlaylist(playlist.id, `${playlist.title} (copy)`),
                  "Playlist duplicated",
                )
              }
            >
              Duplicate
            </button>
            <button
              className="button ghost danger"
              onClick={() => {
                if (!window.confirm(`Delete playlist “${playlist.title}”?`)) return;
                void guard(api.deletePlaylist(playlist.id), "Playlist deleted");
                openPlaylist(null);
              }}
            >
              Delete
            </button>
          </>
        }
      />

      {renaming && (
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            const t = name.trim();
            if (t) void guard(api.renamePlaylist(playlist.id, t), "Playlist renamed");
            setRenaming(false);
          }}
        >
          <input
            autoFocus
            placeholder={playlist.title}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button className="button" type="submit">
            Save
          </button>
        </form>
      )}

      <TrackList
        tracks={tracks}
        showAlbum={false}
        emptyHint="Empty playlist — use “Add to playlist…” on any track."
        removeLabel="Remove from playlist"
        onRemove={(_, i) => {
          const row = rows[i];
          if (row) void guard(api.removeTrackFromPlaylist(playlist.id, row.trackId), "Removed");
        }}
        onMove={(i, up) => {
          const to = up ? i - 1 : i + 1;
          if (to < 0 || to >= rows.length) return;
          void guard(api.reorderPlaylistTrack(playlist.id, i, to), "");
        }}
      />
    </section>
  );
}

// ---- recently played -------------------------------------------------------------

function RecentlyPlayed({ library }: { library: LibraryData }) {
  return (
    <section>
      <PageHeader
        icon="clock"
        title="Recently Played"
        sub={`${library.history.length} entr${library.history.length === 1 ? "y" : "ies"}`}
        actions={
          library.history.length > 0 && (
            <button
              className="button ghost danger"
              onClick={() => {
                if (window.confirm("Clear the entire listening history?"))
                  void api.clearHistory().catch((e) => pushToast(String(e), "error"));
              }}
            >
              Clear history
            </button>
          )
        }
      />
      {library.history.length === 0 ? (
        <div className="state-block">
          <div className="big">◔</div>
          <h3>Nothing played yet</h3>
          <p>Your listening history builds up as you play (disable in Settings).</p>
        </div>
      ) : (
        <TrackList
          tracks={library.history.map((h) => h.track)}
          showAlbum={false}
          emptyHint="Nothing played yet."
          secondary={(t) => {
            const entry = library.history.find((h) => h.track.id === t.id);
            if (!entry) return null;
            const pct = Math.round(entry.completion * 100);
            return `${relTime(entry.playedAt)} · listened ${formatTime(entry.playedSecs)} (${pct}%)`;
          }}
          removeLabel="Remove from history"
          onRemove={(t) => {
            const entry = library.history.find((h) => h.track.id === t.id);
            if (entry) void api.removeHistoryEntry(entry.id).catch((e) => pushToast(String(e), "error"));
          }}
        />
      )}
    </section>
  );
}
