import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Card, parseCard } from '../server/game/cards.ts';
import {
  act, type Action, buyIn, changeSettings, comeBack, dealHand, DEFAULT_SETTINGS, layerPots, NEW_GAME, options, pause,
  resume, RuleError, type Settings, startGame, stopGame, type TableState, timeout,
} from '../server/game/engine.ts';
import { shuffledDeck } from '../server/game/shuffle.ts';

let now = 1_000_000;
const ctx = (deck?: Card[]) => ({ now, deck: () => (deck ? [...deck] : shuffledDeck()) });

/** Seats 1..n with the given stacks; 0 leaves a seat taken but without chips. */
function table(stacks: Record<number, number>, settings: Partial<Settings> = {}): TableState {
  return {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    seats: Object.entries(stacks).map(([seat, stack]) => ({ seat: Number(seat), userId: `u${seat}`, stack, away: false, missed: 0 })),
    game: structuredClone(NEW_GAME),
  };
}

/** A deck dealing the given hole cards (by seat) and board, in dealing order from left of the button. */
function deck(state: TableState, dealer: number, holes: Record<number, string>, board = ''): Card[] {
  const seats = state.seats.filter((s) => s.stack > 0 && !s.away).map((s) => s.seat).sort((a, b) => a - b);
  const start = seats.findIndex((s) => s > dealer);
  const order = start < 0 ? seats : [...seats.slice(start), ...seats.slice(0, start)];
  const used = new Set<Card>();
  const take = (name: string) => {
    const card = parseCard(name);
    used.add(card);
    return card;
  };
  const cards = order.map((seat) => holes[seat].split(' ').map(take));
  const boardCards = board ? board.split(' ').map(take) : [];
  const spare = Array.from({ length: 52 }, (_, i) => i).filter((c) => !used.has(c));
  const result = [...cards.map((h) => h[0]), ...cards.map((h) => h[1])];
  const [f1, f2, f3, t, r] = boardCards;
  if (boardCards.length === 5) result.push(spare.pop()!, f1, f2, f3, spare.pop()!, t, spare.pop()!, r);
  return [...result, ...spare];
}

const stacks = (state: TableState) => Object.fromEntries(state.seats.map((s) => [s.seat, s.stack]));
const total = (state: TableState) => state.seats.reduce((sum, s) => sum + s.stack, 0)
  + (state.game.hand?.players.reduce((sum, p) => sum + p.total, 0) ?? 0);

function play(state: TableState, seat: number, action: Action, amount?: number) {
  const hand = state.game.hand!;
  act(state, seat, hand.id, hand.turn, action, amount, ctx());
}

test('heads-up: the button posts the small blind, acts first before the flop and last after it', () => {
  const state = table({ 1: 1000, 2: 1000 });
  startGame(state, 1, ctx());
  const hand = state.game.hand!;
  assert.equal(hand.dealer, 1);
  assert.equal(hand.smallBlind, 1);
  assert.equal(hand.bigBlind, 2);
  assert.deepEqual(stacks(state), { 1: 995, 2: 990 });
  assert.equal(hand.toAct, 1);
  assert.deepEqual(options(state, 1), { fold: true, check: false, call: 5, raise: { kind: 'raise', min: 20, max: 1000 } });
  play(state, 1, 'call');
  assert.equal(hand.toAct, 2, 'big blind keeps the option');
  assert.equal(options(state, 2)!.check, true);
  play(state, 2, 'check');
  assert.equal(hand.street, 'flop');
  assert.equal(hand.toAct, 2, 'non-button acts first after the flop');
});

test('three-handed positions, rotation, and the host choosing the button', () => {
  const state = table({ 1: 1000, 3: 1000, 7: 1000 });
  startGame(state, 3, ctx());
  let hand = state.game.hand!;
  assert.deepEqual([hand.dealer, hand.smallBlind, hand.bigBlind, hand.toAct], [3, 7, 1, 3]);
  play(state, 3, 'fold');
  play(state, 7, 'fold');
  assert.equal(state.game.hand, null);
  assert.equal(state.game.nextHandAt, now + 5000);
  dealHand(state, ctx());
  hand = state.game.hand!;
  assert.deepEqual([hand.dealer, hand.smallBlind, hand.bigBlind], [7, 1, 3], 'button moves one eligible seat clockwise');
});

