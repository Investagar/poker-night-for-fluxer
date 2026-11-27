import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hashToken } from './auth.ts';
import type { Config } from './config.ts';
import { transaction } from './db.ts';
import { Problem } from './errors.ts';
import type { Fluxer } from './fluxer.ts';
import { effectiveReceipt } from './ledger.ts';
import type { NotificationRequest, NotificationResult } from './protocol.ts';

interface PostRow {
  id: string;
  table_id: string;
  kind: NotificationRequest['type'];
  channel_id: string;
  invite_hash: string | null;
  ledger_through: number | null;
  status: NotificationResult['status'];
  message_id: string | null;
}

const response = (row: PostRow): NotificationResult => ({ status: row.status, messageId: row.message_id });

/** Explicit host requests, deliberately separate from socket commands and the game clock. */
export class Notifications {
  private readonly db: DatabaseSync;
  private readonly config: Config;
  private readonly fluxer: Fluxer;
  private readonly now: () => number;

  constructor(db: DatabaseSync, config: Config, fluxer: Fluxer, now: () => number) {
    this.db = db;
    this.config = config;
    this.fluxer = fluxer;
    this.now = now;
    // When the previous process died during a send, delivery cannot be known. Never replay it automatically.
    this.db.prepare("UPDATE notifications SET status = 'unconfirmed' WHERE status = 'pending'").run();
  }

  async post(tableId: string, actorId: string, request: NotificationRequest): Promise<NotificationResult> {
    const channel = this.config.channelId;
    if (!channel) throw new Problem(409, 'bot-disabled', 'Bot posts are not configured.');
    const inviteHash = request.type === 'invite' ? hashToken(request.token) : null;
    const accepted = transaction(this.db, () => {
      const table = this.db.prepare('SELECT host_id, closed_at FROM tables WHERE id = ?').get(tableId);
      if (!table) throw new Problem(404, 'not-found', 'Table not found.');
      if (table.host_id !== actorId) throw new Problem(403, 'host-only', 'Only the host can post to Fluxer.');
      const prior = this.db.prepare('SELECT * FROM notifications WHERE table_id = ? AND actor_id = ? AND command_id = ?')
        .get(tableId, actorId, request.id) as PostRow | undefined;
      if (prior) {
        if (prior.kind !== request.type || prior.invite_hash !== inviteHash) {
          throw new Problem(409, 'command-id-reused', 'This post ID has already been used for another request.');
        }
        return { prior };
      }
      if (inviteHash !== null && (table.closed_at !== null || !this.activeInvite(tableId, inviteHash))) {
        throw new Problem(409, 'invite-invalid', 'Only the current invite can be posted. Replace or copy the current link first.');
      }
      const ledgerThrough = request.type === 'settlement'
        ? this.db.prepare('SELECT max(id) AS id FROM ledger_entries WHERE table_id = ?').get(tableId)?.id ?? null
        : null;
      if (request.type === 'settlement' && ledgerThrough === null) {
        throw new Problem(409, 'no-settlements', 'There are no ledger entries to summarize.');
      }
      const id = randomBytes(16).toString('hex');
      this.db.prepare(`INSERT INTO notifications (id, table_id, actor_id, command_id, kind, channel_id, invite_hash, ledger_through, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, tableId, actorId, request.id, request.type, channel, inviteHash, ledgerThrough, this.now());
      return { id };
    });
    if (accepted.prior) return response(accepted.prior);

    const row = this.db.prepare('SELECT * FROM notifications WHERE id = ?').get(accepted.id) as unknown as PostRow;
    let messageId: string | null = null;
    try {
      await this.fluxer.checkPostChannel(row.channel_id);
      const content = this.content(row, request);
      if (content) messageId = await this.fluxer.postMessage(row.channel_id, content, row.id);
    } catch {
      // A provider error never rolls back a table, and no token/message content is logged.
    }
    const status = messageId ? 'sent' : 'unconfirmed';
    this.db.prepare('UPDATE notifications SET status = ?, message_id = ? WHERE id = ?').run(status, messageId, row.id);
    return { status, messageId };
  }

  private activeInvite(tableId: string, hash: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM invites WHERE table_id = ? AND token_hash = ? AND revoked_at IS NULL').get(tableId, hash));
  }

  private content(row: PostRow, request: NotificationRequest): string | null {
    if (row.kind === 'invite') {
      // The plaintext link exists only in this request. The committed hash must still be current after the channel check.
      if (request.type !== 'invite' || !row.invite_hash || !this.activeInvite(row.table_id, row.invite_hash)) return null;
      return `Join a private Poker Night table: ${this.config.publicOrigin}/join/${row.table_id}#${request.token}`;
    }
    const amounts = this.db.prepare(`SELECT currency,
        sum(CASE WHEN e.kind != 'cash-out' THEN e.amount_minor ELSE 0 END) AS in_minor,
        sum(CASE WHEN e.kind = 'cash-out' THEN e.amount_minor ELSE 0 END) AS out_minor
      FROM ledger_entries e
      WHERE e.table_id = ? AND e.id <= ?
        AND ${effectiveReceipt('e', '?')}
      GROUP BY currency`).get(row.table_id, row.ledger_through, row.ledger_through);
    if (!amounts) return null;
    const { currency, in_minor: totalIn, out_minor: totalOut } = amounts;
    return `Poker Night settlement summary (${currency} minor units): in ${totalIn}, out ${totalOut}, net ${Number(totalOut) - Number(totalIn)}.\n` +
      `Recorded external settlements only. No payments were moved. ${this.config.publicOrigin}/history/${row.table_id}`;
  }
}
