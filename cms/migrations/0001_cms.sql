-- New CMS foundation; supersedes design/schema-draft.sql.
PRAGMA foreign_keys=ON;
CREATE TABLE authors(id TEXT PRIMARY KEY, label TEXT NOT NULL, membership TEXT NOT NULL CHECK(membership IN ('current','alumni')));
CREATE TABLE works(id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES authors(id), title TEXT NOT NULL, credited_name TEXT NOT NULL, search_text TEXT NOT NULL DEFAULT '', member_status TEXT NOT NULL DEFAULT 'draft' CHECK(member_status IN ('draft','published')), pdf_key TEXT, updated_at TEXT NOT NULL);
CREATE INDEX works_author ON works(author_id);
CREATE TABLE entries(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('introduction','issue','message','event','store','notice','page')), draft_json TEXT NOT NULL CHECK(json_valid(draft_json)), published_json TEXT CHECK(published_json IS NULL OR json_valid(published_json)), version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL);
CREATE INDEX entries_kind ON entries(kind);
CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, target_id TEXT NOT NULL, actor TEXT NOT NULL DEFAULT 'shared-admin', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE login_attempts(key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
