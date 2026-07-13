const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');

const DATA_DIR = path.resolve(config.DATA_DIR);
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'rush.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'brother' CHECK (role IN ('brother','admin')),
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pnms (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  phone        TEXT,
  instagram    TEXT,
  hometown     TEXT,
  photo        TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected')),
  decision     TEXT NOT NULL DEFAULT 'undecided' CHECK (decision IN ('undecided','bid','no_bid')),
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS votes (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pnm_id     INTEGER NOT NULL REFERENCES pnms(id) ON DELETE CASCADE,
  value      INTEGER NOT NULL CHECK (value IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, pnm_id)
);

CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY,
  pnm_id     INTEGER NOT NULL REFERENCES pnms(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id  INTEGER REFERENCES notes(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reactions (
  id      INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji   TEXT NOT NULL CHECK (emoji IN ('👍','👎','❤️','🔥','😂','🦑')),
  UNIQUE (note_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_votes_pnm ON votes(pnm_id);
CREATE INDEX IF NOT EXISTS idx_notes_pnm ON notes(pnm_id);
CREATE INDEX IF NOT EXISTS idx_reactions_note ON reactions(note_id);
`);

// Migration guard: CREATE TABLE IF NOT EXISTS above won't add parent_id to
// an existing notes table on an already-deployed DB, so add it here if
// missing. Runs unconditionally on startup, same as the indexes below.
const noteCols = db.prepare('PRAGMA table_info(notes)').all();
if (!noteCols.some((c) => c.name === 'parent_id')) {
  db.exec('ALTER TABLE notes ADD COLUMN parent_id INTEGER REFERENCES notes(id) ON DELETE CASCADE');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_notes_parent ON notes(parent_id)');

const seedSetting = db.prepare(
  'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
);
const seedDefaults = db.transaction(() => {
  seedSetting.run('vote_visibility', 'anonymous');
  seedSetting.run('voting_frozen', '0');
  seedSetting.run('signups_closed', '0');
});
seedDefaults();

const getSettingStmt = db.prepare('SELECT value FROM settings WHERE key = ?');
const setSettingStmt = db.prepare(
  'INSERT INTO settings (key, value) VALUES (?, ?) ' +
    'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
);

function getSetting(key) {
  const row = getSettingStmt.get(key);
  return row ? row.value : undefined;
}

function setSetting(key, value) {
  setSettingStmt.run(key, String(value));
}

module.exports = {
  db,
  getSetting,
  setSetting,
  DATA_DIR,
  UPLOADS_DIR,
};