test('the button and blinds skip seats without chips and away players', () => {
  const state = table({ 1: 1000, 2: 0, 3: 1000, 4: 1000 });
  state.seats.find((s) => s.seat === 4)!.away = true;
  startGame(state, 1, ctx());
  const hand = state.game.hand!;
  assert.deepEqual(hand.players.map((p) => p.seat), [3, 1]);
  assert.deepEqual([hand.dealer, hand.smallBlind, hand.bigBlind], [1, 1, 3]);
  assert.throws(() => startGame(table({ 1: 1000, 2: 0 }), 1, ctx()), /At least two/);
  assert.throws(() => startGame(table({ 1: 1000, 2: 0, 3: 50 }), 2, ctx()), /dealer/);
});

test('bets and raises are validated against minimums, maximums, and the betting state', () => {
  const state = table({ 1: 1000, 2: 1000, 3: 1000 });
  startGame(state, 1, ctx());
  const err = (fn: () => void, code: string) => assert.throws(fn, (e: RuleError) => e.code === code);
  err(() => play(state, 1, 'raise', 15), 'bad-amount');
  err(() => play(state, 1, 'bet', 40), 'illegal-action');
  err(() => play(state, 1, 'check'), 'illegal-action');
  err(() => play(state, 1, 'raise', 1001), 'bad-amount');
  err(() => play(state, 1, 'raise', 20.5), 'bad-amount');
  play(state, 1, 'raise', 30);
  assert.equal(options(state, 2)!.raise!.min, 50, 'a re-raise must add at least the last raise (20)');
  play(state, 2, 'call');
  play(state, 3, 'call');
  assert.equal(state.game.hand!.street, 'flop');
  err(() => play(state, 2, 'bet', 9), 'bad-amount');
  play(state, 2, 'check');
  play(state, 3, 'bet', 10);
});

test('a short all-in raise does not reopen betting for players who already acted', () => {
  const state = table({ 1: 1000, 2: 1000, 3: 160 });
  startGame(state, 1, ctx());
  play(state, 1, 'call');
  play(state, 2, 'call');
  play(state, 3, 'check');
  const hand = state.game.hand!;
  assert.equal(hand.street, 'flop');
  play(state, 2, 'bet', 100);
  play(state, 3, 'allin');
  assert.equal(hand.currentBet, 150);
  assert.equal(options(state, 1)!.raise!.min, 250, 'a player yet to act may still raise a full increment');
  play(state, 1, 'call');
  const facing = options(state, 2)!;
  assert.equal(facing.call, 50);
  assert.equal(facing.raise, null, 'the original bettor may only call or fold');
  assert.throws(() => play(state, 2, 'raise', 300), /not allowed/);
  play(state, 2, 'call');
  assert.equal(hand.street, 'turn');
});

test('short all-ins that add up to a full raise do reopen betting', () => {
  const state = table({ 1: 2000, 2: 2000, 3: 170, 4: 240 });
  startGame(state, 1, ctx());
  for (const seat of [4, 1, 2]) play(state, seat, 'call');
  play(state, 3, 'check');
  play(state, 2, 'bet', 100);
  play(state, 3, 'allin');
  play(state, 4, 'allin');
  assert.deepEqual([state.game.hand!.currentBet, state.game.hand!.minRaise], [230, 100], 'neither all-in (+60, +70) is a full raise');
  play(state, 1, 'call');
  assert.ok(options(state, 2)!.raise, 'together they raised seat 2 by 130, at least one full raise');
});

test('a short big blind: others still owe the full blind; heads-up the small blind need not call more', () => {
  const three = table({ 1: 1000, 2: 1000, 3: 4 });
  startGame(three, 1, ctx());
  assert.equal(three.game.hand!.players.find((p) => p.seat === 3)!.allIn, true);
  assert.equal(options(three, 1)!.call, 10);
  const two = table({ 1: 1000, 2: 4 }, { smallBlind: 5, bigBlind: 10 });
  startGame(two, 1, ctx(deck(two, 1, { 1: 'As Ad', 2: 'Kc Kd' }, '2c 7d 9h Js 3s')));
  assert.equal(two.game.hand, null, 'nobody can act, so the board runs out');
  assert.deepEqual(stacks(two), { 1: 1004, 2: 0 }, 'the extra small-blind chip comes back uncalled');
  assert.equal(two.game.last!.showdown, true);
});

