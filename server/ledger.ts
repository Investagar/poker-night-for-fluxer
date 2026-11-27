import type { DatabaseSync } from 'node:sqlite';
import { scalar } from './db.ts';
import { Problem } from './errors.ts';
import { cardName } from './game/cards.ts';
import { type Game, RuleError } from './game/engine.ts';
import {
  type HandHistory, type HistoryTable, MAX_MINOR, type LastHand, type LedgerEntry, type LedgerKind, type LedgerView,
} from './protocol.ts';

type HandResult = NonNullable<Game['last']>;
const PAGE = 25;

function supersededReceipt(alias: 'e' | 'later', cutoff?: '?') {
  return `EXISTS (SELECT 1 FROM ledger_entries r
    WHERE r.table_id = ${alias}.table_id AND coalesce(r.corrects_id, r.id) = coalesce(${alias}.corrects_id, ${alias}.id)
      AND r.id > ${alias}.id${cutoff ? ' AND r.id <= ?' : ''})`;
}

/** Newest non-void revision of each receipt, optionally as of a committed cutoff. */
export function effectiveReceipt(alias: 'e' | 'later', cutoff?: '?'): string {
  return `(NOT ${supersededReceipt(alias, cutoff)} AND ${alias}.voided = 0)`;
}

const CHIP_CORRECTION = `e.kind != 'cash-out' AND ${effectiveReceipt('e')}
  AND t.closed_at IS NULL AND json_extract(t.game, '$.hand') IS NULL
  AND e.hand_no = coalesce(json_extract(t.game, '$.handNo'), 0)
  AND EXISTS (SELECT 1 FROM seats s WHERE s.table_id = e.table_id AND s.user_id = e.user_id AND s.stack = e.chips)
  AND NOT EXISTS (SELECT 1 FROM ledger_entries later
    WHERE later.table_id = e.table_id AND later.user_id = e.user_id
      AND coalesce(later.corrects_id, later.id) > coalesce(e.corrects_id, e.id) AND ${effectiveReceipt('later')})`;

type LedgerWrite = Pick<LedgerEntry, 'userId' | 'actorId' | 'commandId' | 'kind' | 'amountMinor' | 'currency' | 'chips' | 'createdAt'> & {
  handNo: number | null;
  correction?: NonNullable<LedgerEntry['correction']>;
};

function publicHand(last: HandResult): LastHand {
  return {
    id: last.id,
    board: last.board.map(cardName),
    showdown: last.showdown,
    pots: last.pots,
    shown: last.shown.map((s) => ({ seat: s.seat, cards: s.cards.map(cardName), label: s.label })),
    net: last.net.map((n) => ({ seat: n.seat, amount: n.amount })),
  };
}

/** Durable external settlements and completed, public hand results. Writes run in Play's transaction. */
export class Ledger {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  currency(tableId: string): string | null {
    const row = this.db.prepare('SELECT currency FROM ledger_entries WHERE table_id = ? ORDER BY id LIMIT 1').get(tableId);
    return row ? String(row.currency) : null;
  }

