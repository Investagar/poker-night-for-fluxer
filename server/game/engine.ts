import { isRecord } from '../guards.ts';
import { type Action, CHIP_COLORS, type ChipDenominations, DEFAULT_CHIP_DENOMINATIONS, MAX_CHIPS, MAX_MINOR, type Options, type Settings, type Street } from '../protocol.ts';
import type { Card } from './cards.ts';
import { describe, evaluate } from './evaluate.ts';

// Re-exported so settlement code can import them alongside the engine's rules.
export { DEFAULT_CHIP_DENOMINATIONS, MAX_CHIPS };

export type { Action, Options, Settings, Street } from '../protocol.ts';

/**
 * Server-only No-Limit Hold'em rules. Every function mutates the TableState it is given (callers pass a copy) and
 * takes time and the deck explicitly, so outcomes are reproducible in tests.
 *
 * House rules, all enforced here:
 * - Positions: seats 1..10 clockwise. The host picks the first button from eligible seats; afterwards the button moves
 *   to the next eligible seat clockwise. Eligible = seated, chips > 0, not away. Heads-up, the button posts the small
 *   blind and acts first before the flop and last after it.
 * - Short blinds: a player who cannot cover a blind posts all remaining chips and is all-in. The amount to call is
 *   still the full big blind while anyone else can act.
 * - Bets and raises are "to" amounts (total street bet). Minimum opening bet is the big blind; a raise must add at
 *   least the last full bet or raise this street. An all-in for less is always allowed.
 * - Short all-in raises: an all-in that is less than a full raise does not reopen betting. A player who already acted
 *   may re-raise only if the total raised since their last action amounts to at least one full raise.
 * - Uncalled chips are returned at the end of each betting round. Side pots are layered by contribution; folded
 *   chips stay in the pot but folded players cannot win.
 * - Odd chips from a split go one at a time to the winners in seat order starting left of the button.
 * - Missed turns: at the deadline the server checks if that is legal, otherwise folds. Two missed turns in a row mark
 *   the player away: they act the same way instantly for the rest of the hand and are not dealt in until they return.
 *   There are no dead or missed-blind penalties.
 * - Showdown reveals every hand still live. Folded hands are never revealed.
 */

export const HAND_GAP_MS = 5000;
export const MIN_PLAYERS = 2;

export const DEFAULT_SETTINGS: Settings = { smallBlind: 5, bigBlind: 10, turnSeconds: 30, startingChips: 1000, buyInMinor: 0, currency: 'USD' };

export interface SeatState {
  seat: number;
  userId: string;
  stack: number;
  away: boolean;
  missed: number;
}

export interface HandPlayer {
  seat: number;
  userId: string;
  hole: Card[];
  /** Chips put in on the current street. */
  bet: number;
  /** Chips put in during the whole hand. */
  total: number;
  folded: boolean;
  allIn: boolean;
  /** The street's bet level when this player last acted; null when they have not acted since the last full raise. */
  acted: number | null;
}

export interface Hand {
  id: number;
  dealer: number;
  smallBlind: number;
  bigBlind: number;
  street: Street;
  board: Card[];
  deck: Card[];
  players: HandPlayer[];
  currentBet: number;
  minRaise: number;
  toAct: number | null;
  turn: number;
  deadline: number | null;
}

export interface PotResult {
  amount: number;
  eligible: number[];
  winners: { seat: number; amount: number }[];
}

export interface HandResult {
  id: number;
  endedAt: number;
  board: Card[];
  showdown: boolean;
  pots: PotResult[];
  shown: { seat: number; userId: string; cards: Card[]; label: string }[];
  /** Net chip change per seat for the hand. */
  net: { seat: number; userId: string; amount: number }[];
}

export interface Game {
  running: boolean;
  paused: boolean;
  /** Button of the current or most recent hand. */
  dealer: number | null;
  /** Host's choice of button for the next hand, overriding normal rotation. */
  nextDealer: number | null;
  handNo: number;
  nextHandAt: number | null;
  hand: Hand | null;
  last: HandResult | null;
}

export const NEW_GAME: Game = { running: false, paused: false, dealer: null, nextDealer: null, handNo: 0, nextHandAt: null, hand: null, last: null };

export interface TableState {
  settings: Settings;
  seats: SeatState[];
  game: Game;
}

export interface Context {
  now: number;
  deck: () => Card[];
}

export class RuleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const seatState = (state: TableState, seat: number): SeatState => state.seats.find((s) => s.seat === seat)!;
const canAct = (p: HandPlayer) => !p.folded && !p.allIn;

