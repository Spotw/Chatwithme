CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'failed')),
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  checked_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX jobs_pending ON jobs(status, checked_at);

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  metadata TEXT NOT NULL,
  source_job TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX pages_updated ON pages(updated_at DESC);
