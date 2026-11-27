import type { DatabaseSync } from 'node:sqlite';
import { effectiveReceipt } from './ledger.ts';

const TARGET = 1900; // Headroom below Fluxer's 2,000-character message limit.
const FOOTER = '\nCash flow, not winnings. Amounts are in minor units; chips are not cash.';

interface CurrencyTotals {
  userId: string;
  name: string;
  currency: string;
  inMinor: bigint;
  outMinor: bigint;
}

export class PokerLeaderboard {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  setOptIn(userId: string, enabled: boolean, messageId: string): boolean {
    // Snowflakes can exceed signed SQLite integers and JS safe numbers. Keep the opt-out
    // tombstone so an earlier Gateway event cannot opt someone back in after a reconnect.
    return this.db.prepare(`INSERT INTO poker_leaderboard_opt_in (user_id, enabled, message_id) VALUES (?, ?, ?)
      ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, message_id = excluded.message_id
      WHERE length(excluded.message_id) > length(message_id)
         OR (length(excluded.message_id) = length(message_id) AND excluded.message_id > message_id)`)
      .run(userId, enabled ? 1 : 0, messageId).changes !== 0;
  }

  /** Aggregate effective journal rows across tables, never across currencies. */
  messages(): string[] {
    const statement = this.db.prepare(`SELECT e.user_id AS userId, u.name, e.currency,
        sum(CASE WHEN e.kind != 'cash-out' THEN e.amount_minor ELSE 0 END) AS inMinor,
        sum(CASE WHEN e.kind = 'cash-out' THEN e.amount_minor ELSE 0 END) AS outMinor
      FROM poker_leaderboard_opt_in o
      JOIN ledger_entries e ON e.user_id = o.user_id
      JOIN users u ON u.id = e.user_id
      WHERE o.enabled = 1 AND ${effectiveReceipt('e')}
      GROUP BY e.table_id, e.user_id, e.currency`);
    // SQLite sums per table; accumulate across tables with exact integers.
    statement.setReadBigInts(true);
    const currencies = new Map<string, Map<string, CurrencyTotals>>();
    for (const row of statement.iterate() as unknown as Iterable<CurrencyTotals>) {
      let players = currencies.get(row.currency);
      if (!players) {
        players = new Map();
        currencies.set(row.currency, players);
      }
      const current = players.get(row.userId);
      if (current) {
        current.inMinor += row.inMinor;
        current.outMinor += row.outMinor;
      } else {
        players.set(row.userId, row);
      }
    }

    const messages: string[] = [];
    const append = (section: string) => {
      const last = messages.at(-1);
      if (last && last.length + 2 + section.length + FOOTER.length <= TARGET) {
        messages[messages.length - 1] = `${last}\n\n${section}`;
      } else {
        messages.push(section);
      }
    };
    for (const currency of [...currencies.keys()].sort()) {
      const players = [...currencies.get(currency)!.values()].sort((a, b) => {
        const diff = (b.outMinor - b.inMinor) - (a.outMinor - a.inMinor);
        return diff === 0n ? (a.userId < b.userId ? -1 : 1) : diff < 0n ? -1 : 1;
      });
      const heading = `${currency} running settlements`;
      let section = heading;
      for (const player of players) {
        const name = player.name.replace(/[^\p{L}\p{N} -]+/gu, '').trim().slice(0, 40) || 'player';
        const row = `\n${name} — In ${player.inMinor}, Out ${player.outMinor}, Net ${player.outMinor - player.inMinor}`;
        if (section.length + row.length + FOOTER.length > TARGET) {
          append(section);
          section = heading;
        }
        section += row;
      }
      append(section);
    }
    return messages.map((message) => message + FOOTER);
  }
}

