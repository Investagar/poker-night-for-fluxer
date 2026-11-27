import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { LedgerView, Snapshot } from '../server/protocol.ts';
import { admitGuest, harness, request, signIn } from './helpers.ts';

const cli = (...args: string[]) => execFileSync(process.execPath, ['server/backup.ts', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

test('an online SQLite backup restores real sessions, ledger deduplication, and a paused hand', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'pokerbot-restore-drill-'));
  const restoredDir = join(scratch, 'restored');
  mkdirSync(restoredDir);
  // Closures run in registration order: the restored app must release its SQLite handle before the scratch
  // directory is deleted (Windows refuses to remove open database files).
  let closeRestored: (() => Promise<void>) | null = null;
  t.after(async () => { if (closeRestored) await closeRestored(); });
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const live = await harness();
  t.after(() => live.close());
  const [host, guest] = await Promise.all(['1001', '1002'].map((id) => signIn(live, id)));
  const { tableId, invite } = (await request(live, 'POST', '/api/tables', host)).json();
  const path = `/api/tables/${tableId}`;
  const terms = { smallBlind: 5, bigBlind: 10, startingChips: 1000, turnSeconds: 30, buyInMinor: 1550, currency: 'USD' };
  assert.ok(live.play.command('1001', tableId, 'drill-settings', { type: 'settings', settings: terms }).ok);
  // The approval seats the guest and issues the stack in one command.
  assert.ok(await admitGuest(live, tableId, '1002', guest, invite,
    { chips: terms.startingChips, amountMinor: terms.buyInMinor, currency: terms.currency }));
  const buy = { type: 'buyin', userId: '1001', amountMinor: terms.buyInMinor, chips: terms.startingChips, currency: terms.currency };
  const receipt = live.play.command('1001', tableId, 'drill-buy', buy);
  assert.ok(receipt.ok);
  const historyPath = `/api/history/${tableId}`;
  const guestEntry = (await request(live, 'GET', historyPath, guest)).json<LedgerView>().entries[0];
  const correction = { type: 'correct-ledger', entryId: guestEntry.id, amountMinor: 1650, chips: 1000, reason: 'Fix transposed amount' };
  const revised = live.play.command('1001', tableId, 'drill-buy-fix', correction);
  assert.ok(revised.ok);
  assert.ok(live.play.command('1001', tableId, 'drill-start', { type: 'start', dealer: 1 }).ok);
  const before = (await request(live, 'GET', path, host)).json<Snapshot>();
  assert.ok(before.hand && before.you.cards.length === 2);
  assert.ok(statSync(live.dbPath + '-wal').size > 0);

  const backup = join(scratch, 'portable.sqlite');
  const destination = join(restoredDir, 'pokerbot.sqlite');
  assert.match(cli('backup', live.dbPath, backup), /backup complete/);
  // Windows ACLs stand in for the POSIX mode; chmod there cannot enforce 0600.
  if (process.platform !== 'win32') assert.equal(statSync(backup).mode & 0o777, 0o600);
  assert.equal(existsSync(backup + '-wal'), false);
  assert.ok(live.play.command('1001', tableId, 'drill-fold', {
    type: 'act', action: 'fold', handId: before.hand.id, turn: before.hand.turn,
  }).ok);
  assert.equal(live.play.view(tableId, '1001', new Set()).hand, null, 'live state advanced after the backup');
  assert.match(cli('restore', backup, destination), /restore complete/);
  assert.throws(() => cli('restore', backup, destination), /already exists/);
  const invalid = join(scratch, 'not-sqlite');
  writeFileSync(invalid, 'not a database');
  assert.throws(() => cli('restore', invalid, join(scratch, 'invalid.sqlite')));
  assert.equal(existsSync(join(scratch, 'invalid.sqlite')), false);

  const restored = await harness({ dir: restoredDir });
  closeRestored = () => restored.close();
  assert.equal((await request(restored, 'GET', '/api/session', guest)).json().user.id, '1002');
  const after = (await request(restored, 'GET', path, host)).json<Snapshot>();
  assert.equal(after.game.paused, true);
  assert.equal(after.hand?.turn, before.hand.turn);
  assert.equal(after.hand?.deadline, null);
  assert.deepEqual(after.you.cards, before.you.cards);
  assert.deepEqual(after.seats.map((s) => s?.stack), before.seats.map((s) => s?.stack));
  assert.deepEqual(restored.play.command('1001', tableId, 'drill-buy', buy), receipt);
  assert.deepEqual(restored.play.command('1001', tableId, 'drill-buy-fix', correction), revised);
  const ledger = (await request(restored, 'GET', historyPath, host)).json<LedgerView>();
  assert.equal(ledger.entries.length, 3);
  assert.deepEqual(ledger.entries[0].correction, { entryId: guestEntry.id, reason: 'Fix transposed amount', voided: false });
  assert.deepEqual(ledger.totals.map((row) => row.inMinor), [1550, 1650]);
  assert.equal(ledger.hands.length, 0);
  // The restore also carries command failures: the paused hand blocks a cash-out.
  const cashout = restored.play.command('1001', tableId, 'drill-cashout', { type: 'cashout', userId: '1002', amountMinor: 1550, currency: 'USD', chips: 1000 });
  assert.equal(cashout.ok ? 'ok' : cashout.code, 'hand-in-progress');
});
