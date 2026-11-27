import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { type Card, parseCard } from '../server/game/cards.ts';
import { HAND_GAP_MS } from '../server/game/engine.ts';
import { shuffledDeck } from '../server/game/shuffle.ts';
import { type Ack, type Command, PROTOCOL_VERSION, type Snapshot } from '../server/protocol.ts';
import { type Client, connect, AdmitError, admitGuest, harness, type Harness, listen, ORIGIN, request, signIn } from './helpers.ts';

let h: Harness;
let nextDeck: Card[] | null = null;
afterEach(async () => {
  nextDeck = null;
  await h?.close();
});

/** A deck dealing `holes` (by seat, two cards each) in dealing order `order`, then burns and the board. */
function stackedDeck(order: number[], holes: Record<number, string>, board: string): Card[] {
  const cards = (names: string) => names.split(' ').map(parseCard);
  const dealt = order.map((seat) => cards(holes[seat]));
  const top = [...dealt.map((pair) => pair[0]), ...dealt.map((pair) => pair[1])];
  const [f1, f2, f3, turn, river] = cards(board);
  const used = new Set([...top, f1, f2, f3, turn, river]);
  const spare = Array.from({ length: 52 }, (_, i) => i).filter((c) => !used.has(c));
  return [...top, spare.pop()!, f1, f2, f3, spare.pop()!, turn, spare.pop()!, river, ...spare];
}

interface Table {
  tableId: string;
  invite: string;
  cookies: string[];
  users: string[];
}

/** Host 1001 plus guests, seated 1..n; the host funds themselves, guests are approved with their stack. */
async function setup(players: number): Promise<Table> {
  h = await harness({ deck: () => (nextDeck ? [...nextDeck] : shuffledDeck()) });
  const users = Array.from({ length: players }, (_, i) => String(1001 + i));
  const cookies = await Promise.all(users.map((id) => signIn(h, id)));
  const { tableId, invite } = (await request(h, 'POST', '/api/tables', cookies[0])).json();
  const hostFund: Command = { type: 'buyin', userId: users[0], amountMinor: 0, currency: 'USD', chips: 1000 };
  const ack = h.play.command(users[0], tableId, `fund-${(ids += 1)}`, hostFund);
  ok(ack);
  for (const [i, cookie] of cookies.slice(1).entries()) {
    await admitGuest(h, tableId, users[i + 1], cookie, invite);
  }
  return { tableId, invite, cookies, users };
}

let ids = 0;
function run(t: Table, player: number, command: Command | Record<string, unknown>, id = `command-${(ids += 1)}`): Ack {
  return h.play.command(t.users[player], t.tableId, id, command);
}

function ok(ack: Ack): void {
  assert.ok(ack.ok, ack.ok ? '' : `${ack.code}: ${ack.error}`);
}

const buyIn = (userId: string, chips = 1000, amountMinor = 0, currency = 'USD'): Command =>
  ({ type: 'buyin', userId, amountMinor, currency, chips });

function view(t: Table, player = 0): Snapshot {
  return h.play.view(t.tableId, t.users[player], new Set());
}

/** The seated player (index) whose turn it is acts, targeting the current hand and turn. */
function actNow(t: Table, action: string, amount?: number): Ack {
  const hand = view(t).hand!;
  const player = t.users.findIndex((_, i) => view(t, i).you.seat === hand.toAct);
  return run(t, player, { type: 'act', handId: hand.id, turn: hand.turn, action, ...(amount === undefined ? {} : { amount }) });
}

async function startThree(dealer = 1): Promise<Table> {
  const t = await setup(3);
  ok(run(t, 0, { type: 'start', dealer }));
  return t;
}

const CARD = /^[2-9TJQKA][cdhs]$/;
function cardsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === 'string' && CARD.test(value)) found.add(value);
  else if (Array.isArray(value)) for (const item of value) cardsIn(item, found);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) cardsIn(item, found);
  return found;
}