test('unequal all-ins build side pots; each layer goes to its best eligible hand', () => {
  const state = table({ 1: 100, 2: 300, 3: 500 });
  startGame(state, 1, ctx(deck(state, 1, { 1: 'As Ad', 2: 'Ks Kd', 3: 'Qs Qd' }, '2c 7d 9h Jc 3h')));
  play(state, 1, 'allin');
  play(state, 2, 'allin');
  play(state, 3, 'call');
  const last = state.game.last!;
  assert.deepEqual(last.pots.map((p) => [p.amount, p.eligible, p.winners]), [
    [300, [1, 2, 3], [{ seat: 1, amount: 300 }]],
    [400, [2, 3], [{ seat: 2, amount: 400 }]],
  ]);
  assert.deepEqual(stacks(state), { 1: 300, 2: 400, 3: 200 });
  assert.deepEqual(last.net.map((n) => n.amount).reduce((a, b) => a + b), 0);
  assert.deepEqual(last.shown.map((s) => [s.seat, s.label]), [[2, 'Pair of Kings'], [3, 'Pair of Queens'], [1, 'Pair of Aces']]);
});

test('folded chips stay in the pot; odd chips go first to winners left of the button', () => {
  const state = table({ 1: 1000, 2: 1000, 3: 1000 });
  // Board plays for both remaining players: a royal flush on board.
  startGame(state, 1, ctx(deck(state, 1, { 1: '2c 3d', 2: '4c 5d', 3: '6c 7d' }, 'As Ks Qs Js Ts')));
  play(state, 1, 'call');
  play(state, 2, 'fold');
  play(state, 3, 'check');
  for (const street of ['flop', 'turn', 'river']) {
    assert.equal(state.game.hand!.street, street);
    play(state, 3, 'check');
    play(state, 1, 'check');
  }
  const pot = state.game.last!.pots[0];
  assert.equal(pot.amount, 25);
  assert.deepEqual(pot.winners, [{ seat: 3, amount: 13 }, { seat: 1, amount: 12 }]);
  assert.deepEqual(stacks(state), { 1: 1002, 2: 995, 3: 1003 });
});

test('layerPots merges equal layers and keeps folded contributions', () => {
  assert.deepEqual(layerPots([
    { seat: 1, total: 50, folded: true },
    { seat: 2, total: 100, folded: false },
    { seat: 3, total: 100, folded: false },
    { seat: 4, total: 30, folded: false },
  ]), [{ amount: 120, eligible: [2, 3, 4] }, { amount: 160, eligible: [2, 3] }]);
});

test('uncalled bets return to the bettor when everyone folds', () => {
  const state = table({ 1: 1000, 2: 1000, 3: 1000 });
  startGame(state, 1, ctx());
  play(state, 1, 'raise', 300);
  play(state, 2, 'fold');
  play(state, 3, 'fold');
  assert.deepEqual(stacks(state), { 1: 1015, 2: 995, 3: 990 });
  assert.equal(state.game.last!.showdown, false);
  assert.deepEqual(state.game.last!.shown, [], 'no cards are revealed without a showdown');
});

test('timeouts check when legal, otherwise fold; two misses mark a player away until they return', () => {
  const state = table({ 1: 1000, 2: 1000, 3: 1000 }, { turnSeconds: 30 });
  startGame(state, 1, ctx());
  let hand = state.game.hand!;
  assert.equal(hand.deadline, now + 30_000);
  assert.equal(timeout(state, hand.id, hand.turn, ctx()), false, 'not before the deadline');
  now += 30_000;
  assert.equal(timeout(state, hand.id, hand.turn, ctx()), true);
  assert.equal(hand.players.find((p) => p.seat === 1)!.folded, true, 'facing the blind: fold');
  play(state, 2, 'call');
  now += 30_000;
  timeout(state, hand.id, hand.turn, ctx());
  assert.equal(hand.street, 'flop', 'big blind with nothing to call: check');
  assert.equal(state.seats.find((s) => s.seat === 3)!.missed, 1);
  play(state, 2, 'check');
  now += 30_000;
  timeout(state, hand.id, hand.turn, ctx());
  assert.equal(state.seats.find((s) => s.seat === 3)!.away, true);
  // Away players act instantly for the rest of the hand.
  play(state, 2, 'bet', 50);
  assert.equal(state.game.hand, null);
  dealHand(state, ctx());
  hand = state.game.hand!;
  assert.deepEqual(hand.players.map((p) => p.seat).sort(), [1, 2], 'away players are not dealt in');
  comeBack(state, 3, ctx());
  assert.equal(state.seats.find((s) => s.seat === 3)!.away, false);
});

