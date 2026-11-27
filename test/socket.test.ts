import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { connect, admitGuest, harness, type Harness, listen, ORIGIN, request, signIn, upgradeStatus } from './helpers.ts';

let h: Harness;
let port: number;
let host: string;
let guest: string;
let tableId: string;
let invite: string;

before(async () => {
  h = await harness();
  port = await listen(h);
  host = await signIn(h, '1001');
  guest = await signIn(h, '1002');
  ({ tableId, invite } = (await request(h, 'POST', '/api/tables', host)).json());
});
after(() => h.close());

test('the handshake requires the page origin, a session, a seat, and membership', async () => {
  assert.equal(await upgradeStatus(port, tableId, { origin: 'https://evil.example', cookie: host }), 403);
  assert.equal(await upgradeStatus(port, tableId, { cookie: host }), 403);
  assert.equal(await upgradeStatus(port, tableId, { origin: ORIGIN }), 401);
  assert.equal(await upgradeStatus(port, tableId, { origin: ORIGIN, cookie: 'pokerbot-local=forged' }), 401);
  assert.equal(await upgradeStatus(port, tableId, { origin: ORIGIN, cookie: guest }), 404, 'not yet seated');
  assert.equal(await upgradeStatus(port, 'x'.repeat(22), { origin: ORIGIN, cookie: host }), 404);
  assert.equal(await upgradeStatus(port, tableId, { origin: ORIGIN, cookie: host }), 101);
});

test('seat changes reach connected players without reloading; disconnects keep seats', async () => {
  const hostSocket = await connect(port, tableId, { origin: ORIGIN, cookie: host });
  const first = await hostSocket.next((m) => m.type === 'snapshot');
  assert.equal(first.seats[0].connected, true);
  assert.equal(first.seats[1], null);

  await admitGuest(h, tableId, '1002', guest, invite);
  const joined = await hostSocket.next((m) => m.type === 'snapshot' && m.seats[1] !== null);
  assert.ok(joined.version > first.version);
  assert.equal(joined.seats[1].userId, '1002');
  assert.equal(joined.seats[1].connected, false);

  const guestSocket = await connect(port, tableId, { origin: ORIGIN, cookie: guest });
  assert.equal((await hostSocket.next((m) => m.type === 'snapshot' && m.seats[1]?.connected)).seats[1].name, 'Player 2');
  guestSocket.ws.close();
  const dropped = await hostSocket.next((m) => m.type === 'snapshot' && m.seats[1] && !m.seats[1].connected);
  assert.equal(dropped.seats[1].userId, '1002');

  const back = await connect(port, tableId, { origin: ORIGIN, cookie: guest });
  const restored = await back.next((m) => m.type === 'snapshot');
  assert.equal(restored.seats[1].userId, '1002');
  assert.equal(restored.seats[1].connected, true);
  for (const message of [...hostSocket.messages, ...back.messages]) assert.ok(!JSON.stringify(message).includes(invite));
  hostSocket.ws.close();
  back.ws.close();
});

test('unknown messages are rejected and oversized messages close the socket', async () => {
  const socket = await connect(port, tableId, { origin: ORIGIN, cookie: host });
  await socket.next((m) => m.type === 'snapshot');
  socket.ws.send(JSON.stringify({ type: 'nonsense' }));
  assert.equal((await socket.next((m) => m.type === 'error')).code, 'unknown-message');
  socket.ws.send('x'.repeat(5000));
  assert.equal((await socket.closed).code, 1009);
});

test('logout closes that session’s sockets', async () => {
  const cookie = await signIn(h, '1001');
  const socket = await connect(port, tableId, { origin: ORIGIN, cookie });
  await socket.next((m) => m.type === 'snapshot');
  await request(h, 'POST', '/auth/logout', cookie);
  assert.equal((await socket.closed).code, 4001);
  assert.equal(await upgradeStatus(port, tableId, { origin: ORIGIN, cookie }), 401);
});

test('a confirmed non-member is refused and loses open sockets, but keeps the seat', async () => {
  const cookie = await signIn(h, '1002');
  const socket = await connect(port, tableId, { origin: ORIGIN, cookie });
  await socket.next((m) => m.type === 'snapshot');
  h.fake.users.get('1002')!.member = false;
  h.clock.now += 31_000;
  try {
    assert.equal(await upgradeStatus(port, tableId, { origin: ORIGIN, cookie }), 403);
    assert.equal((await socket.closed).code, 4003);
    assert.equal(await upgradeStatus(port, tableId, { origin: ORIGIN, cookie }), 401);
    assert.equal(h.tables.seatOf(tableId, '1002'), 2);
  } finally {
    h.fake.users.get('1002')!.member = true;
  }
});

test('a Fluxer outage does not lock seated players out of their table', async () => {
  const cookie = await signIn(h, '1001');
  h.clock.now += 31_000;
  h.fake.outage = true;
  try {
    assert.equal(await upgradeStatus(port, tableId, { origin: ORIGIN, cookie }), 101);
  } finally {
    h.fake.outage = false;
  }
});
