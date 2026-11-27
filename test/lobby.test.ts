import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { scalar } from '../server/db.ts';
import { PROTOCOL_VERSION } from '../server/protocol.ts';
import { admitGuest, harness, type Harness, people, request, signIn } from './helpers.ts';

let h: Harness;
const cookies = new Map<string, string>();
before(async () => {
  h = await harness();
  for (const person of people) cookies.set(person.id, await signIn(h, person.id));
});
after(() => h.close());

const as = (id: string) => cookies.get(id)!;

async function create(host: string) {
  const response = await request(h, 'POST', '/api/tables', as(host));
  assert.equal(response.statusCode, 200, response.body);
  return response.json() as { tableId: string; invite: string };
}

const join = (id: string, tableId: string, token: string) => request(h, 'POST', `/api/tables/${tableId}/join`, as(id), { token });

test('the creator hosts and takes seat 1; snapshots never contain invite tokens', async () => {
  const { tableId, invite } = await create('1001');
  assert.match(tableId, /^[\w-]{22}$/);
  assert.match(invite, /^[\w-]{43}$/);
  const snapshot = await request(h, 'GET', `/api/tables/${tableId}`, as('1001'));
  const body = snapshot.json();
  assert.equal(body.v, PROTOCOL_VERSION);
  assert.equal(body.hostId, '1001');
  assert.equal(body.seats.length, 10);
  assert.deepEqual(body.seats[0], { seat: 1, userId: '1001', name: 'Player 1', avatar: null, connected: false, stack: 0, away: false, hand: null });
  assert.deepEqual(body.you, { seat: 1, cards: [], options: null, boughtIn: false });
  assert.ok(!snapshot.body.includes(invite));
  const stored = JSON.stringify(h.db.prepare('SELECT * FROM invites').all());
  assert.ok(!stored.includes(invite));
});

test('private tables are hidden from members without a seat', async () => {
  const { tableId } = await create('1002');
  assert.equal((await request(h, 'GET', `/api/tables/${tableId}`, as('1003'))).statusCode, 404);
  assert.equal((await request(h, 'GET', `/api/tables/${'x'.repeat(22)}`, as('1003'))).statusCode, 404);
  assert.equal((await request(h, 'GET', `/api/tables/${tableId}`)).statusCode, 401);
  assert.equal((await join('1003', tableId, 'A'.repeat(43))).statusCode, 403);
  assert.equal((await request(h, 'GET', `/api/tables/${tableId}`, as('1003'))).statusCode, 404);
});

test('an invite requests entry once; the master approval seats and funds the guest', async () => {
  const { tableId, invite } = await create('1003');
  const guest = as('1004');
  // The join alone must not seat anyone: the table stays hidden until the master approves.
  assert.equal((await request(h, 'GET', `/api/tables/${tableId}`, guest)).statusCode, 404);
  const first = await admitGuest(h, tableId, '1004', guest, invite);
  assert.equal(first, 2);
  const again = await Promise.all([admitGuest(h, tableId, '1004', guest, invite), admitGuest(h, tableId, '1004', guest, invite)]);
  assert.deepEqual(again, [2, 2]);
  assert.equal(scalar(h.db, 'SELECT count(*) FROM seats WHERE table_id = ?', tableId), 2);
  const list = await request(h, 'GET', '/api/tables', guest);
  assert.deepEqual(list.json().tables.find((t: { id: string }) => t.id === tableId), { id: tableId, hostName: 'Player 3', host: false, players: 2 });
});

test('only the host rotates the invite, and the old link stops admitting new players', async () => {
  const { tableId, invite } = await create('1005');
  await admitGuest(h, tableId, '1006', as('1006'), invite);
  assert.equal((await request(h, 'POST', `/api/tables/${tableId}/invite`, as('1006'))).statusCode, 403);
  assert.equal((await request(h, 'POST', `/api/tables/${tableId}/invite`, as('1007'))).statusCode, 404);
  const rotated = await request(h, 'POST', `/api/tables/${tableId}/invite`, as('1005'));
  const fresh = rotated.json().invite as string;
  assert.notEqual(fresh, invite);
  const stale = await join('1007', tableId, invite);
  assert.equal(stale.statusCode, 403);
  assert.equal(stale.json().code, 'invite-invalid');
  assert.equal((await admitGuest(h, tableId, '1006', as('1006'), invite)), 2, 'existing seats survive rotation');
  assert.equal(await admitGuest(h, tableId, '1007', as('1007'), fresh), 3);
});

