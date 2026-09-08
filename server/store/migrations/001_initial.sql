-- PostgreSQL target schema for the accountstore.Repository boundary.
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/store/migrations/001_initial.sql
BEGIN;

CREATE TABLE IF NOT EXISTS users (
    id              text PRIMARY KEY,
    username        text NOT NULL,
    password_hash   text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_username_normalized UNIQUE (username)
);

CREATE TABLE IF NOT EXISTS artists (
    id              text PRIMARY KEY,
    source          text NOT NULL,
    name            text NOT NULL,
    artwork_url     text NOT NULL DEFAULT '',
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS albums (
    id              text PRIMARY KEY,
    source          text NOT NULL,
    artist_id       text REFERENCES artists(id) ON DELETE SET NULL,
    title           text NOT NULL,
    artwork_url     text NOT NULL DEFAULT '',
    release_year    text NOT NULL DEFAULT '',
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tracks (
    id              text PRIMARY KEY,
    source_id       text NOT NULL,
    source          text NOT NULL,
    artist_id       text REFERENCES artists(id) ON DELETE SET NULL,
    album_id        text REFERENCES albums(id) ON DELETE SET NULL,
    title           text NOT NULL,
    artist_name     text NOT NULL DEFAULT '',
    album_title     text NOT NULL DEFAULT '',
    canonical_url   text NOT NULL DEFAULT '',
    artwork_url     text NOT NULL DEFAULT '',
    duration_seconds double precision NOT NULL DEFAULT 0,
    explicit        boolean NOT NULL DEFAULT false,
    metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tracks_source_identity UNIQUE (source, source_id)
);

CREATE TABLE IF NOT EXISTS playlists (
    id              text PRIMARY KEY,
    user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name            text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
    description     text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS playlists_user_updated ON playlists(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id     text NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
    track_id        text NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    position        integer NOT NULL CHECK (position >= 0),
    added_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (playlist_id, position),
    CONSTRAINT playlist_track_once UNIQUE (playlist_id, track_id)
);

CREATE TABLE IF NOT EXISTS likes (
    user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id        text NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, track_id)
);

CREATE INDEX IF NOT EXISTS likes_user_created ON likes(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS listening_history (
    id              bigserial PRIMARY KEY,
    user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id        text NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    started_at      timestamptz NOT NULL DEFAULT now(),
    completed       boolean NOT NULL DEFAULT false,
    skipped         boolean NOT NULL DEFAULT false,
    listened_seconds double precision NOT NULL DEFAULT 0 CHECK (listened_seconds >= 0),
    context         text NOT NULL DEFAULT '',
    session_id      text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS history_user_started ON listening_history(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS history_user_track ON listening_history(user_id, track_id);

CREATE TABLE IF NOT EXISTS play_stats (
    user_id         text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    track_id        text NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
    play_count      integer NOT NULL DEFAULT 0 CHECK (play_count >= 0),
    completed_count integer NOT NULL DEFAULT 0 CHECK (completed_count >= 0),
    skip_count      integer NOT NULL DEFAULT 0 CHECK (skip_count >= 0),
    replay_count    integer NOT NULL DEFAULT 0 CHECK (replay_count >= 0),
    last_played_at  timestamptz,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, track_id)
);

CREATE TABLE IF NOT EXISTS user_preferences (
    user_id         text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    settings        jsonb NOT NULL DEFAULT '{}'::jsonb,
    taste_profile   jsonb NOT NULL DEFAULT '{}'::jsonb,
    queue_state     jsonb,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMIT;
