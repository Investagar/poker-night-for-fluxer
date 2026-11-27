import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hashToken, saveUser } from './auth.ts';
import { scalar, transaction } from './db.ts';
import { Problem } from './errors.ts';
import type { Member } from './fluxer.ts';
import { RuleError } from './game/engine.ts';
import type { EntryRequest, EntryStatus, TableSummary } from './protocol.ts';

export const SEATS = 10;
export const MAX_OPEN_TABLES_PER_HOST = 3;

interface TableRow {
  id: string;
  host_id: string;
  closed_at: number | null;
  version: number;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_PENDING_ENTRIES = 20;
export const TABLE_ID = /^[A-Za-z0-9_-]{22}$/;

export class Tables {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(db: DatabaseSync, now: () => number) {
    this.db = db;
    this.now = now;
  }

  private table(tableId: string): TableRow | undefined {
    // Row shapes in this class mirror the STRICT schema in db.ts.
    const row = this.db.prepare('SELECT id, host_id, closed_at, version FROM tables WHERE id = ?').get(tableId) as TableRow | undefined;
    return row;
  }

  private newInvite(tableId: string): string {
    const token = randomBytes(32).toString('base64url');
    this.db.prepare('UPDATE invites SET revoked_at = ? WHERE table_id = ? AND revoked_at IS NULL').run(this.now(), tableId);
    this.db.prepare('INSERT INTO invites (token_hash, table_id, created_at) VALUES (?, ?, ?)').run(hashToken(token), tableId, this.now());
    return token;
  }

  create(hostId: string): { tableId: string; invite: string } {
    return transaction(this.db, () => this.insertTable(hostId));
  }

  hasBotRoom(messageId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM bot_table_commands WHERE message_id = ?').get(messageId));
  }

  /** A Gateway replay never creates a second table for the same Fluxer message. */
  createFromMessage(member: Member, messageId: string): { tableId: string; invite: string } | null {
    return transaction(this.db, () => {
      if (this.hasBotRoom(messageId)) return null;
      saveUser(this.db, member, this.now());
      const created = this.insertTable(member.id);
      this.db.prepare('INSERT INTO bot_table_commands (message_id, table_id) VALUES (?, ?)').run(messageId, created.tableId);
      return created;
    });
  }

  private insertTable(hostId: string): { tableId: string; invite: string } {
    if (scalar(this.db, 'SELECT count(*) FROM tables WHERE host_id = ? AND closed_at IS NULL', hostId) >= MAX_OPEN_TABLES_PER_HOST) {
      throw new Problem(429, 'too-many-tables', `You can host at most ${MAX_OPEN_TABLES_PER_HOST} open tables.`);
    }
    const tableId = randomBytes(16).toString('base64url');
    const now = this.now();
    this.db.prepare('INSERT INTO tables (id, host_id, created_at) VALUES (?, ?, ?)').run(tableId, hostId, now);
    this.db.prepare('INSERT INTO seats (table_id, seat, user_id, joined_at) VALUES (?, 1, ?, ?)').run(tableId, hostId, now);
    return { tableId, invite: this.newInvite(tableId) };
  }

  entryStatus(userId: string, tableId: string): EntryStatus {
    if (this.seatOf(tableId, userId) !== null) return { status: 'seated' };
    const row = this.db.prepare(`SELECT r.id, r.declined, json_array_length(r.remaining) AS remaining
      FROM table_entry_requests r JOIN tables t ON t.id = r.table_id
      WHERE r.table_id = ? AND r.user_id = ? AND t.closed_at IS NULL`).get(tableId, userId);
    if (!row) return { status: 'none' };
    if (row.declined) return { status: 'declined' };
    return { status: 'waiting', requestId: Number(row.id), remaining: Number(row.remaining) };
  }

  /** A redeemed invite requests admission; it cannot grant a seat or expose a live hand. */
  requestEntry(userId: string, tableId: string, token: unknown): { state: EntryStatus; notifyHost: string | null } {
    return transaction(this.db, () => {
      const table = this.table(tableId);
      if (!table || table.closed_at !== null) throw new Problem(404, 'invite-invalid', 'This invite is invalid or the table has closed.');
      const state = this.entryStatus(userId, tableId);
      if (state.status === 'seated' || state.status === 'waiting') return { state, notifyHost: null };
      if (typeof token !== 'string' || !TOKEN.test(token) || !this.db.prepare(
        'SELECT 1 FROM invites WHERE token_hash = ? AND table_id = ? AND revoked_at IS NULL',
      ).get(hashToken(token), tableId)) throw new Problem(403, 'invite-invalid', 'This invite link is invalid or has been replaced.');
      if (scalar(this.db, 'SELECT count(*) FROM seats WHERE table_id = ?', tableId) >= SEATS) {
        throw new Problem(409, 'table-full', 'This table is full.');
      }
      if (scalar(this.db, 'SELECT count(*) FROM table_entry_requests WHERE table_id = ? AND declined = 0', tableId) >= MAX_PENDING_ENTRIES) {
        throw new Problem(409, 'entry-queue-full', 'Too many requests are waiting for the Table master. Try again later.');
      }
      // Record who still has to hold the button. The in-flight hand started before this request.
      const players = this.db.prepare(`SELECT s.user_id FROM seats s JOIN tables t ON t.id = s.table_id
        WHERE s.table_id = ? AND json_extract(t.game, '$.handNo') > 0
          AND (s.stack > 0 OR EXISTS (SELECT 1 FROM json_each(t.game, '$.hand.players') p
            WHERE json_extract(p.value, '$.userId') = s.user_id))`).all(tableId).map((row) => String(row.user_id));
      this.db.prepare('DELETE FROM table_entry_requests WHERE table_id = ? AND user_id = ?').run(tableId, userId);
      const request = this.db.prepare(`INSERT INTO table_entry_requests (table_id, user_id, remaining, requested_hand)
        VALUES (?, ?, ?, (SELECT coalesce(json_extract(game, '$.handNo'), 0) FROM tables WHERE id = ?)) RETURNING id`)
        .get(tableId, userId, JSON.stringify(players), tableId);
      this.db.prepare('UPDATE tables SET version = version + 1 WHERE id = ?').run(tableId);
      return { state: { status: 'waiting', requestId: Number(request!.id), remaining: players.length }, notifyHost: table.host_id };
    });
  }