test('a full hand over sockets: each player sees only their own cards until showdown, folded cards never', async () => {
  const t = await setup(3);
  const port = await listen(h);
  const sockets: Client[] = [];
  for (const cookie of t.cookies) sockets.push(await connect(port, t.tableId, { origin: ORIGIN, cookie }));
  let seq = 0;
  const send = async (player: number, command: Command): Promise<Ack> => {
    seq += 1;
    const id = `socket-${seq}-abcdef`;
    sockets[player].ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'command', id, command }));
    const ack = await sockets[player].next((m) => m.type === 'ack' && m.id === id);
    return ack as Ack;
  };
  // Broadcasts precede the sender's ack, so its snapshot may already be in the received history.
  const snapshot = (socket: Client, predicate: NonNullable<Parameters<Client['next']>[0]>) =>
    socket.messages.find(predicate) ?? socket.next(predicate);
  const sendTurn = async (action: 'fold' | 'check' | 'call') => {
    const hand = view(t).hand!;
    ok(await send(hand.toAct! - 1, { type: 'act', handId: hand.id, turn: hand.turn, action }));
  };

  // Dealer 1: seat 2 posts the small blind, seat 3 the big blind, seat 1 acts first. All stacks are already
  // issued by setup; the guest's buy-in attempt is refused as host-only.
  nextDeck = stackedDeck([2, 3, 1], { 1: '7h 2c', 2: 'As Ad', 3: 'Kc Kd' }, '2s 5h 9c Jd 3s');
  const deniedBuyIn = await send(1, buyIn(t.users[1]));
  assert.equal(deniedBuyIn.ok ? 'ok' : deniedBuyIn.code, 'host-only');
  const guestStart = await send(1, { type: 'start', dealer: 1 });
  assert.equal(guestStart.ok ? '' : guestStart.code, 'host-only');
  ok(await send(0, { type: 'start', dealer: 1 }));

  const dealt = await snapshot(sockets[0], (m) => m.type === 'snapshot' && m.hand?.id === 1);
  assert.deepEqual(dealt.you.cards, ['7h', '2c']);
  assert.deepEqual(dealt.you.options, { fold: true, check: false, call: 10, raise: { kind: 'raise', min: 20, max: 1000 } });
  assert.deepEqual([dealt.hand.dealer, dealt.hand.smallBlind, dealt.hand.bigBlind, dealt.hand.pot], [1, 2, 3, 15]);
  assert.equal((await sockets[1].next((m) => m.type === 'snapshot' && m.hand?.id === 1)).you.options, null);

  await sendTurn('fold');
  await sendTurn('call');
  await sendTurn('check');
  for (let street = 0; street < 3; street += 1) {
    await sendTurn('check');
    await sendTurn('check');
  }
  const results = await Promise.all(sockets.map((s) => snapshot(s, (m) => m.type === 'snapshot' && m.last?.id === 1)));
  for (const result of results) {
    assert.equal(result.hand, null);
    assert.deepEqual(result.last.board, ['2s', '5h', '9c', 'Jd', '3s']);
    assert.deepEqual(result.last.shown.map((s: { seat: number }) => s.seat), [2, 3], 'only live hands are shown');
    assert.deepEqual(result.last.pots, [{ amount: 20, eligible: [2, 3], winners: [{ seat: 2, amount: 20 }] }]);
    assert.deepEqual(result.seats.slice(0, 3).map((s: { stack: number }) => s.stack), [1000, 1010, 990]);
  }

  const holes: Record<number, string[]> = { 1: ['7h', '2c'], 2: ['As', 'Ad'], 3: ['Kc', 'Kd'] };
  const board = ['2s', '5h', '9c', 'Jd', '3s'];
  for (const [index, socket] of sockets.entries()) {
    const seat = index + 1;
    const showdownAt = socket.messages.findIndex((m) => m.type === 'snapshot' && m.last?.id === 1);
    const before = cardsIn(socket.messages.slice(0, showdownAt));
    const allowedBefore = new Set([...holes[seat], ...board]);
    for (const card of before) assert.ok(allowedBefore.has(card), `seat ${seat} saw ${card} before showdown`);
    const after = cardsIn(socket.messages);
    const allowed = new Set([...allowedBefore, ...holes[2], ...holes[3]]);
    for (const card of after) assert.ok(allowed.has(card), `seat ${seat} saw ${card}`);
    if (seat !== 1) for (const card of holes[1]) assert.ok(!after.has(card), `folded cards reached seat ${seat}`);
  }
  for (const socket of sockets) socket.ws.close();
});

