import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.ts';
import { type Card, cardName } from './game/cards.ts';
import {
  act, buyIn, changeSettings, comeBack, type Context, dealHand, DEFAULT_SETTINGS, eligibleSeats, type Game, leave, maybeSchedule,
  NEW_GAME, normalizeDenominations, options, pause, resume, RuleError, startGame, stopGame, type TableState, timeout,
  validateSettings,
} from './game/engine.ts';
import { shuffledDeck } from './game/shuffle.ts';
import { isRecord } from './guards.ts';
import type { Ledger } from './ledger.ts';
import {
  type Ack, type Action, type Command, DEFAULT_CHIP_DENOMINATIONS, type EntryRequest, MAX_CHIPS,
  MAX_CORRECTION_REASON, MAX_MINOR, PROTOCOL_VERSION, type SeatView, type Settings, type Snapshot,
} from './protocol.ts';
import { SEATS, Tables } from './tables.ts';

export const COMMAND_ID = /^[A-Za-z0-9_-]{8,64}$/;
const ACTIONS = new Set<string>(['fold', 'check', 'call', 'bet', 'raise', 'allin']);

interface TableRow {
  host_id: string;
  closed_at: number | null;
  version: number;
  settings: string | null;
  game: string | null;
}

interface SeatRow {
  seat: number;
  user_id: string;
  stack: number;
  away: number;
  missed: number;
}

function isAction(value: string): value is Action {
  return ACTIONS.has(value);
}

function isCount(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min;
}

