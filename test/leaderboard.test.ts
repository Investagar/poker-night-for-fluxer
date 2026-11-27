import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openDatabase } from '../server/db.ts';
import { PokerLeaderboard } from '../server/leaderboard.ts';

interface Seed {
  user: string;
  kind: 'buy-in' | 'rebuy' | 'cash-out';
  amountMinor: number;
  currency?: string;
  table?: string;
}

function harness(): { db: DatabaseSync; board: PokerLeaderboard } {
  const db = openDatabase(':memory:');
  return { db, board: new PokerLeaderboard(db) };
}

/** Insert users with real names and effective-or-not ledger rows; table ids default to t1. */
function seed(db: DatabaseSync, users: [string, string][], entries: Seed[]): void {
  const insertUser = db.prepare('INSERT INTO users (id, name, updated_at) VALUES (?, ?, 0)');
  for (const [id, name] of users) insertUser.run(id, name);
  const insertTable = db.prepare('INSERT OR IGNORE INTO tables (id, host_id, created_at) VALUES (?, ?, 0)');
  insertTable.run('t1', users[0][0]);
  insertTable.run('t2', users[0][0]);
  const insertCommand = db.prepare('INSERT OR IGNORE INTO commands (table_id, user_id, command_id, payload_hash, result, created_at) VALUES (?, ?, ?, ?, ?, 0)');
  const insert = db.prepare(`INSERT INTO ledger_entries (table_id, user_id, actor_id, command_id, kind, amount_minor, currency, chips, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`);
  const next = db.prepare('SELECT coalesce(max(id), 0) AS id FROM ledger_entries').get()!.id as number;
  entries.forEach((entry, index) => {
    const commandId = `cmd-${next + index}`;
    insertCommand.run(entry.table ?? 't1', entry.user, commandId, 'test', 'ok');
    insert.run(entry.table ?? 't1', entry.user, entry.user, commandId, entry.kind, entry.amountMinor,
      entry.currency ?? 'USD', index);
  });
}

test('an old opt-in cannot make a player visible after opting out', (t) => {
  const { db, board } = harness();
  t.after(() => db.close());
  seed(db, [['1001', 'Alice']], [{ user: '1001', kind: 'buy-in', amountMinor: 1000 }]);
  assert.equal(board.setOptIn('1001', true, '9999999999999999999'), true);
  assert.match(board.messages()[0], /Alice — In 1000/);
  assert.equal(board.setOptIn('1001', false, '10000000000000000000'), true);
  assert.equal(board.setOptIn('1001', true, '9999999999999999999'), false);
  assert.deepEqual(board.messages(), []);
});

test('only effective rows of opted-in players count, ranked by net with deterministic ties', (t) => {
  const { db, board } = harness();
  t.after(() => db.close());
  seed(db, [['1001', 'Alice'], ['1002', 'Bob'], ['1003', 'Carol'], ['1004', 'Dave']], [
    // Alice: in 2000 across two tables, out 2300 → net +300.
    { user: '1001', kind: 'buy-in', amountMinor: 2000, table: 't1' },
    { user: '1001', kind: 'cash-out', amountMinor: 2300, table: 't2' },
    // Bob: in 2000, out 1700 → net -300.
    { user: '1002', kind: 'buy-in', amountMinor: 2000 },
    { user: '1002', kind: 'cash-out', amountMinor: 1700 },
    // Carol: opted out → invisible despite a settled ledger.
    { user: '1003', kind: 'buy-in', amountMinor: 5000 },
    { user: '1003', kind: 'cash-out', amountMinor: 9000 },
    // Dave: zero net (zero cash-out of play money).
    { user: '1004', kind: 'buy-in', amountMinor: 0 },
    { user: '1004', kind: 'cash-out', amountMinor: 0 },
  ]);
  for (const id of ['1001', '1002', '1004']) board.setOptIn(id, true, id);
  const [message] = board.messages();
  assert.match(message, /Cash flow, not winnings/);
  assert.doesNotMatch(message, /Carol/);
  const rows = message.split('\n').filter((line) => / — In /.test(line));
  assert.deepEqual(rows, [
    'Alice — In 2000, Out 2300, Net 300',
    'Dave — In 0, Out 0, Net 0',
    'Bob — In 2000, Out 1700, Net -300',
  ]);

  // A superseded revision replaces its original; a voided root leaves no trace.
  seed(db, [['1005', 'Eve']], [{ user: '1005', kind: 'buy-in', amountMinor: 1200 }]);
  board.setOptIn('1005', true, '1005');
  const original = db.prepare('SELECT id FROM ledger_entries WHERE user_id = ?').get('1005') as { id: number };
  db.prepare(`INSERT INTO commands (table_id, user_id, command_id, payload_hash, result, created_at) VALUES ('t1', '1005', 'cmd-r1', 'h', 'ok', 0)`).run();
  db.prepare(`INSERT INTO ledger_entries (table_id, user_id, actor_id, command_id, kind, amount_minor, currency, chips, created_at, corrects_id, voided)
    VALUES ('t1', '1005', '1005', 'cmd-r1', 'rebuy', 1000, 'USD', 1, 20, ?, 0)`).run(original.id);
  const [withEve] = board.messages();
  assert.match(withEve, /Eve — In 1000, Out 0, Net -1000/, 'the revision replaces the original, not adds to it');
  db.prepare(`INSERT INTO commands (table_id, user_id, command_id, payload_hash, result, created_at) VALUES ('t1', '1005', 'cmd-r2', 'h', 'ok', 0)`).run();
  db.prepare(`INSERT INTO ledger_entries (table_id, user_id, actor_id, command_id, kind, amount_minor, currency, chips, created_at, corrects_id, voided)
    VALUES ('t1', '1005', '1005', 'cmd-r2', 'rebuy', 0, 'USD', 1, 21, ?, 1)`).run(original.id);
  const [afterVoid] = board.messages();
  assert.doesNotMatch(afterVoid, /Eve/, 'a voided root leaves no trace');

  // Deterministic tie: identical nets order by stable user id.
  seed(db, [['1006', 'Fay'], ['1007', 'Gus']], [
    { user: '1006', kind: 'buy-in', amountMinor: 1000 },
    { user: '1006', kind: 'cash-out', amountMinor: 1100 },
    { user: '1007', kind: 'buy-in', amountMinor: 1000 },
    { user: '1007', kind: 'cash-out', amountMinor: 1100 },
  ]);
  for (const id of ['1006', '1007']) board.setOptIn(id, true, id);
  const names = board.messages()[0].split('\n').filter((line) => / — In /.test(line)).map((line) => line.split(' — ')[0]);
  assert.deepEqual(names.filter((n) => n === 'Fay' || n === 'Gus'), ['Fay', 'Gus'], 'same net sorts by stable userId');
});