export function eligibleSeats(state: TableState): number[] {
  return state.seats.filter((s) => s.stack > 0 && !s.away).map((s) => s.seat).sort((a, b) => a - b);
}

/** `seats` rotated to start strictly after `after`, clockwise. */
function clockwise<T extends { seat: number }>(items: T[], after: number): T[] {
  const sorted = [...items].sort((a, b) => a.seat - b.seat);
  const index = sorted.findIndex((item) => item.seat > after);
  return index < 0 ? sorted : [...sorted.slice(index), ...sorted.slice(0, index)];
}

function toCall(hand: Hand, p: HandPlayer): number {
  const others = hand.players.filter((o) => o !== p && !o.folded);
  const target = others.some(canAct) ? hand.currentBet : Math.max(0, ...others.map((o) => o.bet));
  return Math.max(0, target - p.bet);
}

function needsAction(hand: Hand, p: HandPlayer): boolean {
  if (!canAct(p)) return false;
  if (toCall(hand, p) > 0) return true;
  return p.acted === null && hand.players.some((o) => o !== p && canAct(o));
}

function mayRaise(hand: Hand, p: HandPlayer, stack: number): boolean {
  return stack > toCall(hand, p)
    && hand.players.some((o) => o !== p && canAct(o))
    && (p.acted === null || hand.currentBet - p.acted >= hand.minRaise);
}

/** Legal actions for the player whose turn it is. */
export function options(state: TableState, seat: number): Options | null {
  const hand = state.game.hand;
  if (!hand || hand.toAct !== seat || state.game.paused) return null;
  const p = hand.players.find((x) => x.seat === seat)!;
  const stack = seatState(state, seat).stack;
  const call = Math.min(toCall(hand, p), stack);
  let raise: Options['raise'] = null;
  if (mayRaise(hand, p, stack)) {
    const max = p.bet + stack;
    const kind = hand.currentBet === 0 ? 'bet' : 'raise';
    const min = kind === 'bet' ? state.settings.bigBlind : hand.currentBet + hand.minRaise;
    raise = { kind, min: Math.min(min, max), max };
  }
  return { fold: true, check: call === 0, call, raise };
}

function put(state: TableState, p: HandPlayer, amount: number): void {
  const seat = seatState(state, p.seat);
  const chips = Math.min(amount, seat.stack);
  seat.stack -= chips;
  p.bet += chips;
  p.total += chips;
  if (seat.stack === 0) p.allIn = true;
}

/** Host starts (or restarts) dealing. The first start must name the button; later starts may override rotation. */
export function startGame(state: TableState, dealer: number | undefined, ctx: Context): void {
  const { game } = state;
  if (game.running) throw new RuleError('already-running', 'The game is already running.');
  const eligible = eligibleSeats(state);
  if (eligible.length < MIN_PLAYERS) throw new RuleError('not-enough-players', 'At least two seated players need chips to start.');
  if (dealer === undefined ? game.dealer === null : !eligible.includes(dealer)) {
    throw new RuleError('bad-dealer', 'Choose the dealer from seated players who have chips.');
  }
  if (dealer !== undefined) game.nextDealer = dealer;
  game.running = true;
  game.nextHandAt = null;
  if (!game.hand) dealHand(state, ctx);
}

export function validateSettings(value: unknown): Settings {
  const input = isRecord(value) ? value : {};
  const int = (key: keyof Settings, min: number, max: number): number => {
    const n = input[key];
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < min || n > max) {
      throw new RuleError('bad-settings', `${key} must be a whole number from ${min} to ${max}.`);
    }
    return n;
  };
  const settings: Settings = {
    smallBlind: int('smallBlind', 1, 1_000_000_000),
    bigBlind: int('bigBlind', 1, 1_000_000_000),
    turnSeconds: int('turnSeconds', 10, 300),
    startingChips: int('startingChips', 1, MAX_CHIPS),
    buyInMinor: int('buyInMinor', 0, MAX_MINOR),
    currency: typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency) ? input.currency : '',
  };
  if (!settings.currency) throw new RuleError('bad-settings', 'currency must be a three-letter ISO code.');
  if (settings.bigBlind < settings.smallBlind) throw new RuleError('bad-settings', 'The big blind must be at least the small blind.');
  if (settings.startingChips < settings.bigBlind) throw new RuleError('bad-settings', 'The starting stack must cover at least one big blind.');
  settings.denominations = normalizeDenominations(input.denominations ?? DEFAULT_CHIP_DENOMINATIONS);
  return settings;
}

