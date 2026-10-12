-- Design draft, not yet applied to Cloudflare D1.
-- Authentication provider/session tables added after provider selection.
PRAGMA foreign_keys = ON;
CREATE TABLE members (
 id TEXT PRIMARY KEY,
 internal_label TEXT NOT NULL,
 membership TEXT NOT NULL CHECK(membership IN ('current','alumni')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE accounts (
 id TEXT PRIMARY KEY,
 member_id TEXT NOT NULL UNIQUE REFERENCES members(id),
 auth_subject TEXT NOT NULL UNIQUE,
 role TEXT NOT NULL CHECK(role IN ('member','admin')),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
);
CREATE TABLE works (
 id TEXT PRIMARY KEY,
 author_id TEXT NOT NULL REFERENCES members(id),
 title TEXT NOT NULL,
 credited_name TEXT NOT NULL,
 member_status TEXT NOT NULL DEFAULT 'draft' CHECK(member_status IN ('draft','published','withdrawn')),
 search_text TEXT NOT NULL DEFAULT '',
 extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK(extraction_status IN ('pending','ready','failed','manual')),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX works_author ON works(author_id);
CREATE INDEX works_status ON works(member_status);
CREATE TABLE work_files (
 id TEXT PRIMARY KEY,
 work_id TEXT NOT NULL REFERENCES works(id),
 object_key TEXT NOT NULL UNIQUE,
 version INTEGER NOT NULL CHECK(version > 0),
 bytes INTEGER NOT NULL CHECK(bytes > 0),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','ready','failed')),
 UNIQUE(work_id,version)
);
-- Publish by switching published_revision_id only after administrator confirmation.
-- Revision JSON stores versioned PUBLIC fields, never private full text or credentials.
CREATE TABLE content_entries (
 id TEXT PRIMARY KEY,
 kind TEXT NOT NULL CHECK(kind IN ('introduction','issue','message','event','store','notice','page')),
 slug TEXT NOT NULL UNIQUE,
 work_id TEXT REFERENCES works(id),
 author_id TEXT REFERENCES members(id),
 published_revision_id TEXT REFERENCES content_revisions(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK(kind != 'introduction' OR work_id IS NOT NULL)
);
CREATE TABLE content_revisions (
 id TEXT PRIMARY KEY,
 entry_id TEXT NOT NULL REFERENCES content_entries(id),
 payload TEXT NOT NULL CHECK(json_valid(payload)),
 created_by TEXT NOT NULL REFERENCES accounts(id),
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX revisions_entry ON content_revisions(entry_id);
CREATE TRIGGER verify_published_revision
BEFORE UPDATE OF published_revision_id ON content_entries
WHEN NEW.published_revision_id IS NOT NULL
BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM content_revisions WHERE id=NEW.published_revision_id AND entry_id=NEW.id
 ) THEN RAISE(ABORT,'revision belongs to another entry') END;
END;
CREATE TABLE issue_works (
 issue_revision_id TEXT NOT NULL REFERENCES content_revisions(id),
 work_id TEXT NOT NULL REFERENCES works(id),
 position INTEGER NOT NULL CHECK(position > 0),
 page_label TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(issue_revision_id,work_id),
 UNIQUE(issue_revision_id,position)
);
CREATE TABLE store_issues (
 store_revision_id TEXT NOT NULL REFERENCES content_revisions(id),
 issue_id TEXT NOT NULL REFERENCES content_entries(id),
 note TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(store_revision_id,issue_id)
);
CREATE TABLE audit_log (
 id TEXT PRIMARY KEY,
 actor_id TEXT NOT NULL REFERENCES accounts(id),
 action TEXT NOT NULL,
 target_id TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