test('command shapes are checked at the boundary', async () => {
  const t = await setup(2);
  const port = await listen(h);
  const socket = await connect(port, t.tableId, { origin: ORIGIN, cookie: t.cookies[0] });
  await socket.next((m) => m.type === 'snapshot');
  socket.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'command', id: 'short', command: { type: 'buyin' } }));
  assert.equal((await socket.next((m) => m.type === 'error')).code, 'bad-command');
  socket.ws.send(JSON.stringify({ v: 3, type: 'command', id: 'old-client-1', command: { type: 'buyin', amountMinor: 0, chips: 1000, currency: 'USD' } }));
  assert.equal((await socket.next((m) => m.type === 'error')).code, 'protocol-version');
  for (const [command, code] of [
    [{ type: 'teleport' }, 'unknown-command'],
    [{ type: 'act', handId: 1, turn: 0, action: 'shove' }, 'bad-command'],
    [{ type: 'act', handId: 1, turn: 0, action: 'raise', amount: 1.5 }, 'bad-command'],
    [{ type: 'buyin', amountMinor: 0, chips: 1000, currency: 'USD' }, 'bad-command'],
    [{ type: 'buyin', userId: '1002', amountMinor: 2000, chips: 1000, currency: 'usd' }, 'bad-command'],
    [{ type: 'buyin', userId: '1002', amountMinor: 2000.5, chips: 1000, currency: 'USD' }, 'bad-command'],
    [{ type: 'buyin', userId: '1002', amountMinor: 2000, chips: 1000.5, currency: 'USD' }, 'bad-command'],
    [{ type: 'correct-ledger', entryId: 1, amountMinor: 0, chips: 0, reason: '  ' }, 'bad-command'],
    [{ type: 'cashout', userId: '1002' }, 'bad-command'],
    [{ type: 'cashout', userId: '1002', amountMinor: 2000, chips: 1000.5, currency: 'USD' }, 'bad-command'],
    [{ type: 'cashout', userId: '', amountMinor: 2000, chips: 1000, currency: 'USD' }, 'bad-command'],
    [{ type: 'cashout', userId: 'no', amountMinor: 2000, chips: 1000, currency: 'USD' }, 'bad-command'],
    [{ type: 'settings', settings: { smallBlind: 10, bigBlind: 5, turnSeconds: 30, startingChips: 1000, buyInMinor: 0, currency: 'USD' } }, 'bad-settings'],
    [{ type: 'settings', settings: { smallBlind: 5, bigBlind: 10, turnSeconds: 30, startingChips: 1000, buyInMinor: 2000, currency: 'usd' } }, 'bad-settings'],
    [{ type: 'start', dealer: '1' }, 'bad-command'],
  ] as const) {
    const ack = run(t, 0, command);
    assert.equal(ack.ok ? 'ok' : ack.code, code, JSON.stringify(command));
  }
  socket.ws.close();
});