/**
 * Denominations are the per-color chip-unit display values: positive, whole, pairwise distinct, and white is always
 * one unit. Legacy data omitting the field plays with the defaults.
 */
export function normalizeDenominations(value: unknown): ChipDenominations {
  const input = isRecord(value) ? value : {};
  const seen = new Set<number>();
  const out = {} as ChipDenominations;
  for (const color of CHIP_COLORS) {
    const raw = input[color] ?? DEFAULT_CHIP_DENOMINATIONS[color];
    if (color === 'white' && raw !== 1) throw new RuleError('bad-settings', 'The white chip is always one unit.');
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 1 || raw > MAX_CHIPS || seen.has(raw)) {
      throw new RuleError('bad-settings', `The ${color} chip value must be a unique whole number of chip units.`);
    }
    seen.add(raw);
    out[color] = raw;
  }
  return out;
}

export function changeSettings(state: TableState, value: unknown): void {
  if (state.game.hand) throw new RuleError('hand-in-progress', 'Settings can change only between hands.');
  state.settings = validateSettings(value);
}

/** Adds a starting stack for a seated player with no chips, between hands only. `amount` defaults to settings. */
export function buyIn(state: TableState, seat: number, ctx: Context, amount: number = state.settings.startingChips): number {
  const s = seatState(state, seat);
  if (state.game.hand) throw new RuleError('in-hand', 'You can buy in once the current hand ends.');
  if (s.stack > 0) throw new RuleError('has-chips', 'You can buy in again only when you have no chips.');
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > MAX_CHIPS) throw new RuleError('bad-chips', 'The issued stack must be a whole number of chip units.');
  s.stack = amount;
  maybeSchedule(state, ctx.now);
  return s.stack;
}

/** A player may give up their seat between hands once they hold no chips. */
export function leave(state: TableState, seat: number): void {
  const s = seatState(state, seat);
  if (state.game.hand) throw new RuleError('in-hand', 'You can leave once the current hand ends.');
  if (s.stack > 0) throw new RuleError('has-chips', 'Cash out your chips before leaving the table.');
  state.seats = state.seats.filter((x) => x !== s);
}

export function stopGame(state: TableState): void {
  state.game.running = false;
  state.game.nextHandAt = null;
}

/** Schedules the next deal when the table is running, idle, and has enough eligible players. */
export function maybeSchedule(state: TableState, now: number): void {
  const { game } = state;
  if (game.running && !game.hand && game.nextHandAt === null && eligibleSeats(state).length >= MIN_PLAYERS) {
    game.nextHandAt = now + HAND_GAP_MS;
  }
}

export function dealHand(state: TableState, ctx: Context): void {
  const { game, settings } = state;
  game.nextHandAt = null;
  if (game.hand) throw new RuleError('hand-in-progress', 'A hand is already in progress.');
  const eligible = eligibleSeats(state);
  if (!game.running || eligible.length < MIN_PLAYERS) return;
  const players = state.seats.filter((s) => eligible.includes(s.seat));
  const dealer = game.nextDealer !== null && eligible.includes(game.nextDealer) ? game.nextDealer : clockwise(players, game.dealer ?? 0)[0].seat;
  game.nextDealer = null;
  const order = clockwise(players, dealer);
  const headsUp = order.length === 2;
  const smallBlind = headsUp ? dealer : order[0].seat;
  const bigBlind = headsUp ? order[0].seat : order[1].seat;
  const deck = ctx.deck();
  const hand: Hand = {
    id: game.handNo + 1,
    dealer,
    smallBlind,
    bigBlind,
    street: 'preflop',
    board: [],
    deck,
    players: order.map((s) => ({ seat: s.seat, userId: s.userId, hole: [], bet: 0, total: 0, folded: false, allIn: false, acted: null })),
    currentBet: settings.bigBlind,
    minRaise: settings.bigBlind,
    toAct: null,
    turn: 0,
    deadline: null,
  };
  for (let round = 0; round < 2; round += 1) for (const p of hand.players) p.hole.push(deck.shift()!);
  game.handNo = hand.id;
  game.dealer = dealer;
  game.hand = hand;
  game.last = null;
  put(state, hand.players.find((p) => p.seat === smallBlind)!, settings.smallBlind);
  put(state, hand.players.find((p) => p.seat === bigBlind)!, settings.bigBlind);
  advance(state, bigBlind, ctx);
}

