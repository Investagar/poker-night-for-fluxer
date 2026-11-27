import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Ack, Command, LedgerView } from '../server/protocol.ts';
import { CHANNEL_ID } from './fake-fluxer.ts';
import { admitGuest, harness, request, signIn } from './helpers.ts';

const terms = { smallBlind: 5, bigBlind: 10, startingChips: 1000, turnSeconds: 30, buyInMinor: 2000, currency: 'USD' };
const buy: Command = { type: 'buyin', userId: '1002', amountMinor: 2000, chips: 1000, currency: 'USD' };
const payout: Command = { type: 'cashout', userId: '1002', amountMinor: 2300, chips: 1000, currency: 'USD' };
const code = (ack: Ack) => ack.ok ? 'ok' : ack.code;

test('settlements and failed retries are durable, private, and independent of chip counts', async (t) => {
  let h = await harness();
  t.after(() => h.close());
  const [host, guest, outsider] = await Promise.all(['1001', '1002', '1003'].map((id) => signIn(h, id)));
  const { tableId, invite } = (await request(h, 'POST', '/api/tables', host)).json();
  const path = `/api/tables/${tableId}`;
  const history = `/api/history/${tableId}`;
  // Approval seats the guest and records the buy-in in the same command.
  await admitGuest(h, tableId, '1002', guest, invite, { chips: terms.startingChips, amountMinor: terms.buyInMinor, currency: terms.currency });
  const run = (userId: string, id: string, command: unknown) => h.play.command(userId, tableId, id, command);
  assert.equal(code(run('1001', 'old-quote', { ...buy, currency: 'EUR' })), 'has-chips', 'a funded seat refuses before the quote is compared');
  assert.equal(code(run('1001', 'old-quote', buy)), 'command-id-reused');
  assert.equal(code(run('1001', 'buy-host-1', { ...buy, userId: '1001' })), 'ok');
  assert.equal(code(run('1001', 'currency-change', { type: 'settings', settings: { ...terms, currency: 'EUR' } })), 'currency-locked');
  assert.equal(code(run('1002', 'guest-cashout', payout)), 'host-only');
  assert.equal(code(run('1001', 'cashout-wrong-stack', { ...payout, chips: 999 })), 'stale-cashout');
  assert.equal(code(run('1001', 'cashout-fraction', { ...payout, amountMinor: 2300.5 })), 'bad-command');
  assert.equal(code(run('1001', 'close-unsettled', { type: 'close' })), 'unsettled-stacks');
  const paid = run('1001', 'cashout-guest-1', payout);
  assert.equal(code(paid), 'ok');
  assert.equal(h.play.view(tableId, '1002', new Set()).seats[1]?.stack, 0);
  h = await h.restart();
  assert.deepEqual(run('1001', 'cashout-guest-1', payout), paid);
  assert.equal(code(run('1001', 'old-quote', { ...buy, currency: 'EUR' })), 'has-chips');
  assert.equal(code(run('1001', 'buy-guest-2', buy)), 'ok');
  const view = (async (cookie: string) => (await request(h, 'GET', history, cookie)).json<LedgerView>());
  const mine = await view(guest);
  assert.deepEqual(mine.entries.map(({ kind, chips, amountMinor, actorId }) => [kind, chips, amountMinor, actorId]), [
    ['rebuy', 1000, 2000, '1001'], ['cash-out', 1000, 2300, '1001'], ['buy-in', 1000, 2000, '1001'],
  ]);
  assert.deepEqual(mine.totals, [{ userId: '1002', name: 'Player 2', currency: 'USD', inMinor: 4000, outMinor: 2300, netMinor: -1700 }]);
  assert.equal((await view(host)).totals.length, 2);
  assert.equal((await request(h, 'GET', history, outsider)).statusCode, 404);
  assert.equal((await request(h, 'GET', history)).statusCode, 401);
  // Cursors must be positive safe integers; anything else is refused.
  for (const query of ['?before=0', '?before=-3', '?before=1.5', '?before=x', '?beforeHand=0', '?beforeHand=-3', '?beforeHand=x']) {
    const bad = await request(h, 'GET', history + query, guest);
    assert.equal(bad.statusCode, 400, query);
    assert.equal(bad.json().code, 'bad-cursor', query);
  }
  assert.equal((await request(h, 'GET', history + `?before=${mine.entries[0].id}`, guest)).json<LedgerView>().entries.length, 2);
  assert.equal((await request(h, 'GET', history + `?beforeHand=1`, guest)).json<LedgerView>().hands.length, 0);
  const attempts = h.db.prepare('SELECT command_id AS id, reused FROM command_retries ORDER BY id, rowid').all();
  assert.deepEqual(attempts.map(({ id, reused }) => [id, reused]).filter(([id]) => !String(id).startsWith('admit-')), [
    ['cashout-guest-1', 0], ['old-quote', 1], ['old-quote', 0],
  ]);
  assert.equal(code(run('1001', 'cashout-guest-2', { ...payout, amountMinor: 0 })), 'ok');
  assert.equal(code(run('1002', 'leave-guest-1', { type: 'leave' })), 'ok');
  assert.equal((await request(h, 'GET', path, guest)).statusCode, 404);
  assert.equal((await view(guest)).entries.length, 4, 'leaving preserves access to your ledger');
  assert.equal(code(run('1001', 'cashout-host-1', { ...payout, userId: '1001', amountMinor: 0 })), 'ok');
  assert.equal(code(run('1001', 'close-settled', { type: 'close' })), 'ok');
  assert.equal((await view(guest)).closed, true);
  assert.equal((await request(h, 'GET', '/api/history', guest)).json().tables[0].id, tableId);
});