/** Validates a command's shape at the socket boundary. Rule legality is the engine's job. */
export function parseCommand(value: unknown): Command {
  const bad = new RuleError('bad-command', 'That command is not valid.');
  if (!isRecord(value)) throw bad;
  const type = value.type;
  switch (type) {
    case 'act': {
      const { handId, turn, action, amount } = value;
      if (!isCount(handId, 1) || !isCount(turn, 0) || typeof action !== 'string' || !isAction(action)) throw bad;
      if (amount === undefined) return { type, handId, turn, action };
      if (!isCount(amount, 0)) throw bad;
      return { type, handId, turn, action, amount };
    }
    case 'settings':
      return { type, settings: validateSettings(value.settings) };
    case 'start':
      if (value.dealer === undefined) return { type };
      if (!isCount(value.dealer, 1)) throw bad;
      return { type, dealer: value.dealer };
    case 'buyin':
    case 'cashout': {
      const { amountMinor, chips, currency, userId } = value;
      if (!isCount(amountMinor, 0) || amountMinor > MAX_MINOR || !isCount(chips, 0)
        || typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw bad;
      if (type === 'buyin') {
        if (typeof userId !== 'string' || !/^\d{1,20}$/.test(userId) || chips === 0) throw bad;
        const { requestId } = value;
        if (requestId !== undefined && !isCount(requestId, 1)) throw bad;
        return requestId === undefined ? { type, userId, amountMinor, currency, chips }
          : { type, userId, amountMinor, currency, chips, requestId };
      }
      if (typeof userId !== 'string' || !/^\d{1,20}$/.test(userId)) throw bad;
      return { type, userId, amountMinor, currency, chips };
    }
    case 'correct-ledger': {
      const { entryId, amountMinor, chips, reason } = value;
      if (!isCount(entryId, 1) || !isCount(amountMinor, 0) || amountMinor > MAX_MINOR || !isCount(chips, 0)) throw bad;
      if (typeof reason !== 'string') throw bad;
      const trimmed = reason.trim();
      if (!trimmed || trimmed.length > MAX_CORRECTION_REASON) throw bad;
      return { type, entryId, amountMinor, chips, reason: trimmed };
    }
    case 'decline-entry': {
      if (!isCount(value.requestId, 1)) throw bad;
      return { type, requestId: value.requestId };
    }
    case 'stop':
    case 'resume':
    case 'back':
    case 'leave':
    case 'close':
      return { type };
    default:
      throw new RuleError('unknown-command', 'Unknown command.');
  }
}

function failure(id: string, error: RuleError): Ack {
  return { v: PROTOCOL_VERSION, type: 'ack', id, ok: false, code: error.code, error: error.message };
}

/**
 * The single authority for table state. Every change runs in one SQLite transaction that also records the command
 * for deduplication; listeners hear about it only after commit.
 */
export class Play {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly deck: () => Card[];
  private readonly ledger: Ledger;
  private readonly botPosts: boolean;
  private readonly tables: Tables | null;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  onChange: (tableId: string) => void = () => {};
  onError: (error: unknown) => void = () => {};

  constructor(db: DatabaseSync, now: () => number, ledger: Ledger, botPosts: boolean, deck: () => Card[] = shuffledDeck,
    tables?: Tables) {
    this.db = db;
    this.now = now;
    this.deck = deck;
    this.ledger = ledger;
    this.botPosts = botPosts;
    this.tables = tables ?? null;
  }

  private context(): Context {
    return { now: this.now(), deck: this.deck };
  }

  private load(tableId: string): { row: TableRow; state: TableState } {
    // Row shapes mirror the STRICT schema in db.ts.
    const row = this.db.prepare('SELECT host_id, closed_at, version, settings, game FROM tables WHERE id = ?').get(tableId) as TableRow | undefined;
    if (!row) throw new RuleError('not-found', 'Table not found.');
    const seats = this.db.prepare('SELECT seat, user_id, stack, away, missed FROM seats WHERE table_id = ? ORDER BY seat')
      .all(tableId) as unknown as SeatRow[];
    const game: Game = row.game ? JSON.parse(row.game) : structuredClone(NEW_GAME);
    return {
      row,
      state: {
        settings: row.settings ? JSON.parse(row.settings) : { ...DEFAULT_SETTINGS },
        seats: seats.map((s) => ({ seat: s.seat, userId: s.user_id, stack: s.stack, away: s.away === 1, missed: s.missed })),
        game,
      },
    };
  }

  private save(tableId: string, state: TableState): number {
    const update = this.db.prepare('UPDATE seats SET stack = ?, away = ?, missed = ? WHERE table_id = ? AND seat = ?');
    for (const s of state.seats) update.run(s.stack, s.away ? 1 : 0, s.missed, tableId, s.seat);
    const kept = state.seats.map((s) => s.seat);
    this.db.prepare(`DELETE FROM seats WHERE table_id = ? AND seat NOT IN (${kept.map(() => '?').join(',')})`).run(tableId, ...kept);
    const row = this.db.prepare('UPDATE tables SET settings = ?, game = ?, version = version + 1 WHERE id = ? RETURNING version')
      .get(JSON.stringify(state.settings), JSON.stringify(state.game), tableId);
    if (typeof row?.version !== 'number') throw new Error('table vanished during save');
    return row.version;
  }

  private apply(userId: string, tableId: string, id: string, command: Command): number {
    const { row, state } = this.load(tableId);
    if (row.closed_at !== null) throw new RuleError('table-closed', 'This table has closed.');
    const seat = state.seats.find((s) => s.userId === userId)?.seat;
    if (seat === undefined) throw new RuleError('not-seated', 'You no longer have a seat at this table.');
    const host = row.host_id === userId;
    const ctx = this.context();
    if (!host && ['settings', 'start', 'stop', 'resume', 'close', 'cashout', 'buyin', 'correct-ledger', 'decline-entry'].includes(command.type)) {
      throw new RuleError('host-only', 'Only the host can do that.');
    }
    const previous = state.game.last;
    switch (command.type) {
      case 'act':
        act(state, seat, command.handId, command.turn, command.action, command.amount, ctx);
        break;
      case 'settings':
        if (command.settings.currency !== state.settings.currency && this.ledger.currency(tableId) !== null) {
          throw new RuleError('currency-locked', 'Currency cannot change after the first ledger entry.');
        }
        changeSettings(state, command.settings);
        break;
      case 'start':
        startGame(state, command.dealer, ctx);
        break;
      case 'stop':
        stopGame(state);
        break;
      case 'resume':
        resume(state, ctx);
        break;
      case 'buyin': {
        if (state.game.hand) throw new RuleError('hand-in-progress', 'Issue chips between hands.');
        let target = state.seats.find((s) => s.userId === command.userId);
        if (command.requestId !== undefined) {
          if (target) throw new RuleError('stale-buyin', 'That entry request has already been used.');
          if (!this.tables) throw new RuleError('unknown-command', 'Entry requests are unavailable.');
          const taken = state.seats.map((s) => s.seat);
          const seat = this.tables.approveEntry(tableId, command.userId, command.requestId, taken);
          target = { seat, userId: command.userId, stack: 0, away: false, missed: 0 };
          state.seats.push(target);
        }
        if (target?.stack) throw new RuleError('has-chips', 'Rebuys require an empty stack.');
        if (!target) throw new RuleError('stale-buyin', 'That player no longer has a seat at this table.');
        if (command.currency !== state.settings.currency) {
          throw new RuleError('stale-buyin', 'The table currency changed. Review the issuance before confirming.');
        }
        if (!Number.isSafeInteger(command.chips) || command.chips < 1 || command.chips > MAX_CHIPS
          || !Number.isSafeInteger(command.amountMinor) || command.amountMinor > MAX_MINOR) {
          throw new RuleError('bad-chips', 'The issuance must be a whole number of chip units within the table limit.');
        }
        if (this.ledger.chipsInPlay(tableId) + command.chips > SEATS * MAX_CHIPS) {
          throw new RuleError('chips-in-play', 'The table chip supply is exhausted.');
        }
        buyIn(state, target.seat, ctx, command.chips);
        this.ledger.record(tableId, {
          userId: target.userId, actorId: userId, commandId: id,
          kind: this.ledger.hasBuyIn(tableId, target.userId) ? 'rebuy' : 'buy-in',
          amountMinor: command.amountMinor, currency: command.currency, chips: command.chips,
          createdAt: ctx.now, handNo: state.game.handNo,
        });
        break;
      }
      case 'correct-ledger': {
        if (state.game.hand) throw new RuleError('hand-in-progress', 'Corrections apply between hands.');
        const { entryId, amountMinor, chips, reason } = command;
        const receipt = this.ledger.receipt(tableId, entryId);
        if (!receipt || receipt.superseded || receipt.voided) {
          throw new RuleError('stale-correction', 'That receipt no longer exists, was voided, or was already superseded.');
        }
        const issuing = receipt.kind !== 'cash-out';
        const voided = issuing && chips === 0 && amountMinor === 0;
        if (!issuing && chips !== 0) throw new RuleError('bad-chips', 'Cash-out corrections change money only.');
        if (issuing && (chips > MAX_CHIPS || (chips === 0 && !voided))) {
          throw new RuleError('bad-chips', 'Enter a positive chip count or void the whole issuance.');
        }
        const chipFix = issuing && chips !== receipt.chips;
        if (chipFix && !receipt.chipAvailable) {
          throw new RuleError('stale-correction', 'Only the latest unplayed issuance can change the chip stack.');
        }
        if (!chipFix && amountMinor === receipt.amountMinor) {
          throw new RuleError('stale-correction', 'Nothing changes; the receipt already records those terms.');
        }
        if (chipFix) {
          if (!voided && this.ledger.chipsInPlay(tableId) - receipt.chips + chips > SEATS * MAX_CHIPS) {
            throw new RuleError('chips-in-play', 'The table chip supply is exhausted.');
          }
          state.seats.find((s) => s.userId === receipt.userId)!.stack = chips;
          if (eligibleSeats(state).length < 2) state.game.nextHandAt = null;
          else maybeSchedule(state, ctx.now);
        }
        this.ledger.record(tableId, {
          userId: receipt.userId, actorId: userId, commandId: id, amountMinor, currency: receipt.currency,
          kind: receipt.kind, chips: issuing && !voided ? chips : receipt.chips, createdAt: ctx.now,
          handNo: receipt.handNo, correction: { entryId: receipt.rootId, reason, voided },
        });
        break;
      }
      case 'cashout': {
        if (state.game.hand) throw new RuleError('hand-in-progress', 'Cash out between hands.');
        const target = state.seats.find((s) => s.userId === command.userId);
        if (!target || target.stack !== command.chips || command.currency !== state.settings.currency) {
          throw new RuleError('stale-cashout', 'The player, stack, or currency changed. Review the cash-out before confirming.');
        }
        if (target.stack < 1) throw new RuleError('stale-cashout', 'That player has no chips to cash out.');
        this.ledger.record(tableId, {
          userId: target.userId, actorId: userId, commandId: id, kind: 'cash-out',
          amountMinor: command.amountMinor, currency: command.currency, chips: target.stack, createdAt: ctx.now,
          handNo: null,
        });
        target.stack = 0;
        if (eligibleSeats(state).length < 2) state.game.nextHandAt = null;
        break;
      }
      case 'decline-entry': {
        if (state.game.hand) throw new RuleError('hand-in-progress', 'Decide entry requests between hands.');
        if (!this.tables) throw new RuleError('unknown-command', 'Entry requests are unavailable.');
        this.tables.declineEntry(tableId, command.requestId);
        break;
      }
      case 'back':
        comeBack(state, seat, ctx);
        break;
      case 'leave':
        if (host) throw new RuleError('host-stays', 'The host keeps their seat; close the table instead.');
        leave(state, seat);
        this.tables?.advanceEntryOrbit(tableId, state.seats.map((s) => s.userId), null, state.game.handNo);
        break;
      case 'close':
        if (state.game.hand) throw new RuleError('hand-in-progress', 'Close the table between hands.');
        if (state.seats.some((s) => s.stack > 0)) throw new RuleError('unsettled-stacks', 'Record a cash-out for every remaining stack before closing.');
        stopGame(state);
        this.db.prepare('UPDATE tables SET closed_at = ? WHERE id = ?').run(ctx.now, tableId);
        this.db.prepare('UPDATE invites SET revoked_at = ? WHERE table_id = ? AND revoked_at IS NULL').run(ctx.now, tableId);
        break;
      default: {
        const never: never = command;
        throw new RuleError('unknown-command', `Unknown command ${String(never)}.`);
      }
    }
    if (state.game.last && state.game.last !== previous) {
      this.ledger.recordHand(tableId, state.game.last);
      this.advanceEntryOrbit(tableId, state);
    }
    return this.save(tableId, state);
  }

  /**
   * Applies a player's command once. A retry with the same ID and payload returns the first result, even after a
   * restart; reusing an ID for a different payload is refused. Rule failures are recorded too, so a retry can never
   * succeed later against a different turn.
   */
  command(userId: string, tableId: string, id: string, payload: unknown): Ack {
    let command: Command;
    try {
      command = parseCommand(payload);
    } catch (error) {
      if (error instanceof RuleError) return failure(id, error);
      throw error;
    }
    const hash = createHash('sha256').update(JSON.stringify(command)).digest('base64url');
    const { ack, changed } = transaction(this.db, () => {
      const prior = this.db.prepare('SELECT payload_hash, result, command_type FROM commands WHERE table_id = ? AND user_id = ? AND command_id = ?')
        .get(tableId, userId, id);
      if (prior) {
        const reused = prior.payload_hash !== hash;
        const audited = ['buyin', 'cashout', 'correct-ledger'].includes(command.type)
          || ['buyin', 'cashout', 'correct-ledger'].includes(String(prior.command_type));
        if (audited) {
          this.db.prepare('INSERT INTO command_retries (table_id, user_id, command_id, received_hash, reused, attempted_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(tableId, userId, id, hash, reused ? 1 : 0, this.now());
        }
        if (reused) return { ack: failure(id, new RuleError('command-id-reused', 'That command ID was already used.')), changed: false };
        const stored: Ack = JSON.parse(String(prior.result));
        const ack: Ack = { ...stored, v: PROTOCOL_VERSION };
        return { ack, changed: false };
      }
      let result: Ack;
      this.db.exec('SAVEPOINT command');
      try {
        result = { v: PROTOCOL_VERSION, type: 'ack', id, ok: true, version: this.apply(userId, tableId, id, command) };
        this.db.exec('RELEASE command');
      } catch (error) {
        this.db.exec('ROLLBACK TO command');
        this.db.exec('RELEASE command');
        if (!(error instanceof RuleError)) throw error;
        result = failure(id, error);
      }
      this.db.prepare('INSERT INTO commands (table_id, user_id, command_id, payload_hash, result, created_at, command_type) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(tableId, userId, id, hash, JSON.stringify(result), this.now(), command.type);
      return { ack: result, changed: result.ok };
    });
    if (changed) this.committed(tableId);
    return ack;
  }

  private committed(tableId: string): void {
    this.schedule(tableId);
    this.onChange(tableId);
  }

  private advanceEntryOrbit(tableId: string, state: TableState): void {
    if (!this.tables || !state.game.last) return;
    const { dealer: dealerSeat, handNo } = state.game;
    const dealer = state.game.last.net.find((s) => s.seat === dealerSeat)?.userId ?? null;
    this.tables.advanceEntryOrbit(tableId, state.seats.map((s) => s.userId), dealer, handNo);
  }

  /** Fires when a turn deadline or the next deal is due, on the server clock. */
  wake(tableId: string): void {
    clearTimeout(this.timers.get(tableId));
    this.timers.delete(tableId);
    try {
      const changed = transaction(this.db, () => {
        const { row, state } = this.load(tableId);
        if (row.closed_at !== null) return false;
        const ctx = this.context();
        const hand = state.game.hand;
        const previous = state.game.last;
        let due = false;
        if (hand) due = timeout(state, hand.id, hand.turn, ctx);
        else if (state.game.nextHandAt !== null && state.game.nextHandAt <= ctx.now) {
          dealHand(state, ctx);
          due = true;
        }
        if (due) {
          if (state.game.last && state.game.last !== previous) {
            this.ledger.recordHand(tableId, state.game.last);
            this.advanceEntryOrbit(tableId, state);
          }
          this.save(tableId, state);
        }
        return due;
      });
      if (changed) this.onChange(tableId);
    } catch (error) {
      this.onError(error);
    }
    this.schedule(tableId);
  }

  private schedule(tableId: string): void {
    clearTimeout(this.timers.get(tableId));
    this.timers.delete(tableId);
    const row = this.db.prepare('SELECT game FROM tables WHERE id = ? AND closed_at IS NULL').get(tableId);
    if (typeof row?.game !== 'string') return;
    const game: Game = JSON.parse(row.game);
    const at = game.hand ? game.hand.deadline : game.nextHandAt;
    if (at === null) return;
    const timer = setTimeout(() => this.wake(tableId), Math.max(0, at - this.now()));
    timer.unref();
    this.timers.set(tableId, timer);
  }

  /** On startup: freeze interrupted hands for the host to resume, so downtime never times anyone out. */
  recover(): void {
    const ids = this.db.prepare('SELECT id FROM tables WHERE closed_at IS NULL AND game IS NOT NULL').all().map((row) => String(row.id));
    for (const id of ids) {
      transaction(this.db, () => {
        const { state } = this.load(id);
        if (pause(state)) this.save(id, state);
      });
      this.schedule(id);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /** The table as one player may see it: their own hole cards only, never the deck or anyone else's cards. */
  view(tableId: string, userId: string, connected: Set<string>): Snapshot {
    const { row, state } = this.load(tableId);
    const profiles = new Map(this.db.prepare('SELECT seats.seat, users.name, users.avatar FROM seats JOIN users ON users.id = seats.user_id WHERE seats.table_id = ?')
      .all(tableId).map((p) => [p.seat, { name: String(p.name), avatar: typeof p.avatar === 'string' ? p.avatar : null }]));
    const { game } = state;
    const hand = game.hand;
    const players = new Map(hand?.players.map((p) => [p.seat, p]));
    const seats: (SeatView | null)[] = Array(SEATS).fill(null);
    for (const s of state.seats) {
      const p = players.get(s.seat);
      seats[s.seat - 1] = {
        seat: s.seat,
        userId: s.userId,
        name: profiles.get(s.seat)?.name ?? 'Player',
        avatar: profiles.get(s.seat)?.avatar ?? null,
        connected: connected.has(s.userId),
        stack: s.stack,
        away: s.away,
        hand: p ? { bet: p.bet, total: p.total, folded: p.folded, allIn: p.allIn } : null,
      };
    }
    const mine = state.seats.find((s) => s.userId === userId)?.seat ?? 0;
    const last = game.last;
    return {
      v: PROTOCOL_VERSION,
      type: 'snapshot',
      tableId,
      version: row.version,
      serverNow: this.now(),
      hostId: row.host_id,
      closed: row.closed_at !== null,
      currencyLocked: this.ledger.currency(tableId) !== null,
      botPosts: this.botPosts && userId === row.host_id,
      entryRequests: userId === row.host_id && this.tables ? this.tables.entryRequests(tableId) : [],
      settings: { ...state.settings, denominations: normalizeDenominations(state.settings.denominations ?? DEFAULT_CHIP_DENOMINATIONS) },
      game: { running: game.running, paused: game.paused, handNo: game.handNo, dealer: game.dealer, nextHandAt: game.nextHandAt },
      seats,
      hand: hand && {
        id: hand.id,
        street: hand.street,
        board: hand.board.map(cardName),
        dealer: hand.dealer,
        smallBlind: hand.smallBlind,
        bigBlind: hand.bigBlind,
        pot: hand.players.reduce((sum, p) => sum + p.total, 0),
        currentBet: hand.currentBet,
        toAct: hand.toAct,
        turn: hand.turn,
        deadline: hand.deadline,
      },
      you: {
        seat: mine, cards: players.get(mine)?.hole.map(cardName) ?? [],
        options: mine ? options(state, mine) : null, boughtIn: mine > 0 && this.ledger.hasBuyIn(tableId, userId),
      },
      last: last && this.ledger.lastHand(tableId, last),
    };
  }
}
