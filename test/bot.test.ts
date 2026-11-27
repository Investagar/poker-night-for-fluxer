import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNEL_ID, GUILD_ID } from './fake-fluxer.ts';
import { harness, ORIGIN, request, signIn } from './helpers.ts';
import type { LedgerView } from '../server/protocol.ts';

const settings = { FLUXER_BOT_COMMANDS: 'true', FLUXER_CHANNEL_ID: CHANNEL_ID };

function message(id: number, user: string, content: string, channel = CHANNEL_ID) {
  return { id: String(id), guild_id: GUILD_ID, channel_id: channel, content, type: 0, author: { id: user } };
}

test('!pokernight creates one owned room and sends management and invite links only by DM', async (t) => {
  let h = await harness({ env: settings });
  t.after(() => h.close());
  const create = message(40001, '1001', '!pokernight', '301');
  for (const ignored of [
    { ...create, guild_id: '999' }, { ...create, guild_id: undefined }, { ...create, webhook_id: '600' },
    { ...create, author: { id: '1001', bot: true } }, { ...create, content: '!pokernight unexpected' },
    message(40002, '2002', '!pokernight'),
  ]) await h.bot.receive(ignored);
  assert.equal(h.fake.messages.length, 0);

  await h.bot.receive(create);
  const dm = h.fake.directMessages.get('1001');
  assert.ok(dm);
  assert.deepEqual(h.fake.messages.map((m) => m.channelId), [dm]);
  const text = h.fake.messages[0].content;
  const links = /\/tables\/([\w-]{22})\/manage\n[^\n]+\/join\/([\w-]{22})#([\w-]{43})$/.exec(text);
  assert.ok(links);
  const [, tableId, joinedTable, token] = links;
  assert.equal(tableId, joinedTable);
  assert.ok(text.includes(`${ORIGIN}/tables/${tableId}/manage`));
  const [host, guest] = await Promise.all(['1001', '1002'].map((id) => signIn(h, id)));
  const path = `/api/tables/${tableId}`;
  assert.equal((await request(h, 'GET', path, host)).json().hostId, '1001');
  assert.equal((await request(h, 'GET', path, guest)).statusCode, 404, 'the management link is not a seat credential');
  const requested = (await request(h, 'POST', `${path}/join`, guest, { token })).json();
  assert.equal(requested.status, 'waiting', 'redeeming the link only files a request');
  assert.equal((await request(h, 'GET', path, guest)).statusCode, 404, 'a request is not a seat');
  const approved = h.play.command('1001', tableId, 'approve-guest-1', {
    type: 'buyin', userId: '1002', amountMinor: 0, currency: 'USD', chips: 1000, requestId: requested.requestId,
  });
  assert.ok(approved.ok, approved.ok ? '' : `${approved.code}: ${approved.error}`);
  assert.equal((await request(h, 'GET', path, guest)).json().seats[1].userId, '1002');
  // The Table master is told a request arrived; the link is never posted where anyone else can read it.
  await h.bot.settled();
  const notice = h.fake.messages.filter((entry) => entry.channelId === dm && entry.content.includes('waiting to enter'));
  assert.equal(notice.length, 1);
  assert.match(notice[0].content, new RegExp(`/tables/${tableId}/manage`));
  assert.equal(h.fake.messages.filter((entry) => entry.channelId !== dm).length, 0);

  // Only the room DM carries the invite; the entry notice names the table but never a join link.
  const roomDms = () => h.fake.messages.filter((entry) => /\/join\/[\w-]{22}#[\w-]{43}/.test(entry.content)).length;
  h = await h.restart();
  await h.bot.receive(create);
  assert.equal(roomDms(), 1, 'Gateway replay after restart does not DM a second room');
  assert.equal(h.fake.messages.filter((entry) => entry.channelId === '301').length, 0, 'no link or invite is posted in the community channel');
  assert.deepEqual((await request(h, 'GET', '/api/tables', host)).json().tables.map((table: { id: string }) => table.id), [tableId]);

  h.fake.blockedDirectMessages.add('1002');
  await h.bot.receive(message(40003, '1002', '!pokernight', '301'));
  const refusal = h.fake.messages.filter((entry) => entry.channelId === '301');
  assert.equal(refusal.length, 1);
  assert.doesNotMatch(refusal[0].content, /\/join\/|\/manage|https?:/);
  assert.equal((await request(h, 'GET', '/api/tables', guest)).json().tables.length, 1, 'refused DMs do not create an extra room');
});

test('!pokerleaderboard ranks corrected cash totals only for consenting players in the private channel', async (t) => {
  const h = await harness({ env: settings });
  t.after(() => h.close());
  const [host, guest, other] = await Promise.all(['1001', '1002', '1003'].map((id) => signIn(h, id)));
  const { tableId, invite } = (await request(h, 'POST', '/api/tables', host)).json();
  for (const userId of ['1001', '1002', '1003']) {
    const cookie = userId === '1001' ? host : userId === '1002' ? guest : other;
    const entered = (await request(h, 'POST', `/api/tables/${tableId}/join`, cookie, { token: invite })).json();
    assert.ok(h.play.command('1001', tableId, `fund-${userId}`, {
      type: 'buyin', userId, amountMinor: 2000, currency: 'USD', chips: 1000,
      ...(entered.status === 'seated' ? {} : { requestId: entered.requestId }),
    }).ok);
    const amountMinor = userId === '1001' ? 1600 : userId === '1002' ? 2400 : 4000;
    assert.ok(h.play.command('1001', tableId, `cashout-${userId}`, { type: 'cashout', userId, amountMinor, currency: 'USD', chips: 1000 }).ok);
  }
  const journal = (await request(h, 'GET', `/api/history/${tableId}`, guest)).json<LedgerView>();
  const entryId = journal.entries.find((entry) => entry.kind === 'buy-in')!.id;
  assert.ok(h.play.command('1001', tableId, 'correct-guest-buyin', {
    type: 'correct-ledger', entryId, amountMinor: 1700, chips: 1000, reason: 'Amount typed wrong',
  }).ok);

  await h.bot.receive(message(40101, '1001', '!pokerleaderboard opt-in'));
  await h.bot.receive(message(40102, '1002', '!pokerleaderboard opt-in'));
  await h.bot.receive(message(40103, '1001', '!pokerleaderboard', '301'));
  const posted = () => h.fake.messages.filter((entry) => entry.channelId === CHANNEL_ID);
  assert.equal(posted().length, 2, 'a different channel must never receive a ranking');
  assert.equal(h.fake.messages.filter((entry) => entry.channelId === '301').length, 0);
  await h.bot.receive(message(40104, '1001', '!pokerleaderboard'));
  const ranking = posted().at(-1)!;
  assert.equal(ranking.channelId, CHANNEL_ID);
  assert.match(ranking.content, /USD/);
  assert.match(ranking.content, /Player 2[^\n]*1[,.]?700[^\n]*2[,.]?400[^\n]*700/);
  assert.match(ranking.content, /Player 1[^\n]*2[,.]?000[^\n]*1[,.]?600[^\n]*-400/);
  assert.ok(ranking.content.indexOf('Player 2') < ranking.content.indexOf('Player 1'));
  assert.doesNotMatch(ranking.content, /Player 3|Amount typed wrong/);
  for (let n = 0; n < 4; n += 1) await h.bot.receive(message(40102, '1002', '!pokerleaderboard opt-in'));
  // The guest has spent their reply budget, but withdrawal must still take effect.
  await h.bot.receive(message(40105, '1002', '!pokerleaderboard opt-out'));
  await h.bot.receive(message(40102, '1002', '!pokerleaderboard opt-in')); // Replay older than the opt-out.
  await h.bot.receive(message(40106, '1001', '!pokerleaderboard'));
  assert.doesNotMatch(posted().at(-1)!.content, /Player [23]/);
});