test('only the host can post; invites and aggregates come from committed rows, and bot failures do not stop play', async (t) => {
  const h = await harness({ env: { FLUXER_CHANNEL_ID: CHANNEL_ID } });
  t.after(() => h.close());
  const [host, guest] = await Promise.all(['1001', '1002'].map((id) => signIn(h, id)));
  const { tableId, invite } = (await request(h, 'POST', '/api/tables', host)).json();
  const path = `/api/tables/${tableId}`;
  await admitGuest(h, tableId, '1002', guest, invite, { chips: terms.startingChips, amountMinor: terms.buyInMinor, currency: terms.currency });
  const route = `${path}/notifications`;
  // Direct messages carry entry notices; this test is about what reaches the community channel.
  const posts = () => h.fake.messages.filter((entry) => entry.channelId === CHANNEL_ID);
  const posting = { type: 'invite', id: 'post-invite-1', token: invite };
  assert.equal((await request(h, 'POST', route, guest, posting)).statusCode, 403);
  // Malformed bodies are refused before anything is committed.
  for (const body of [{ type: 'invite', id: 'post-bad-shape' }, { type: 'invite', id: 'post-bad-shape', token: invite, extra: 1 },
    { type: 'settlement' }, { type: 'settlement', id: 'short' }, { type: 'invite', id: 'post-bad-shape', token: 'short' }]) {
    const rejected = await request(h, 'POST', route, host, body);
    assert.equal(rejected.statusCode, 400, JSON.stringify(body));
    assert.equal(rejected.json().code, 'bad-notification', JSON.stringify(body));
  }
  assert.equal(posts().length, 0);
  h.fake.onPost = (message) => {
    using observer = new DatabaseSync(h.dbPath, { readOnly: true });
    const saved = observer.prepare('SELECT kind, status, invite_hash FROM notifications WHERE id = ?').get(message.nonce);
    assert.equal(saved?.status, 'pending', 'separate connection sees the committed dispatch row before send');
    if (saved?.kind === 'invite') assert.notEqual(saved.invite_hash, invite);
  };
  const inviteResult = await request(h, 'POST', route, host, posting);
  assert.equal(inviteResult.json().status, 'sent', 'an onPost failure surfaces as a failed request');
  assert.deepEqual((await request(h, 'POST', route, host, posting)).json(), inviteResult.json());
  assert.equal((await request(h, 'POST', route, host, { type: 'settlement', id: posting.id })).json().code, 'command-id-reused');
  assert.equal(posts().length, 1);
  assert.match(posts()[0].content, new RegExp(`/join/${tableId}#${invite}$`));
  await request(h, 'POST', `${path}/invite`, host);
  assert.equal((await request(h, 'POST', route, host, { ...posting, id: 'stale-invite' })).json().code, 'invite-invalid');
  assert.equal(code(h.play.command('1001', tableId, 'settings-1', { type: 'settings', settings: terms })), 'ok');
  assert.equal(code(h.play.command('1001', tableId, 'fund-1001', { ...buy, userId: '1001' })), 'ok');
  // The guest's stack came from the approval; only the host still needs funding here.
  h.fake.failNext = 1;
  const summary = { type: 'settlement', id: 'post-summary-1' };
  assert.equal((await request(h, 'POST', route, host, summary)).json().status, 'unconfirmed');
  assert.equal((await request(h, 'POST', route, host, summary)).json().status, 'unconfirmed');
  assert.equal(posts().length, 1);
  assert.equal(code(h.play.command('1001', tableId, 'start-test-1', { type: 'start', dealer: 1 })), 'ok');
  const hand = h.play.view(tableId, '1001', new Set()).hand!;
  assert.equal(code(h.play.command('1001', tableId, 'fold-test-1', { type: 'act', action: 'fold', handId: hand.id, turn: hand.turn })), 'ok');
  const history = (await request(h, 'GET', `/api/history/${tableId}`, guest)).json<LedgerView>();
  assert.equal(history.hands[0].id, hand.id);
  assert.deepEqual(history.hands[0].shown, [], 'a hand without showdown exposes no hole cards in history');
  h.fake.channelGuildId = '999';
  assert.equal((await request(h, 'POST', route, host, { ...summary, id: 'wrong-guild' })).json().status, 'unconfirmed');
  assert.equal(posts().length, 1);
  h.fake.channelGuildId = '100';
  assert.equal((await request(h, 'POST', route, host, { ...summary, id: 'post-summary-2' })).json().status, 'sent');
  assert.equal(posts().length, 2);
  h.fake.onPost = () => {};
  const content = posts()[1].content;
  assert.match(content, /USD minor units\): in 4000, out 0, net -4000/);
  assert.doesNotMatch(content, /Player [12]|#|\b[2-9TJQKA][cdhs]\b/);
  // Suppresses mentions and embeds so a crafted summary or invite cannot ping the channel.
  for (const message of posts()) {
    assert.deepEqual(message.allowedMentions, { parse: [] });
    assert.equal(message.flags, 4);
    assert.equal(message.channelId, CHANNEL_ID);
  }
  assert.ifError(h.fake.postError);
});