test('currencies never cross: separate sections, sorted, unknown codes stay raw', (t) => {
  const { db, board } = harness();
  t.after(() => db.close());
  seed(db, [['1001', 'Alice']], [
    { user: '1001', kind: 'buy-in', amountMinor: 1000, currency: 'EUR' },
    { user: '1001', kind: 'cash-out', amountMinor: 1200, currency: 'EUR' },
    { user: '1001', kind: 'buy-in', amountMinor: 2000, currency: 'USD' },
    { user: '1001', kind: 'buy-in', amountMinor: 500, currency: 'XYZ' },
  ]);
  board.setOptIn('1001', true, '1001');
  const [message] = board.messages();
  assert.ok(message.indexOf('EUR running settlements') < message.indexOf('USD running settlements'));
  assert.ok(message.indexOf('USD running settlements') < message.indexOf('XYZ running settlements'));
  assert.match(message, /^EUR running settlements\nAlice — In 1000, Out 1200, Net 200$/m);
  assert.match(message, /^USD running settlements\nAlice — In 2000, Out 0, Net -2000$/m);
  assert.match(message, /^XYZ running settlements\nAlice — In 500, Out 0, Net -500$/m, 'unknown currency stays raw, never converted');
});

test('chunks stay under the 2000-character provider limit', (t) => {
  const { db, board } = harness();
  t.after(() => db.close());
  const users: [string, string][] = Array.from({ length: 120 }, (_, i) => [String(2000 + i), `Player${i + 1}`]);
  const entries: Seed[] = users.flatMap(([id], i) => [
    { user: id, kind: 'buy-in' as const, amountMinor: 1000 + i },
    { user: id, kind: 'cash-out' as const, amountMinor: 1000 + i },
  ]);
  seed(db, users, entries);
  for (const [id] of users) board.setOptIn(id, true, id);
  const messages = board.messages();
  assert.ok(messages.length > 1, `${messages.length} chunks for 120 players`);
  for (const message of messages) assert.ok(message.length <= 2000, `length ${message.length}`);
  for (const message of messages) assert.match(message, /^USD running settlements/);
  const seen = messages.join('\n').match(/Player\d+ — In \d+, Out \d+, Net -?\d+/g) ?? [];
  assert.equal(seen.length, 120, 'every player appears exactly once across chunks');
});

test('hostile profile names are neutralized and never break the line format', (t) => {
  const { db, board } = harness();
  t.after(() => db.close());
  seed(db, [
    ['1001', '@Evil<>&"\'`||'], ['1002', '   '], ['1003', 'B'.repeat(200)],
  ], [
    { user: '1001', kind: 'buy-in', amountMinor: 1000 },
    { user: '1002', kind: 'buy-in', amountMinor: 1000 },
    { user: '1003', kind: 'buy-in', amountMinor: 1000 },
  ]);
  for (const id of ['1001', '1002', '1003']) board.setOptIn(id, true, id);
  const [message] = board.messages();
  const lines = message.split('\n').filter((line) => / — In /.test(line));
  assert.equal(lines.length, 3, 'three players, three lines');
  assert.equal(lines[1], 'player — In 1000, Out 0, Net -1000', 'blank name falls back to a neutral label');
  assert.ok(!lines.some((line) => line.includes('<>&') || line.includes('"') || line.includes('`') || line.includes('\\')));
  assert.ok(lines[0].startsWith('Evil'), 'markup and pipes are stripped from the name');
  assert.equal(lines[2].split(' — ')[0], 'B'.repeat(40), 'name clamped to 40 characters');
});