  entryRequests(tableId: string): EntryRequest[] {
    return this.db.prepare(`SELECT r.id, u.id AS user_id, u.name, u.avatar, json_array_length(r.remaining) AS remaining
      FROM table_entry_requests r JOIN users u ON u.id = r.user_id WHERE r.table_id = ? AND r.declined = 0
      ORDER BY r.id`).all(tableId).map((row) => ({
      id: Number(row.id),
      user: { id: String(row.user_id), name: String(row.name), avatar: typeof row.avatar === 'string' ? row.avatar : null },
      remaining: Number(row.remaining),
    }));
  }

  approveEntry(tableId: string, userId: string, requestId: number, taken: number[]): number {
    const row = this.db.prepare(`SELECT json_array_length(remaining) AS remaining FROM table_entry_requests
      WHERE id = ? AND table_id = ? AND user_id = ? AND declined = 0`).get(requestId, tableId, userId);
    if (!row) throw new RuleError('stale-buyin', 'This player no longer has that pending buy-in request.');
    if (Number(row.remaining) > 0) throw new RuleError('orbit-pending', 'Wait for the initial players to complete one dealer rotation.');
    let seat = 1;
    while (taken.includes(seat)) seat += 1;
    if (seat > SEATS) throw new RuleError('table-full', 'This table is full.');
    this.db.prepare('INSERT INTO seats (table_id, seat, user_id, joined_at) VALUES (?, ?, ?, ?)')
      .run(tableId, seat, userId, this.now());
    this.db.prepare('DELETE FROM table_entry_requests WHERE id = ?').run(requestId);
    return seat;
  }

  declineEntry(tableId: string, requestId: number): void {
    const changed = this.db.prepare('UPDATE table_entry_requests SET declined = 1 WHERE id = ? AND table_id = ? AND declined = 0')
      .run(requestId, tableId);
    if (changed.changes === 0) throw new RuleError('stale-buyin', 'That request is no longer pending.');
  }

  advanceEntryOrbit(tableId: string, seated: string[], completedDealer: string | null, completedHand: number): void {
    // Skipping an away seat doesn't count as taking the button. Only a completed
    // deal after the request or leaving the table removes a player from the orbit.
    this.db.prepare(`UPDATE table_entry_requests AS r SET remaining = (
      SELECT coalesce(json_group_array(p.value), '[]') FROM json_each(r.remaining) p
      WHERE p.value IN (SELECT value FROM json_each(?))
        AND (?2 IS NULL OR NOT (p.value = ?2 AND ?3 > r.requested_hand))
    ) WHERE r.table_id = ?4 AND r.declined = 0 AND r.remaining != '[]'`)
      .run(JSON.stringify(seated), completedDealer, completedHand, tableId);
  }

  rotateInvite(userId: string, tableId: string): string {
    return transaction(this.db, () => {
      const table = this.requireSeated(userId, tableId);
      if (table.host_id !== userId) throw new Problem(403, 'host-only', 'Only the host can replace the invite link.');
      if (table.closed_at !== null) throw new Problem(409, 'table-closed', 'This table has closed.');
      return this.newInvite(tableId);
    });
  }

  seatOf(tableId: string, userId: string): number | null {
    const seat = this.db.prepare('SELECT seat FROM seats WHERE table_id = ? AND user_id = ?').get(tableId, userId)?.seat;
    return typeof seat === 'number' ? seat : null;
  }

  /** Private tables are indistinguishable from missing ones to anyone without a seat. */
  requireSeated(userId: string, tableId: string): TableRow {
    const table = TABLE_ID.test(tableId) ? this.table(tableId) : undefined;
    if (!table || this.seatOf(tableId, userId) === null) throw new Problem(404, 'not-found', 'Table not found. Ask the host for an invite.');
    return table;
  }

  list(userId: string): TableSummary[] {
    const rows = this.db.prepare(`SELECT tables.id, tables.host_id, host.name AS host_name,
        (SELECT count(*) FROM seats s WHERE s.table_id = tables.id) AS players
      FROM seats JOIN tables ON tables.id = seats.table_id JOIN users host ON host.id = tables.host_id
      WHERE seats.user_id = ? AND tables.closed_at IS NULL ORDER BY tables.created_at DESC`).all(userId) as
      { id: string; host_id: string; host_name: string; players: number }[];
    return rows.map((row) => ({ id: row.id, hostName: row.host_name, host: row.host_id === userId, players: row.players }));
  }
}