test('host-only commands, settings between hands, and the buy-in rules', async () => {
  h = await harness({ deck: () => (nextDeck ? [...nextDeck] : shuffledDeck()) });
  const hostCookie = await signIn(h, '1001');
  const guestCookie = await signIn(h, '1002');
  const { tableId, invite } = (await request(h, 'POST', '/api/tables', hostCookie)).json();
  const t: Table = { tableId, invite, cookies: [hostCookie, guestCookie], users: ['1001', '1002'] };
  // The request queues while the table is still USD; the settings then change the table to EUR, so the approval
  // is retried with the new currency below.
  const requestEntry = request(h, 'POST', `/api/tables/${tableId}/join`, guestCookie, { token: invite });
  const settings = {
    smallBlind: 25, bigBlind: 50, turnSeconds: 20, startingChips: 5000, buyInMinor: 1050, currency: 'EUR',
    denominations: { white: 1, red: 3, blue: 4, green: 20, black: 80 },
  };
  await requestEntry;
  ok(run(t, 0, { type: 'settings', settings }));
  assert.deepEqual(view(t, 1).settings, settings);
  for (const denominations of [{ ...settings.denominations, white: 2 }, { ...settings.denominations, red: 4 }]) {
    const invalid = run(t, 0, { type: 'settings', settings: { ...settings, denominations } });
    assert.equal(invalid.ok ? 'ok' : invalid.code, 'bad-settings');
  }
  const early = run(t, 0, { type: 'start', dealer: 1 });
  assert.equal(early.ok ? '' : early.code, 'not-enough-players');
  ok(run(t, 0, buyIn(t.users[0], 5000, 1050, 'EUR')));
  // Approve with the new EUR terms: the queued request plus the master's buyin seat and fund the guest at once.
  const pending = h.db.prepare('SELECT id FROM table_entry_requests WHERE table_id = ? AND user_id = ? AND declined = 0')
    .get(tableId, '1002') as { id: number } | undefined;
  const approval = { ...buyIn(t.users[1], 5000, 1050, 'EUR'), requestId: pending!.id };
  ok(run(t, 0, approval));
  assert.equal(view(t, 1).seats[1]!.stack, 5000);
  for (const command of [{ type: 'settings', settings }, { type: 'start', dealer: 1 }, { type: 'stop' }, { type: 'resume' }, { type: 'close' }]) {
    const ack = run(t, 1, command);
    assert.equal(ack.ok ? 'ok' : ack.code, 'host-only');
  }
  const twice = run(t, 0, buyIn(t.users[0], 5000, 1050, 'EUR'));
  assert.equal(twice.ok ? '' : twice.code, 'has-chips');
  const rebuyWhileFunded = run(t, 0, buyIn(t.users[1], 4500, 2200, 'EUR'));
  assert.equal(rebuyWhileFunded.ok ? '' : rebuyWhileFunded.code, 'has-chips');
  // Bust the guest and reissue at 4500 so the stack is odd, then revalue a color: the stack must not change.
  ok(run(t, 0, { type: 'cashout', userId: t.users[1], amountMinor: 2200, currency: 'EUR', chips: 5000 }));
  const staleApproval = run(t, 0, approval);
  assert.equal(staleApproval.ok ? 'ok' : staleApproval.code, 'stale-buyin', 'a spent request must not fund an empty seat');
  ok(run(t, 0, buyIn(t.users[1], 4500, 2200, 'EUR')));
  assert.equal(view(t, 1).seats[1]!.stack, 4500);
  ok(run(t, 0, { type: 'settings', settings: { ...settings, denominations: { ...settings.denominations, black: 95 } } }));
  assert.equal(view(t, 1).settings.denominations?.black, 95);
  assert.equal(view(t, 1).seats[1]!.stack, 4500, 'changing denominations does not revalue an issued stack');
  const badDealer = run(t, 0, { type: 'start', dealer: 7 });
  assert.equal(badDealer.ok ? '' : badDealer.code, 'bad-dealer');
  ok(run(t, 0, { type: 'start', dealer: 2 }));
  const during = run(t, 0, { type: 'settings', settings });
  assert.equal(during.ok ? '' : during.code, 'hand-in-progress');
  const hand = view(t).hand!;
  assert.deepEqual([hand.dealer, hand.smallBlind, hand.bigBlind, hand.toAct], [2, 2, 1, 2], 'heads-up: the dealer posts the small blind and acts first');
});

test('a late entrant waits for a full dealer rotation; a seated player keeps their seat', async () => {
  const t = await startThree();
  const cookie = await signIn(h, '1004');
  const url = `/api/tables/${t.tableId}/join`;
  // A hand is live: the request queues, but the approval is refused until the table comes around.
  const requested = (await request(h, 'POST', url, cookie, { token: t.invite })).json();
  assert.equal(requested.status, 'waiting');
  assert.equal((await request(h, 'GET', `/api/tables/${t.tableId}`, cookie)).statusCode, 404, 'a request is not a seat');
  const during = await admitGuest(h, t.tableId, '1004', cookie, t.invite).then(
    () => 'ok', (error: unknown) => (error instanceof AdmitError ? error.code : 'unknown'));
  assert.equal(during, 'hand-in-progress', 'issuance and seating wait for the hand to finish');
  // A seated player redeeming the same invite is never re-seated.
  assert.equal(await admitGuest(h, t.tableId, t.users[1], t.cookies[1], t.invite), 2);

  // Finish the live hand; the table keeps dealing, so the button can move around to the guests.
  while (view(t).hand) ok(actNow(t, 'fold'));
  // The hand is over, but players still owe the newcomer their button, so the entry stays blocked.
  assert.equal(await admitGuest(h, t.tableId, '1004', cookie, t.invite).then(
    () => 'ok', (error: unknown) => (error instanceof AdmitError ? error.code : 'unknown')), 'orbit-pending');
  // Deal the rest of the orbit: the gate opens once every asked-time seat has been the dealer.
  for (let guard = 0; guard < 8 && h.tables.entryRequests(t.tableId)[0]?.remaining !== 0; guard += 1) {
    h.clock.now += HAND_GAP_MS;
    h.play.wake(t.tableId);
    while (view(t).hand) ok(actNow(t, 'fold'));
  }
  assert.deepEqual(h.tables.entryRequests(t.tableId).map((row) => row.remaining), [0]);
  assert.equal(await admitGuest(h, t.tableId, '1004', cookie, t.invite), 4);
});