test('stale, out-of-turn, and paused actions are rejected; pause freezes the clock until resumed', () => {
  const state = table({ 1: 1000, 2: 1000 });
  startGame(state, 1, ctx());
  const hand = state.game.hand!;
  const turn = hand.turn;
  assert.throws(() => act(state, 2, hand.id, turn, 'call', undefined, ctx()), (e: RuleError) => e.code === 'not-your-turn');
  play(state, 1, 'call');
  assert.throws(() => act(state, 2, hand.id, turn, 'check', undefined, ctx()), (e: RuleError) => e.code === 'stale');
  assert.throws(() => act(state, 2, hand.id + 1, hand.turn, 'check', undefined, ctx()), (e: RuleError) => e.code === 'stale');
  assert.equal(pause(state), true);
  assert.equal(hand.deadline, null);
  assert.throws(() => play(state, 2, 'check'), (e: RuleError) => e.code === 'paused');
  now += 3_600_000;
  assert.equal(timeout(state, hand.id, hand.turn, ctx()), false, 'downtime is never a missed turn');
  resume(state, ctx());
  assert.equal(hand.deadline, now + 30_000);
  play(state, 2, 'check');
  assert.equal(hand.street, 'flop');
});

test('settings change only between hands; rebuys need an empty stack and no live hand', () => {
  const state = table({ 1: 1000, 2: 0, 3: 1000 });
  assert.throws(() => changeSettings(state, { ...DEFAULT_SETTINGS, bigBlind: 2, smallBlind: 5 }), /big blind/);
  assert.throws(() => changeSettings(state, { ...DEFAULT_SETTINGS, turnSeconds: 5 }), /turnSeconds/);
  changeSettings(state, { ...DEFAULT_SETTINGS, smallBlind: 10, bigBlind: 20, startingChips: 2000 });
  startGame(state, 1, ctx());
  assert.throws(() => changeSettings(state, DEFAULT_SETTINGS), /between hands/);
  assert.throws(() => buyIn(state, 2, ctx()), /current hand/, 'even a seat waiting for the next hand must wait');
  assert.throws(() => buyIn(state, 1, ctx()), /in-hand|current hand/);
  stopGame(state);
  play(state, state.game.hand!.toAct!, 'fold');
  assert.equal(buyIn(state, 2, ctx()), 2000);
  assert.equal(state.game.nextHandAt, null, 'a stopped table finishes the hand and deals no more');
});

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('6,000 random hands with rebuys conserve chips, never stall, and only accept legal actions', () => {
  const random = mulberry32(42);
  const int = (n: number) => Math.floor(random() * n);
  let hands = 0;
  let sidePots = 0;
  for (let round = 0; round < 60; round += 1) {
    const seats = 2 + int(9);
    const state = table(Object.fromEntries(Array.from({ length: seats }, (_, i) => [i + 1, 1 + int(3000)])), { smallBlind: 5, bigBlind: 10 });
    let chips = total(state);
    const dealCtx = { now, deck: () => shuffledDeck(int) };
    startGame(state, state.seats[int(seats)].seat, dealCtx);
    for (let handNo = 0; handNo < 100; handNo += 1) {
      // A deal can end at once when the blinds put everyone all-in.
      if (!state.game.hand && state.game.nextHandAt !== null) dealHand(state, dealCtx);
      for (let step = 0; state.game.hand; step += 1) {
        assert.ok(step < 500, 'hand stalled');
        const hand = state.game.hand;
        const seat = hand.toAct!;
        const legal = options(state, seat)!;
        assert.ok(legal, 'someone must be to act');
        const choice = int(10);
        if (choice < 3 && legal.raise) {
          const { min, max, kind } = legal.raise;
          play(state, seat, int(4) === 0 ? 'allin' : kind, min + int(max - min + 1));
        } else if (choice < 4 && legal.call > 0) {
          play(state, seat, 'fold');
        } else if (choice < 5) {
          timeout(state, hand.id, hand.turn, { now: hand.deadline!, deck: dealCtx.deck });
        } else {
          play(state, seat, legal.check ? 'check' : 'call');
        }
        assert.equal(total(state), chips, 'chips are conserved mid-hand');
        assert.ok(state.seats.every((s) => s.stack >= 0));
      }
      const last = state.game.last!;
      hands += 1;
      if (last.pots.length > 1) sidePots += 1;
      assert.equal(last.net.reduce((sum, n) => sum + n.amount, 0), 0);
      assert.equal(last.pots.reduce((sum, p) => sum + p.amount, 0), last.pots.reduce((sum, p) => sum + p.winners.reduce((a, w) => a + w.amount, 0), 0));
      for (const s of state.seats) {
        if (s.away) comeBack(state, s.seat, dealCtx);
        if (s.stack === 0) chips += buyIn(state, s.seat, dealCtx);
      }
    }
    assert.equal(total(state), chips);
  }
  assert.equal(hands, 6000);
  assert.ok(sidePots > 500, `only ${sidePots} side pots exercised`);
});
