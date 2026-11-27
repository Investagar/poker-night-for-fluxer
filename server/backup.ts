import { chmodSync, closeSync, copyFileSync, fsyncSync, linkSync, lstatSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, scalar } from './db.ts';

const SIDECARS = ['-wal', '-shm', '-journal'];
const exists = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

function verify(path: string): void {
  using db = new DatabaseSync(path, { readOnly: true });
  const schema = scalar(db, 'PRAGMA user_version');
  if (schema < 1 || schema > SCHEMA_VERSION) throw new Error('Unsupported Pokerbot database schema.');
  // Reject unrelated SQLite files even when their user_version happens to match.
  if (scalar(db, "SELECT count(*) FROM sqlite_schema WHERE type = 'table' AND name IN ('users', 'tables', 'seats', 'sessions', 'invites')") !== 5) {
    throw new Error('This is not a Pokerbot database.');
  }
  const check = db.prepare('PRAGMA integrity_check').all();
  if (check.length !== 1 || check[0].integrity_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) {
    throw new Error('SQLite integrity or foreign-key check failed.');
  }
}

function sync(path: string): void {
  // Windows denies fsync on a read-only handle (EPERM); a read-write handle works and changes nothing.
  const fd = openSync(path, process.platform === 'win32' ? 'r+' : 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Publish a verified, private, single-file image without ever overwriting an existing file. */
function publish(path: string, prepare: (tmp: string) => void): void {
  const dest = resolve(path);
  if (exists(dest) || SIDECARS.some((suffix) => exists(dest + suffix))) {
    throw new Error('Destination or SQLite sidecar already exists. Keep it and choose a fresh path.');
  }
  const directory = dirname(dest);
  const temp = mkdtempSync(join(directory, '.pokerbot-sqlite-'));
  const image = join(temp, 'image.sqlite');
  try {
    prepare(image);
    chmodSync(image, 0o600);
    verify(image);
    sync(image);
    linkSync(image, dest); // Same filesystem, atomic and refuses an existing destination.
    if (process.platform !== 'win32') sync(directory); // Node cannot open a Windows directory for fsync.
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Online SQLite snapshot, including committed pages still in WAL. */
export function backupDatabase(source: string, destination: string): void {
  using db = new DatabaseSync(resolve(source), { readOnly: true, timeout: 5000 });
  publish(destination, (tmp) => db.prepare('VACUUM INTO ?').run(tmp));
}

/** Offline only. The service must not be running at the destination path. */
export function restoreDatabase(backup: string, destination: string): void {
  if (SIDECARS.some((suffix) => exists(backup + suffix))) {
    throw new Error('Restore from a standalone backup, not a database with sidecars.');
  }
  publish(destination, (tmp) => copyFileSync(backup, tmp));
}

if (import.meta.main) {
  const [operation, source, destination, ...extra] = process.argv.slice(2);
  if ((operation !== 'backup' && operation !== 'restore') || !source || !destination || extra.length) {
    console.error('Usage: node dist/server/backup.js backup|restore SOURCE DESTINATION');
    process.exitCode = 2;
  } else {
    try {
      (operation === 'backup' ? backupDatabase : restoreDatabase)(source, destination);
      console.log(`${operation} complete`);
    } catch (error) {
      console.error(`${operation} failed: ${error instanceof Error ? error.message : 'unknown error'}`);
      process.exitCode = 1;
    }
  }
}