test('an away player still owes a dealer turn until they leave the table', async () => {
  const t = await startThree(3);
  const missTurn = () => {
    const hand = view(t).hand!;
    assert.equal(hand.toAct, 3);
    h.clock.now = hand.deadline!;
    h.play.wake(t.tableId);
  };
  const finishHand = () => {
    while (view(t).hand) ok(actNow(t, 'fold'));
  };
  const nextHand = () => {
    h.clock.now += HAND_GAP_MS;
    h.play.wake(t.tableId);
    assert.ok(view(t).hand);
  };

  missTurn();
  finishHand();
  nextHand();
  ok(actNow(t, 'call'));
  ok(actNow(t, 'raise', 20));
  missTurn();
  finishHand();
  const away = view(t).seats[2]!;
  assert.equal(away.away, true);

  const cookie = await signIn(h, '1004');
  const url = `/api/tables/${t.tableId}`;
  const status = async () => (await request(h, 'GET', `${url}/entry-request`, cookie)).json<{ remaining: number }>();
  const pending = (await request(h, 'POST', `${url}/join`, cookie, { token: t.invite })).json();
  assert.equal(pending.remaining, 3);
  for (const dealer of [2, 1]) {
    nextHand();
    assert.equal(view(t).hand!.dealer, dealer);
    finishHand();
  }
  assert.equal((await status()).remaining, 1, 'skipping an away seat does not complete that part of the rotation');
  ok(run(t, 0, { type: 'cashout', userId: away.userId, chips: away.stack, currency: 'USD', amountMinor: 0 }));
  ok(run(t, 2, { type: 'leave' }));
  assert.equal((await status()).remaining, 0, 'a departing player no longer holds up approval');
  assert.equal(await admitGuest(h, t.tableId, '1004', cookie, t.invite), 3);
});

test('a retried command applies once, also after a restart; reusing its ID for another payload is refused', async () => {
  const t = await startThree();
  const hand = view(t).hand!;
  const command = { type: 'act', handId: hand.id, turn: hand.turn, action: 'call' };
  const first = run(t, 0, command, 'retry-me-1');
  ok(first);
  const version = view(t).version;
  assert.deepEqual(run(t, 0, command, 'retry-me-1'), first);
  assert.equal(view(t).version, version, 'the retry changed nothing');
  const reused = run(t, 0, { ...command, action: 'fold' }, 'retry-me-1');
  assert.equal(reused.ok ? '' : reused.code, 'command-id-reused');
  const other = run(t, 1, command, 'retry-me-1');
  assert.equal(other.ok ? '' : other.code, 'stale', 'IDs are scoped per player');

  h = await h.restart();
  assert.deepEqual(run(t, 0, command, 'retry-me-1'), first);
  assert.deepEqual(run(t, 1, command, 'retry-me-1'), other, 'a recorded failure is returned again, never re-applied');
});

test('a stale action never applies to a later turn', async () => {
  const t = await startThree();
  const hand = view(t).hand!;
  ok(actNow(t, 'call'));
  const stale = run(t, 0, { type: 'act', handId: hand.id, turn: hand.turn, action: 'fold' });
  assert.equal(stale.ok ? '' : stale.code, 'stale');
  const wrongHand = run(t, 1, { type: 'act', handId: hand.id + 1, turn: view(t).hand!.turn, action: 'call' });
  assert.equal(wrongHand.ok ? '' : wrongHand.code, 'stale');
  const notYours = run(t, 0, { type: 'act', handId: hand.id, turn: view(t).hand!.turn, action: 'call' });
  assert.equal(notYours.ok ? '' : notYours.code, 'not-your-turn');
});