/** Moves the turn to the next player needing action after `from`, or ends the round. */
function advance(state: TableState, from: number, ctx: Context): void {
  const hand = state.game.hand!;
  for (;;) {
    if (hand.players.filter((p) => !p.folded).length === 1) return finish(state, ctx);
    const next = clockwise(hand.players, from).find((p) => needsAction(hand, p));
    if (next) {
      hand.toAct = next.seat;
      hand.turn += 1;
      hand.deadline = state.game.paused ? null : ctx.now + state.settings.turnSeconds * 1000;
      if (!seatState(state, next.seat).away) return;
      // Away players act at once instead of holding up the table.
      apply(state, next, toCall(hand, next) === 0 ? 'check' : 'fold', undefined);
      from = next.seat;
      continue;
    }
    returnUncalled(state);
    if (hand.street === 'river') return finish(state, ctx);
    for (const p of hand.players) {
      p.bet = 0;
      p.acted = null;
    }
    hand.currentBet = 0;
    hand.minRaise = state.settings.bigBlind;
    hand.deck.shift();
    const count = hand.street === 'preflop' ? 3 : 1;
    for (let i = 0; i < count; i += 1) hand.board.push(hand.deck.shift()!);
    hand.street = hand.street === 'preflop' ? 'flop' : hand.street === 'flop' ? 'turn' : 'river';
    from = hand.dealer;
  }
}

function returnUncalled(state: TableState): void {
  const hand = state.game.hand!;
  const sorted = [...hand.players].sort((a, b) => b.total - a.total);
  if (sorted.length < 2) return;
  const excess = sorted[0].total - sorted[1].total;
  if (excess > 0) {
    sorted[0].total -= excess;
    sorted[0].bet -= excess;
    seatState(state, sorted[0].seat).stack += excess;
    if (sorted[0].allIn) sorted[0].allIn = false;
  }
}

function apply(state: TableState, p: HandPlayer, action: Action, amount: number | undefined): void {
  const hand = state.game.hand!;
  const stack = seatState(state, p.seat).stack;
  const owed = toCall(hand, p);
  if (action === 'allin') {
    const legal = options(state, p.seat)?.raise;
    // Without a legal raise (short stack, or betting not reopened), all-in means calling what is owed.
    if (legal && stack > owed) {
      action = legal.kind;
      amount = legal.max;
    } else if (owed > 0) {
      action = 'call';
    } else {
      throw new RuleError('illegal-action', 'You cannot raise here; check instead.');
    }
  }
  switch (action) {
    case 'fold':
      p.folded = true;
      break;
    case 'check':
      if (owed > 0) throw new RuleError('illegal-action', 'You cannot check facing a bet.');
      p.acted = hand.currentBet;
      break;
    case 'call':
      if (owed === 0) throw new RuleError('illegal-action', 'There is nothing to call.');
      put(state, p, owed);
      p.acted = hand.currentBet;
      break;
    case 'bet':
    case 'raise': {
      const legal = options(state, p.seat)?.raise;
      if (!legal) throw new RuleError('illegal-action', 'Raising is not allowed here.');
      if (legal.kind !== action) throw new RuleError('illegal-action', action === 'bet' ? 'There is already a bet; raise instead.' : 'Nothing has been bet; bet instead.');
      if (amount === undefined || !Number.isSafeInteger(amount) || amount < legal.min || amount > legal.max) {
        throw new RuleError('bad-amount', `${action === 'bet' ? 'Bet' : 'Raise to'} between ${legal.min} and ${legal.max}.`);
      }
      const to = amount;
      const increment = to - hand.currentBet;
      put(state, p, to - p.bet);
      if (increment >= hand.minRaise) {
        hand.minRaise = increment;
        for (const other of hand.players) if (other !== p) other.acted = null;
      }
      hand.currentBet = Math.max(hand.currentBet, to);
      p.acted = hand.currentBet;
      break;
    }
    default: {
      const never: never = action;
      throw new RuleError('illegal-action', `Unknown action ${String(never)}.`);
    }
  }
}

export function act(state: TableState, seat: number, handId: number, turn: number, action: Action, amount: number | undefined, ctx: Context): void {
  const hand = state.game.hand;
  if (!hand || hand.id !== handId || hand.turn !== turn) throw new RuleError('stale', 'That turn has already passed.');
  if (state.game.paused) throw new RuleError('paused', 'The hand is paused until the host resumes it.');
  if (hand.toAct !== seat) throw new RuleError('not-your-turn', 'It is not your turn.');
  if (hand.deadline !== null && hand.deadline <= ctx.now) throw new RuleError('stale', 'That turn has expired.');
  const p = hand.players.find((x) => x.seat === seat)!;
  apply(state, p, action, amount);
  seatState(state, seat).missed = 0;
  advance(state, seat, ctx);
}

