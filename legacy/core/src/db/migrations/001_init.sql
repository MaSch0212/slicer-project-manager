CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT NOT NULL,
  library_dir   TEXT NOT NULL UNIQUE,
  pw_hash       BLOB,
  pw_salt       BLOB,
  pw_iterations INTEGER,
  pw_algo       TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  quota_bytes   INTEGER,
  created_at    INTEGER NOT NULL,
  activated_at  INTEGER
);

CREATE TABLE activation_tokens (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_activation_tokens_user ON activation_tokens(user_id);
CREATE UNIQUE INDEX idx_activation_tokens_hash ON activation_tokens(token_hash);

CREATE TABLE sessions (
  token_hash   BLOB PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  dir_name    TEXT NOT NULL,
  website     TEXT,
  notes       TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok', 'missing')),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (owner_id, dir_name)
);
CREATE INDEX idx_projects_owner ON projects(owner_id, is_archived);
CREATE INDEX idx_projects_name ON projects(owner_id, name COLLATE NOCASE);

CREATE TABLE tags (
  id       INTEGER PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  UNIQUE (owner_id, name COLLATE NOCASE)
);

CREATE TABLE project_tags (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, tag_id)
);
CREATE INDEX idx_project_tags_tag ON project_tags(tag_id);

CREATE TABLE files (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  rel_path     TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('model', 'slicer_project', 'other')),
  slicer       TEXT,
  size_bytes   INTEGER NOT NULL,
  mtime_ms     INTEGER NOT NULL,
  content_hash BLOB,
  UNIQUE (project_id, rel_path)
);
CREATE INDEX idx_files_project ON files(project_id);

CREATE TABLE previews (
  file_id     TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  state       TEXT NOT NULL CHECK (state IN ('pending', 'ready', 'failed', 'unsupported')),
  source      TEXT,
  png_path    TEXT,
  width       INTEGER,
  height      INTEGER,
  source_hash BLOB,
  error       TEXT,
  attempts    INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX idx_previews_state ON previews(state);

CREATE TABLE user_settings (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  value   TEXT,
  PRIMARY KEY (user_id, key)
);