  /** Whether the player holds any buy-in/rebuy issuance (a cash-out alone does not count). */
  hasBuyIn(tableId: string, userId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM ledger_entries WHERE table_id = ? AND user_id = ? AND kind != 'cash-out' LIMIT 1")
      .get(tableId, userId));
  }

  /** Chip supply already in play: the total of every effective non-cash-out issuance, voids excluded. */
  chipsInPlay(tableId: string): number {
    return scalar(this.db, `SELECT coalesce(sum(chips), 0) FROM ledger_entries e
      WHERE e.table_id = ? AND e.kind != 'cash-out' AND ${effectiveReceipt('e')}`, tableId);
  }

  record(tableId: string, entry: LedgerWrite): void {
    const total = scalar(this.db, 'SELECT coalesce(sum(amount_minor), 0) FROM ledger_entries WHERE table_id = ?', tableId);
    if (!Number.isSafeInteger(total + entry.amountMinor)) throw new RuleError('ledger-limit', 'This table has reached its ledger limit.');
    const { correction } = entry;
    this.db.prepare(`INSERT INTO ledger_entries (table_id, user_id, actor_id, command_id, kind, amount_minor, currency, chips,
        created_at, corrects_id, correction_reason, voided, hand_no)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(tableId, entry.userId, entry.actorId, entry.commandId, entry.kind, entry.amountMinor, entry.currency, entry.chips,
        entry.createdAt, correction?.entryId ?? null, correction?.reason ?? null, correction?.voided ? 1 : 0, entry.handNo);
  }

  private publicResult(last: HandResult): HandHistory {
    // Use stable player IDs, not whoever holds a seat after the hand.
    const ids = last.net.map((p) => p.userId);
    const players = this.db.prepare(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    return {
      ...publicHand(last),
      endedAt: last.endedAt,
      players: last.net.map((p) => ({
        seat: p.seat, userId: p.userId, name: String(players.find((user) => user.id === p.userId)?.name ?? `Seat ${p.seat}`),
      })),
    };
  }

  lastHand(tableId: string, last: HandResult): HandHistory {
    const row = this.db.prepare('SELECT result FROM hand_history WHERE table_id = ? AND hand_id = ?').get(tableId, last.id);
    return row ? JSON.parse(String(row.result)) : this.publicResult(last);
  }

  recordHand(tableId: string, last: HandResult): void {
    const result = this.publicResult(last);
    this.db.prepare('INSERT INTO hand_history (table_id, hand_id, result) VALUES (?, ?, ?)')
      .run(tableId, last.id, JSON.stringify(result));
  }

  tables(userId: string): HistoryTable[] {
    return this.db.prepare(`SELECT t.id, u.name AS hostName, t.closed_at IS NOT NULL AS closed
      FROM tables t JOIN users u ON u.id = t.host_id
      WHERE EXISTS (SELECT 1 FROM seats s WHERE s.table_id = t.id AND s.user_id = ?)
         OR EXISTS (SELECT 1 FROM ledger_entries e WHERE e.table_id = t.id AND e.user_id = ?)
      ORDER BY t.created_at DESC, t.id`).all(userId, userId).map((r) => ({ id: String(r.id), hostName: String(r.hostName), closed: r.closed === 1 }));
  }

  view(tableId: string, userId: string, before: number, beforeHand: number, botPosts: boolean): LedgerView {
    const table = this.db.prepare(`SELECT t.host_id, t.closed_at, u.name AS host_name FROM tables t JOIN users u ON t.host_id = u.id
      WHERE t.id = ? AND (EXISTS (SELECT 1 FROM seats s WHERE s.table_id = t.id AND s.user_id = ?)
        OR EXISTS (SELECT 1 FROM ledger_entries e WHERE e.table_id = t.id AND e.user_id = ?))`).get(tableId, userId, userId);
    if (!table) throw new Problem(404, 'not-found', 'Table history was not found.');
    const host = table.host_id === userId;
    const permitted = host ? null : userId;
    const rows = this.db.prepare(`SELECT e.id, e.corrects_id AS correctsId, e.user_id AS userId, u.name AS name,
        e.actor_id AS actorId, a.name AS actorName, e.command_id AS commandId, e.kind,
        e.amount_minor AS amountMinor, e.currency, e.chips, e.created_at AS createdAt,
        e.voided, e.correction_reason AS reason, ${supersededReceipt('e')} AS superseded,
        CASE WHEN ? AND ${CHIP_CORRECTION} THEN 1 ELSE 0 END AS chipAvailable
      FROM ledger_entries e JOIN users u ON u.id = e.user_id JOIN users a ON a.id = e.actor_id
      JOIN tables t ON t.id = e.table_id
      WHERE e.table_id = ? AND (? IS NULL OR e.user_id = ?) AND e.id < ? ORDER BY e.id DESC LIMIT ?`)
      .all(host ? 1 : 0, tableId, permitted, permitted, before, PAGE + 1) as unknown as ({
      id: number; kind: LedgerKind; userId: string; name: unknown; actorId: string; actorName: unknown; commandId: string;
      amountMinor: number; currency: string; chips: number; createdAt: number; voided: number;
      correctsId: number | null; superseded: number; chipAvailable: number; reason: string | null;
    })[];
    const entries: LedgerEntry[] = rows.slice(0, PAGE).map((row) => ({
      id: row.id,
      kind: row.kind,
      userId: row.userId,
      name: String(row.name),
      actorId: row.actorId,
      actorName: String(row.actorName),
      commandId: row.commandId,
      amountMinor: row.amountMinor,
      currency: row.currency,
      chips: row.voided ? 0 : row.chips,
      createdAt: row.createdAt,
      correction: row.correctsId === null ? null : { entryId: row.correctsId, reason: row.reason ?? '', voided: row.voided === 1 },
      superseded: row.superseded === 1,
      chipCorrectionAvailable: row.chipAvailable === 1,
    }));
    const sums = this.db.prepare(`SELECT e.user_id AS userId, u.name, currency,
        sum(CASE WHEN e.kind != 'cash-out' THEN e.amount_minor ELSE 0 END) AS inMinor,
        sum(CASE WHEN e.kind = 'cash-out' THEN e.amount_minor ELSE 0 END) AS outMinor
      FROM ledger_entries e JOIN users u ON u.id = e.user_id
      WHERE e.table_id = ? AND ${effectiveReceipt('e')} AND (? IS NULL OR e.user_id = ?)
      GROUP BY e.user_id, currency ORDER BY u.name, e.user_id`)
      .all(tableId, permitted, permitted) as unknown as Omit<LedgerView['totals'][number], 'netMinor'>[];
    const results = this.db.prepare('SELECT result FROM hand_history WHERE table_id = ? AND hand_id < ? ORDER BY hand_id DESC LIMIT ?')
      .all(tableId, beforeHand, PAGE + 1).map((r): HandHistory => JSON.parse(String(r.result)));
    return {
      tableId, host, hostName: String(table.host_name), closed: table.closed_at !== null, botPosts: host && botPosts,
      entries, next: rows.length > PAGE ? rows[PAGE - 1].id : null,
      totals: sums.map((s) => ({ ...s, netMinor: s.outMinor - s.inMinor })),
      hands: results.slice(0, PAGE), nextHand: results.length > PAGE ? results[PAGE - 1].id : null,
    };
  }

  receipt(tableId: string, entryId: number) {
    const row = this.db.prepare(`SELECT coalesce(e.corrects_id, e.id) AS rootId, e.user_id AS userId,
        e.currency, e.amount_minor AS amountMinor, e.chips, e.hand_no AS handNo, e.kind, e.voided,
        ${supersededReceipt('e')} AS superseded, CASE WHEN ${CHIP_CORRECTION} THEN 1 ELSE 0 END AS chipAvailable
      FROM ledger_entries e JOIN tables t ON t.id = e.table_id WHERE e.table_id = ? AND e.id = ?`)
      .get(tableId, entryId) as (Pick<LedgerWrite, 'userId' | 'currency' | 'amountMinor' | 'chips' | 'handNo' | 'kind'> & {
        rootId: number;
        superseded: number;
        voided: number;
        chipAvailable: number;
      }) | undefined;
    return row;
  }
}
