import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

const migrations = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatar TEXT,
    updated_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX sessions_user ON sessions(user_id);
  CREATE INDEX sessions_expiry ON sessions(expires_at);
  CREATE TABLE tables (
    id TEXT PRIMARY KEY,
    host_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL,
    closed_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1
  ) STRICT;
  CREATE INDEX tables_open_host ON tables(host_id) WHERE closed_at IS NULL;
  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(id),
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  ) STRICT;
  CREATE UNIQUE INDEX invites_active ON invites(table_id) WHERE revoked_at IS NULL;
  CREATE TABLE seats (
    table_id TEXT NOT NULL REFERENCES tables(id),
    seat INTEGER NOT NULL CHECK (seat BETWEEN 1 AND 10),
    user_id TEXT NOT NULL REFERENCES users(id),
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (table_id, seat),
    UNIQUE (table_id, user_id)
  ) STRICT;
  `,
  `
  ALTER TABLE tables ADD COLUMN settings TEXT;
  ALTER TABLE tables ADD COLUMN game TEXT;
  ALTER TABLE seats ADD COLUMN stack INTEGER NOT NULL DEFAULT 0 CHECK (stack >= 0);
  ALTER TABLE seats ADD COLUMN away INTEGER NOT NULL DEFAULT 0 CHECK (away IN (0, 1));
  ALTER TABLE seats ADD COLUMN missed INTEGER NOT NULL DEFAULT 0 CHECK (missed >= 0);
  CREATE TABLE commands (
    table_id TEXT NOT NULL REFERENCES tables(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    command_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    result TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (table_id, user_id, command_id)
  ) STRICT;
  CREATE INDEX commands_created ON commands(created_at);
  `,
  `
  ALTER TABLE commands ADD COLUMN command_type TEXT;
  CREATE TABLE ledger_entries (
    id INTEGER PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    actor_id TEXT NOT NULL REFERENCES users(id),
    command_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('buy-in', 'rebuy', 'cash-out')),
    amount_minor INTEGER NOT NULL CHECK (amount_minor BETWEEN 0 AND 100000000000),
    currency TEXT NOT NULL CHECK (currency GLOB '[A-Z][A-Z][A-Z]'),
    chips INTEGER NOT NULL CHECK (chips > 0),
    created_at INTEGER NOT NULL,
    UNIQUE (table_id, actor_id, command_id),
    FOREIGN KEY (table_id, actor_id, command_id) REFERENCES commands(table_id, user_id, command_id)
      DEFERRABLE INITIALLY DEFERRED
  ) STRICT;
  CREATE INDEX ledger_table ON ledger_entries(table_id, id);
  CREATE INDEX ledger_player ON ledger_entries(user_id, table_id, id);
  CREATE TABLE command_retries (
    id INTEGER PRIMARY KEY,
    table_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    command_id TEXT NOT NULL,
    received_hash TEXT NOT NULL,
    reused INTEGER NOT NULL CHECK (reused IN (0, 1)),
    attempted_at INTEGER NOT NULL,
    FOREIGN KEY (table_id, user_id, command_id) REFERENCES commands(table_id, user_id, command_id)
  ) STRICT;
  CREATE INDEX command_retries_command ON command_retries(table_id, user_id, command_id);
  CREATE TABLE hand_history (
    table_id TEXT NOT NULL REFERENCES tables(id),
    hand_id INTEGER NOT NULL,
    result TEXT NOT NULL,
    PRIMARY KEY (table_id, hand_id)
  ) STRICT;
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL REFERENCES tables(id),
    actor_id TEXT NOT NULL REFERENCES users(id),
    command_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('invite', 'settlement')),
    channel_id TEXT NOT NULL,
    invite_hash TEXT REFERENCES invites(token_hash),
    ledger_through INTEGER REFERENCES ledger_entries(id),
    created_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'unconfirmed')),
    message_id TEXT,
    UNIQUE (table_id, actor_id, command_id),
    CHECK ((kind = 'invite' AND invite_hash IS NOT NULL AND ledger_through IS NULL)
      OR (kind = 'settlement' AND invite_hash IS NULL AND ledger_through IS NOT NULL))
  ) STRICT;
  `,
  `
  ALTER TABLE ledger_entries ADD COLUMN corrects_id INTEGER REFERENCES ledger_entries(id);
  ALTER TABLE ledger_entries ADD COLUMN correction_reason TEXT;
  ALTER TABLE ledger_entries ADD COLUMN voided INTEGER NOT NULL DEFAULT 0 CHECK (voided IN (0, 1));
  ALTER TABLE ledger_entries ADD COLUMN hand_no INTEGER;
  CREATE INDEX ledger_root ON ledger_entries(table_id, coalesce(corrects_id, id), id);
  `,
  `
  CREATE TABLE bot_table_commands (
    message_id TEXT PRIMARY KEY,
    table_id TEXT NOT NULL UNIQUE REFERENCES tables(id)
  ) STRICT;
  CREATE TABLE poker_leaderboard_opt_in (
    user_id TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    message_id TEXT NOT NULL
  ) STRICT;
  `,
  `
  CREATE TABLE table_entry_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_id TEXT NOT NULL REFERENCES tables(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    requested_hand INTEGER NOT NULL,
    remaining TEXT NOT NULL,
    declined INTEGER NOT NULL DEFAULT 0 CHECK (declined IN (0, 1)),
    UNIQUE (table_id, user_id)
  ) STRICT;
  `,
];

export const SCHEMA_VERSION = migrations.length;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true, timeout: 5000 });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const current = scalar(db, 'PRAGMA user_version');
  if (current > SCHEMA_VERSION) throw new Error(`Database schema ${current} is newer than this release supports`);
  for (let version = current; version < SCHEMA_VERSION; version += 1) {
    transaction(db, () => {
      db.exec(migrations[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
    });
  }
  return db;
}

/** First column of the first row as a number, e.g. `SELECT count(*) ...`. */
export function scalar(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): number {
  const row = db.prepare(sql).get(...params);
  const value = row ? Object.values(row)[0] : undefined;
  if (typeof value !== 'number') throw new Error('Expected a numeric result');
  return value;
}

export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