test('the server clock owns deadlines: a missed turn checks or folds, two make the player away', async () => {
  const t = await startThree();
  const hand = view(t).hand!;
  assert.equal(hand.deadline, h.clock.now + 30_000);
  h.play.wake(t.tableId);
  assert.equal(view(t).hand!.turn, hand.turn, 'nothing happens before the deadline');
  h.clock.now += 30_000;
  const late = actNow(t, 'call');
  assert.equal(late.ok ? 'ok' : late.code, 'stale', 'an action at the deadline loses even before the timer fires');
  h.play.wake(t.tableId);
  const after = view(t);
  assert.equal(after.seats[0]!.hand!.folded, true, 'facing the big blind, a timeout folds');
  assert.equal(after.hand!.toAct, 2);
  ok(actNow(t, 'call'));
  h.clock.now += 30_000;
  h.play.wake(t.tableId);
  const checked = view(t);
  assert.equal(checked.hand!.street, 'flop', 'with nothing to call, a timeout checks');

  for (let i = 0; i < 2; i += 1) {
    h.clock.now += 30_000;
    h.play.wake(t.tableId);
  }
  const flop = view(t);
  assert.equal(flop.hand!.street, 'turn');
  assert.deepEqual(flop.seats.slice(0, 3).map((s) => s!.away), [false, false, true], 'two misses in a row make seat 3 away; acting resets seat 2');
  h.clock.now += 30_000;
  h.play.wake(t.tableId);
  const finished = view(t);
  assert.equal(finished.hand, null, 'both live players are away, so the river also checks through immediately');
  assert.equal(finished.last?.board.length, 5);
  assert.equal(finished.seats[1]!.away, true);
  ok(run(t, 2, { type: 'back' }));
  assert.equal(view(t).seats[2]!.away, false);
});

test('a server restart pauses the interrupted hand until the host resumes; downtime is not a timeout', async () => {
  const t = await startThree();
  ok(actNow(t, 'call'));
  const before = view(t);
  h.clock.now += 10 * 60_000;
  h = await h.restart();
  const paused = view(t);
  assert.equal(paused.game.paused, true);
  assert.equal(paused.hand!.deadline, null);
  assert.equal(paused.hand!.turn, before.hand!.turn);
  assert.deepEqual(paused.seats.map((s) => s?.stack), before.seats.map((s) => s?.stack));
  assert.equal(paused.you.options, null);
  h.play.wake(t.tableId);
  assert.equal(view(t).hand!.turn, before.hand!.turn, 'no timeout while paused');
  const blocked = actNow(t, 'call');
  assert.equal(blocked.ok ? '' : blocked.code, 'paused');
  const guest = run(t, 1, { type: 'resume' });
  assert.equal(guest.ok ? '' : guest.code, 'host-only');
  ok(run(t, 0, { type: 'resume' }));
  assert.equal(view(t).hand!.deadline, h.clock.now + 30_000);
  ok(actNow(t, 'call'));
});

test('hands repeat on the server clock and the button moves to the next eligible seat', async () => {
  const t = await startThree(1);
  ok(actNow(t, 'fold'));
  ok(actNow(t, 'fold'));
  const between = view(t);
  assert.equal(between.hand, null);
  assert.equal(between.game.nextHandAt, h.clock.now + HAND_GAP_MS);
  h.play.wake(t.tableId);
  assert.equal(view(t).hand, null, 'not before the gap');
  h.clock.now += HAND_GAP_MS;
  h.play.wake(t.tableId);
  assert.equal(view(t).hand!.id, 2);
  assert.equal(view(t).hand!.dealer, 2);

  ok(run(t, 0, { type: 'stop' }));
  while (view(t).hand) ok(actNow(t, 'fold'));
  assert.equal(view(t).game.nextHandAt, null, 'stopping lets the current hand finish, then waits');
  ok(run(t, 0, { type: 'start' }));
  assert.equal(view(t).hand!.dealer, 3);
});