test('corrections keep original receipts, repair unused chips, and never rewrite played stacks', async (t) => {
  let h = await harness({ env: { FLUXER_CHANNEL_ID: CHANNEL_ID } });
  t.after(() => h.close());
  const [host, guest, other] = await Promise.all(['1001', '1002', '1003'].map((id) => signIn(h, id)));
  const { tableId, invite } = (await request(h, 'POST', '/api/tables', host)).json();
  const path = `/api/tables/${tableId}`;
  const historyPath = `/api/history/${tableId}`;
  for (const [i, cookie] of [guest, other].entries()) {
    await admitGuest(h, tableId, i === 0 ? '1002' : '1003', cookie, invite,
      { chips: terms.startingChips, amountMinor: terms.buyInMinor, currency: terms.currency });
  }
  const run = (id: string, command: unknown, actor = '1001') => h.play.command(actor, tableId, id, command);
  const history = async (cookie = host) => (await request(h, 'GET', historyPath, cookie)).json<LedgerView>();
  const view = () => h.play.view(tableId, '1001', new Set());
  const correct = (entryId: number, chips: number, amountMinor: number, reason: string): Command =>
    ({ type: 'correct-ledger', entryId, chips, amountMinor, reason });

  assert.equal(code(run('fund-host', { ...buy, userId: '1001' })), 'ok');
  assert.equal(code(run('fund-guest', { ...buy, chips: 1200 })), 'has-chips');
  assert.equal(code(run('fund-wrong-seat', { ...buy, userId: '1003' })), 'has-chips');
  const original = (await history(guest)).entries[0];
  const wrong = (await history(other)).entries[0];
  assert.equal((await history()).entries.find((entry) => entry.id === original.id)?.chipCorrectionAvailable, true);
  const fix = correct(original.id, 800, 1500, 'Amount and count transposed');
  assert.equal(code(run('guest-correction', fix, '1002')), 'host-only');
  const ack = run('host-correction-1', fix);
  assert.equal(code(ack), 'ok');
  assert.equal(code(run('stale-correction-1', fix)), 'stale-correction');
  assert.equal(code(run('void-wrong-seat', correct(wrong.id, 0, 0, 'Wrong player selected'))), 'ok');
  assert.deepEqual(view().seats.slice(0, 3).map((seat) => seat?.stack), [1000, 800, 0]);
  const guestRows = (await history(guest)).entries;
  assert.equal(guestRows.length, 2, 'a guest sees only their original and revised receipt');
  assert.deepEqual(guestRows[0].correction, { entryId: original.id, reason: 'Amount and count transposed', voided: false });
  assert.deepEqual(guestRows.map((entry) => [entry.amountMinor, entry.chips, entry.superseded]), [[1500, 800, false], [2000, 1000, true]]);
  assert.equal((await history()).entries.find((entry) => entry.id === guestRows[0].id)?.chipCorrectionAvailable, true);
  const voided = (await history(other)).entries[0];
  assert.deepEqual(voided.correction, { entryId: wrong.id, reason: 'Wrong player selected', voided: true });
  assert.equal(voided.chips, 0);
  assert.equal((await history(guest)).totals[0].inMinor, 1500);

  const notifications = `${path}/notifications`;
  const post = (id: string) => request(h, 'POST', notifications, host, { id, type: 'settlement' });
  assert.equal(code(run('start-private-hand', { type: 'start', dealer: 1 })), 'ok');
  assert.equal(code(run('in-hand-correction', correct(guestRows[0].id, 800, 1600, 'Receipt typo'))), 'hand-in-progress');
  assert.equal(code(run('stop-private-hand', { type: 'stop' })), 'ok');
  const hand = view().hand!;
  assert.equal(code(run('fold-private-hand', { type: 'act', action: 'fold', handId: hand.id, turn: hand.turn })), 'ok');
  assert.equal(code(run('played-typo', correct(guestRows[0].id, 1100, 1500, 'Cannot reissue played chips'))), 'stale-correction');
  assert.equal((await history()).entries.find((entry) => entry.id === guestRows[0].id)?.chipCorrectionAvailable, false);
  const guestStack = view().seats[1]!.stack;
  assert.equal(code(run('settle-guest', { ...payout, chips: guestStack })), 'ok');
  assert.equal(code(run('depart-guest', { type: 'leave' }, '1002')), 'ok');
  const checkingChannel = Promise.withResolvers<void>();
  const releaseChannel = Promise.withResolvers<void>();
  h.fake.onChannelCheck = async () => {
    checkingChannel.resolve();
    await releaseChannel.promise;
  };
  const firstPost = post('first-corrected-summary').then((reply) => reply.json());
  try {
    await Promise.race([checkingChannel.promise, firstPost.then(() => { throw new Error('Post did not wait for the channel lookup'); })]);
    assert.equal(code(run('fix-departed-receipt', correct(guestRows[0].id, 800, 1600, 'Receipt typo'))), 'ok');
  } finally {
    h.fake.onChannelCheck = null;
    releaseChannel.resolve();
  }
  assert.equal((await firstPost).status, 'sent');
  assert.match(h.fake.messages.at(-1)!.content, /in 3500, out 2300, net -1200/, 'an in-flight post uses its original ledger cutoff');
  assert.equal((await history(guest)).totals[0].inMinor, 1600);
  assert.equal((await post('next-corrected-summary')).json().status, 'sent');
  assert.match(h.fake.messages.at(-1)!.content, /in 3600, out 2300, net -1300/);

  h = await h.restart();
  assert.deepEqual(run('host-correction-1', fix), ack);
  assert.equal((await history(guest)).entries.length, 4, 'a retried revision must not add a second correction');
  assert.equal((await history(guest)).totals[0].netMinor, 700);
  assert.equal((await history()).hands.length, 1);
});