/** Server-clock deadline: check when legal, otherwise fold. */
export function timeout(state: TableState, handId: number, turn: number, ctx: Context): boolean {
  const hand = state.game.hand;
  if (!hand || hand.id !== handId || hand.turn !== turn || state.game.paused || hand.toAct === null) return false;
  if (hand.deadline === null || hand.deadline > ctx.now) return false;
  const p = hand.players.find((x) => x.seat === hand.toAct)!;
  const seat = seatState(state, p.seat);
  seat.missed += 1;
  if (seat.missed >= 2) seat.away = true;
  apply(state, p, toCall(hand, p) === 0 ? 'check' : 'fold', undefined);
  advance(state, p.seat, ctx);
  return true;
}

/** After a restart the interrupted turn is frozen until the host resumes; downtime never counts against a player. */
export function pause(state: TableState): boolean {
  const hand = state.game.hand;
  if (!hand || state.game.paused) return false;
  state.game.paused = true;
  hand.deadline = null;
  return true;
}

export function resume(state: TableState, ctx: Context): void {
  const hand = state.game.hand;
  if (!hand || !state.game.paused) throw new RuleError('not-paused', 'There is no paused hand.');
  state.game.paused = false;
  hand.deadline = ctx.now + state.settings.turnSeconds * 1000;
}

export function comeBack(state: TableState, seat: number, ctx: Context): void {
  const s = seatState(state, seat);
  s.away = false;
  s.missed = 0;
  maybeSchedule(state, ctx.now);
}

function finish(state: TableState, ctx: Context): void {
  const hand = state.game.hand!;
  returnUncalled(state);
  const live = hand.players.filter((p) => !p.folded);
  // advance() runs the board out to the river before a multi-way finish.
  const showdown = live.length > 1;
  const scores = new Map(live.map((p) => [p.seat, showdown ? evaluate([...p.hole, ...hand.board]) : 0]));
  const pots = layerPots(hand.players);
  const leftOfButton = clockwise(hand.players, hand.dealer);
  const results: PotResult[] = pots.map((pot) => {
    const best = Math.max(...pot.eligible.map((seat) => scores.get(seat)!));
    const winners = leftOfButton.filter((p) => pot.eligible.includes(p.seat) && scores.get(p.seat) === best).map((p) => p.seat);
    const share = Math.floor(pot.amount / winners.length);
    let odd = pot.amount - share * winners.length;
    return {
      amount: pot.amount,
      eligible: pot.eligible,
      winners: winners.map((seat) => {
        const extra = odd > 0 ? 1 : 0;
        odd -= extra;
        return { seat, amount: share + extra };
      }),
    };
  });
  const won = new Map<number, number>();
  for (const pot of results) for (const w of pot.winners) won.set(w.seat, (won.get(w.seat) ?? 0) + w.amount);
  for (const [seat, amount] of won) seatState(state, seat).stack += amount;
  state.game.last = {
    id: hand.id,
    endedAt: ctx.now,
    board: hand.board,
    showdown,
    pots: results,
    shown: showdown ? live.map((p) => ({ seat: p.seat, userId: p.userId, cards: p.hole, label: describe(scores.get(p.seat)!) })) : [],
    net: hand.players.map((p) => ({ seat: p.seat, userId: p.userId, amount: (won.get(p.seat) ?? 0) - p.total })),
  };
  state.game.hand = null;
  maybeSchedule(state, ctx.now);
}

/** Splits contributions into a main pot and side pots; layers with the same eligible players merge. */
export function layerPots(players: Pick<HandPlayer, 'seat' | 'total' | 'folded'>[]): { amount: number; eligible: number[] }[] {
  const levels = [...new Set(players.map((p) => p.total).filter((t) => t > 0))].sort((a, b) => a - b);
  const pots: { amount: number; eligible: number[] }[] = [];
  let previous = 0;
  for (const level of levels) {
    const amount = players.reduce((sum, p) => sum + Math.min(p.total, level) - Math.min(p.total, previous), 0);
    const eligible = players.filter((p) => !p.folded && p.total >= level).map((p) => p.seat).sort((a, b) => a - b);
    const last = pots.at(-1);
    // Uncalled chips are returned first, so a top layer always has a live contributor; merging keeps chips safe regardless.
    if (last && (last.eligible.join() === eligible.join() || !eligible.length)) last.amount += amount;
    else pots.push({ amount, eligible });
    previous = level;
  }
  return pots;
}