test('ten seats are admitted and an eleventh member is rejected', async () => {
  const { tableId, invite } = await create('1008');
  const guests = people.filter((p) => p.id !== '1008').slice(0, 9);
  for (const [i, guest] of guests.entries()) assert.equal(await admitGuest(h, tableId, guest.id, as(guest.id), invite), i + 2);
  const eleventh = people.find((p) => p.id !== '1008' && !guests.includes(p))!;
  const full = await join(eleventh.id, tableId, invite);
  assert.equal(full.statusCode, 409);
  assert.equal(full.json().code, 'table-full');
});

test('concurrent joins for the last free seat cannot overfill', async () => {
  const { tableId, invite } = await create('1009');
  const guests = people.filter((p) => p.id !== '1009');
  for (const guest of guests.slice(0, 8)) await admitGuest(h, tableId, guest.id, as(guest.id), invite);
  const racers = guests.slice(8, 11);
  // Requests can queue; only nine approvals can fit before the table is full.
  const approvals = await Promise.all(racers.map(async (guest) => {
    try {
      return await admitGuest(h, tableId, guest.id, as(guest.id), invite);
    } catch (error) {
      return (error as { code?: string }).code ?? 'unknown';
    }
  }));
  const seated = approvals.filter((result) => typeof result === 'number').length;
  assert.equal(seated, 1, 'exactly one of the racers gets the last seat');
  assert.deepEqual(approvals.filter((result) => typeof result !== 'number').length, 2, 'the others are rejected');
  assert.equal(scalar(h.db, 'SELECT count(*) FROM seats WHERE table_id = ?', tableId), 10);
});

test('state-changing requests require the exact page origin', async () => {
  for (const origin of [undefined, 'https://evil.example', 'http://localhost:5174']) {
    const response = await h.app.inject({ method: 'POST', url: '/api/tables', headers: { cookie: as('1010'), ...(origin ? { origin } : {}) } });
    assert.equal(response.statusCode, 403, String(origin));
  }
});

test('open tables are capped per host', async () => {
  for (let i = 0; i < 3; i += 1) await create('1011');
  const capped = await request(h, 'POST', '/api/tables', as('1011'));
  assert.equal(capped.statusCode, 429);
  assert.equal(capped.json().code, 'too-many-tables');
});

test('mutations are rate limited per user', async () => {
  const { tableId } = await create('1012');
  let status = 200;
  for (let i = 0; i < 25 && status === 200; i += 1) status = (await request(h, 'POST', `/api/tables/${tableId}/invite`, as('1012'))).statusCode;
  assert.equal(status, 429);
});

test('membership is rechecked on create and join; an outage blocks new joins only', async () => {
  const { tableId, invite } = await create('1001');
  h.clock.now += 31_000;
  h.fake.outage = true;
  try {
    assert.equal((await request(h, 'POST', '/api/tables', as('1002'))).statusCode, 503);
    assert.equal((await join('1002', tableId, invite)).statusCode, 503);
    assert.equal((await request(h, 'GET', `/api/tables/${tableId}`, as('1001'))).statusCode, 200);
  } finally {
    h.fake.outage = false;
  }
  h.fake.users.get('1002')!.member = false;
  try {
    const rejected = await join('1002', tableId, invite);
    assert.equal(rejected.statusCode, 403);
    assert.equal(rejected.json().code, 'not-member');
  } finally {
    h.fake.users.get('1002')!.member = true;
  }
});

test('seats and sessions survive an app restart on the same database file', async () => {
  const restartable = await harness();
  try {
    const host = await signIn(restartable, '1001');
    const guest = await signIn(restartable, '1002');
    const { tableId, invite } = (await request(restartable, 'POST', '/api/tables', host)).json();
    await admitGuest(restartable, tableId, '1002', guest, invite);
    const restarted = await restartable.restart();
    try {
      const snapshot = await request(restarted, 'GET', `/api/tables/${tableId}`, guest);
      assert.equal(snapshot.statusCode, 200);
      assert.deepEqual(snapshot.json().seats.slice(0, 2).map((s: { userId: string }) => s.userId), ['1001', '1002']);
      assert.equal((await request(restarted, 'GET', '/api/session', host)).json().user.id, '1001');
      assert.equal(await admitGuest(restarted, tableId, '1002', guest, invite), 2);
    } finally {
      await restarted.close();
    }
  } catch (error) {
    await restartable.close().catch(() => {});
    throw error;
  }
});
