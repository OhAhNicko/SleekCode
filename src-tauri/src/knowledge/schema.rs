//! Schema DDL and the migration ladder.
//!
//! `MIGRATIONS[i]` takes a database at `PRAGMA user_version = i` to `i + 1`, so
//! the current version is simply the array length. Each entry runs in its own
//! transaction and must be append-only: never edit a shipped migration, add a
//! new one. A database whose user_version is HIGHER than we know about (a
//! production build opening a database a dev build upgraded) is opened
//! read-only rather than guessed at.

pub const CURRENT_SCHEMA_VERSION: i32 = MIGRATIONS.len() as i32;

pub const MIGRATIONS: &[&str] = &[
    // ---- v1 ---------------------------------------------------------------
    r#"
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per projection FILE. The one-file-one-entity rule is what makes the
-- markdown a lossless mirror of the store and the store rebuildable from it.
CREATE TABLE notes (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,
  title        TEXT NOT NULL,
  slug         TEXT NOT NULL,
  content      TEXT NOT NULL,                 -- markdown body, frontmatter stripped
  tags         TEXT NOT NULL DEFAULT '[]',    -- JSON array
  file_path    TEXT NOT NULL UNIQUE,          -- relative to .project-memory/
  revision     INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0,
  pinned_core  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_notes_type ON notes(type, archived);
CREATE INDEX idx_notes_slug ON notes(slug);

-- target_id NULL is a BROKEN link and is kept deliberately: a wiki link to a
-- note that does not exist yet stays visible, and is rebound when it appears.
CREATE TABLE relations (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_id    TEXT,
  target_title TEXT,
  heading      TEXT,
  rel_type     TEXT NOT NULL,
  origin       TEXT NOT NULL DEFAULT 'wiki',  -- wiki (derived) | explicit (API)
  created_at   INTEGER NOT NULL,
  created_by   TEXT NOT NULL
);
CREATE INDEX idx_rel_source ON relations(source_id);
CREATE INDEX idx_rel_target ON relations(target_id);

-- Full snapshots, not patches: a losing side of a conflict has to be
-- recoverable verbatim, and note-sized documents make the storage a non-issue.
-- `kind` is reserved so a later patch encoding needs no migration.
CREATE TABLE revisions (
  entity_id     TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  base_revision INTEGER,
  content_hash  TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'snapshot',
  content       TEXT NOT NULL,
  title         TEXT NOT NULL,
  actor_type    TEXT NOT NULL,
  agent_kind    TEXT,
  session_id    TEXT,
  pane_id       TEXT,
  reason        TEXT,
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (entity_id, revision)
);

-- The last seq IS the project's global knowledge revision. One
-- crash-consistent counter, no second source of truth to drift.
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL,
  entity_id  TEXT,
  revision   INTEGER,
  actor_type TEXT NOT NULL,
  agent_kind TEXT,
  session_id TEXT,
  pane_id    TEXT,
  summary    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_entity ON events(entity_id);

CREATE TABLE conflicts (
  id               TEXT PRIMARY KEY,
  entity_id        TEXT NOT NULL,
  base_revision    INTEGER NOT NULL,
  current_revision INTEGER NOT NULL,
  theirs_content   TEXT NOT NULL,
  theirs_title     TEXT,
  actor_type       TEXT NOT NULL,
  agent_kind       TEXT,
  session_id       TEXT,
  pane_id          TEXT,
  source           TEXT NOT NULL,               -- api | file
  status           TEXT NOT NULL DEFAULT 'open',
  created_at       INTEGER NOT NULL,
  resolved_at      INTEGER,
  resolved_by      TEXT
);
CREATE INDEX idx_conflicts_open ON conflicts(status) WHERE status='open';

CREATE TABLE agent_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pane_id       TEXT,
  agent_kind    TEXT NOT NULL,
  cli_session_id TEXT,
  pid           INTEGER,
  status        TEXT NOT NULL DEFAULT 'active',
  connected_at  INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

-- What we last wrote to / read from each projection file. The mtime+size fast
-- skip on the open-time reconcile walk is what keeps reopening a large vault
-- from re-parsing every file.
CREATE TABLE sync_state (
  file_path           TEXT PRIMARY KEY,
  entity_id           TEXT,
  last_projected_hash TEXT,
  last_imported_hash  TEXT,
  last_projected_at   INTEGER,
  last_seen_mtime     INTEGER,
  last_seen_size      INTEGER
);

CREATE TABLE handoffs (
  id            TEXT PRIMARY KEY,
  task          TEXT NOT NULL,
  completed     TEXT NOT NULL DEFAULT '[]',
  current_work  TEXT,
  remaining     TEXT NOT NULL DEFAULT '[]',
  files_changed TEXT NOT NULL DEFAULT '[]',
  decisions     TEXT NOT NULL DEFAULT '[]',
  known_issues  TEXT NOT NULL DEFAULT '[]',
  next_action   TEXT,
  status        TEXT NOT NULL DEFAULT 'open',
  rendered      TEXT NOT NULL DEFAULT '',
  actor_type    TEXT NOT NULL,
  agent_kind    TEXT,
  session_id    TEXT,
  pane_id       TEXT,
  created_at    INTEGER NOT NULL,
  consumed_at   INTEGER,
  consumed_by   TEXT
);

CREATE TABLE tasks (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  detail     TEXT,
  status     TEXT NOT NULL DEFAULT 'open',
  assignee   TEXT,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);

-- External-content FTS5: the index stores no copy of the text, it reads back
-- through `notes` by rowid. `notes` keeps its implicit rowid (the TEXT primary
-- key does not make it WITHOUT ROWID), so this is safe. The trigger triple is
-- mandatory with external content — without it the index silently rots.
CREATE VIRTUAL TABLE notes_fts USING fts5(
  title, content, tags,
  content='notes', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;
CREATE TRIGGER notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
END;
CREATE TRIGGER notes_au AFTER UPDATE OF title, content, tags ON notes BEGIN
  INSERT INTO notes_fts(notes_fts, rowid, title, content, tags)
  VALUES ('delete', old.rowid, old.title, old.content, old.tags);
  INSERT INTO notes_fts(rowid, title, content, tags)
  VALUES (new.rowid, new.title, new.content, new.tags);
END;
"#,
];