test('busted players rebuy between hands; leaving needs an empty stack; the host closes between hands', async () => {
  h = await harness({ deck: () => (nextDeck ? [...nextDeck] : shuffledDeck()) });
  const hostCookie = await signIn(h, '1001');
  const guestCookie = await signIn(h, '1002');
  const { tableId, invite } = (await request(h, 'POST', '/api/tables', hostCookie)).json();
  const t: Table = { tableId, invite, cookies: [hostCookie, guestCookie], users: ['1001', '1002'] };
  ok(run(t, 0, { type: 'settings', settings: { smallBlind: 5, bigBlind: 10, turnSeconds: 30, startingChips: 100, buyInMinor: 500, currency: 'USD' } }));
  // The queued request is approved with the small 100-chip terms; the host funds themselves too.
  const requestEntry = request(h, 'POST', `/api/tables/${tableId}/join`, guestCookie, { token: invite });
  await requestEntry;
  const pending = h.db.prepare('SELECT id FROM table_entry_requests WHERE table_id = ? AND user_id = ? AND declined = 0')
    .get(tableId, '1002') as { id: number } | undefined;
  ok(run(t, 0, { type: 'buyin', userId: '1002', amountMinor: 500, currency: 'USD', chips: 100, requestId: pending!.id }));
  ok(run(t, 0, buyIn(t.users[0], 100, 500)));
  nextDeck = stackedDeck([2, 1], { 1: 'As Ad', 2: '7h 2c' }, 'Ks 9d 4c 3h 8s');
  ok(run(t, 0, { type: 'start', dealer: 1 }));
  ok(actNow(t, 'allin'));
  ok(actNow(t, 'call'));
  const done = view(t);
  assert.deepEqual([done.seats[0]!.stack, done.seats[1]!.stack], [200, 0]);
  assert.equal(done.game.nextHandAt, null, 'no next hand without two players with chips');
  const guestId = t.users[1];
  const leaveRich = run(t, 0, { type: 'leave' });
  assert.equal(leaveRich.ok ? '' : leaveRich.code, 'host-stays');
  ok(run(t, 0, buyIn(guestId, 100, 500)));
  assert.equal(view(t).game.nextHandAt, h.clock.now + HAND_GAP_MS, 'a rebuy schedules the next hand');
  ok(run(t, 0, { type: 'stop' }));

  // Real cash-outs: each remaining stack leaves the game as an external settlement.
  ok(run(t, 0, { type: 'cashout', userId: guestId, amountMinor: view(t).seats[1]!.stack * 5, currency: 'USD', chips: view(t).seats[1]!.stack }));
  assert.equal(view(t).seats[1]!.stack, 0, 'the cashed-out stack leaves the game');
  ok(run(t, 0, { type: 'cashout', userId: '1001', amountMinor: view(t).seats[0]!.stack * 5, currency: 'USD', chips: view(t).seats[0]!.stack }));
  assert.equal(view(t).seats[0]!.stack, 0, 'the host cashes out too');
  ok(run(t, 1, { type: 'leave' }));
  assert.equal(h.tables.seatOf(t.tableId, guestId), null);
  const gone = run(t, 0, buyIn(guestId, 100, 500));
  assert.equal(gone.ok ? '' : gone.code, 'stale-buyin');

  ok(run(t, 0, { type: 'close' }));
  assert.equal(view(t).closed, true);
  const afterClose = run(t, 0, buyIn(t.users[0], 100, 500));
  assert.equal(afterClose.ok ? '' : afterClose.code, 'table-closed');
  assert.equal((await request(h, 'GET', '/api/tables', t.cookies[0])).json().tables.length, 0);
});

test('leaving over the socket closes that player’s table sockets', async () => {
  const t = await setup(2);
  // The setup approval issued the guest a stack; leaving requires an empty one.
  ok(run(t, 0, { type: 'cashout', userId: t.users[1], amountMinor: 0, currency: 'USD', chips: 1000 }));
  const port = await listen(h);
  const socket = await connect(port, t.tableId, { origin: ORIGIN, cookie: t.cookies[1] });
  await socket.next((m) => m.type === 'snapshot');
  socket.ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'command', id: 'leave-now-1', command: { type: 'leave' } }));
  assert.equal((await socket.next((m) => m.type === 'ack')).ok, true);
  assert.equal((await socket.closed).code, 4004);
});
