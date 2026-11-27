import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { Problem } from './errors.ts';
import type { Fluxer, Member } from './fluxer.ts';
import { FluxerGateway } from './gateway.ts';
import { isRecord } from './guards.ts';
import { PokerLeaderboard } from './leaderboard.ts';
import { RateLimiter } from './limits.ts';
import type { Tables } from './tables.ts';

const SNOWFLAKE = /^[1-9]\d{0,19}$/;
const ROOM = '!pokernight';
const RANKING = '!pokerleaderboard';
const OPT_IN = `${RANKING} opt-in`;
const OPT_OUT = `${RANKING} opt-out`;

/** Fluxer commands use the same table creator identity and ledger as the web app. */
export class PokerBot {
  private readonly config: Config;
  private readonly fluxer: Fluxer;
  private readonly tables: Tables;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly leaderboard: PokerLeaderboard;
  private readonly perUser = new RateLimiter(6, 5);
  private readonly global = new RateLimiter(30, 12, 1);
  /** Fire-and-forget notifications still in flight, so a caller can wait for them deterministically. */
  private readonly inflight = new Set<Promise<void>>();
  private gateway: FluxerGateway | undefined;
  private stopped = false;

  constructor(config: Config, db: DatabaseSync, fluxer: Fluxer, tables: Tables, now: () => number, warn: (message: string) => void) {
    this.config = config;
    this.fluxer = fluxer;
    this.tables = tables;
    this.now = now;
    this.warn = warn;
    this.leaderboard = new PokerLeaderboard(db);
  }

  start(): void {
    if (!this.config.botCommands || this.gateway || this.stopped) return;
    if (!this.fluxer.gateway) {
      this.warn('Fluxer command Gateway is unavailable; web play remains enabled.');
      return;
    }
    this.gateway = new FluxerGateway(this.fluxer.gateway, this.config.botToken,
      (data) => { void this.receive(data).catch(() => this.warn('A Fluxer poker command could not be completed.')); },
      () => this.warn('Fluxer command Gateway disconnected; web play remains enabled.'));
    this.gateway.start();
  }

  stop(): void {
    this.stopped = true;
    this.gateway?.stop();
  }

  async receive(data: unknown): Promise<void> {
    if (this.stopped || !this.config.botCommands || !isRecord(data) || data.guild_id !== this.config.guildId) return;
    const { id, channel_id: channel, content, author, type, flags } = data;
    if (typeof id !== 'string' || !SNOWFLAKE.test(id) || typeof channel !== 'string' || !SNOWFLAKE.test(channel)
      || typeof content !== 'string' || (type !== 0 && type !== 19) || data.webhook_id != null
      || (typeof flags === 'number' && (flags & (1 << 1)) !== 0) || !isRecord(author) || author.bot === true
      || author.system === true || typeof author.id !== 'string' || !SNOWFLAKE.test(author.id)) return;
    const command = content.trim().toLowerCase();
    if (command !== ROOM && (channel !== this.config.channelId || (command !== RANKING && command !== OPT_IN && command !== OPT_OUT))) return;
    const now = this.now();
    if (command === OPT_OUT) {
      // Revocation uses the authenticated Gateway author and happens even if a reply is rate limited.
      if (!this.leaderboard.setOptIn(author.id, false, id)) return;
      if (this.perUser.take(author.id, now) || this.global.take('all', now)) return;
      await this.fluxer.checkPostChannel(channel);
      if (!this.stopped) await this.fluxer.postMessage(channel, 'Opted out of future leaderboard replies. Previously posted messages do not change.', id);
      return;
    }
    if (this.perUser.take(author.id, now) || this.global.take('all', now)) return;

    let member: Member;
    try {
      member = await this.fluxer.member(author.id);
    } catch (error) {
      if (error instanceof Problem && error.code === 'not-member') return;
      throw error;
    }
    if (this.stopped) return;
    if (command === ROOM) {
      await this.createRoom(member, id, channel);
      return;
    }

    await this.fluxer.checkPostChannel(channel);
    if (this.stopped) return;
    if (command === OPT_IN) {
      if (!this.leaderboard.setOptIn(member.id, true, id)) return;
      await this.fluxer.postMessage(channel,
        'Opted in. Future leaderboard replies can show your name and recorded cash totals here. Use `!pokerleaderboard opt-out` to stop sharing.', id);
      return;
    }
    const messages = this.leaderboard.messages();
    if (messages.length === 0) {
      await this.fluxer.postMessage(channel, 'Nobody is sharing recorded settlements yet. Use `!pokerleaderboard opt-in` to share yours in this channel.', id);
      return;
    }
    for (let index = 0; index < messages.length && !this.stopped; index += 1) {
      await this.fluxer.postMessage(channel, messages[index], `${id}-${index}`);
    }
  }

  /** A player asked to enter a table; tell the Table master over DM, once per request. */
  notifyEntry(hostId: string, tableId: string, requestId: number): void {
    if (this.stopped) return;
    // Fire-and-forget: a Fluxer outage must never fail the player's request.
    const task = this.deliverEntryNotice(hostId, tableId, requestId);
    this.inflight.add(task);
    void task.finally(() => this.inflight.delete(task));
  }

  /** Resolves once the notifications already started have finished; tests and shutdown use it instead of sleeping. */
  async settled(): Promise<void> {
    while (this.inflight.size > 0) await Promise.all(this.inflight);
  }

  private async deliverEntryNotice(hostId: string, tableId: string, requestId: number): Promise<void> {
    const nonce = `entry-${tableId}-${requestId}`;
    try {
      const { publicOrigin } = this.config;
      await this.fluxer.postMessage(await this.fluxer.openDirectMessage(hostId),
        `A player is waiting to enter table ${tableId}. Approve or decline in the Table master:\n`
        + `${publicOrigin}/tables/${tableId}/manage`, nonce);
    } catch (error) {
      if (!this.stopped) this.warn(`Entry notification for table ${tableId} could not be delivered: ${String(error)}`);
    }
  }

  private async createRoom(member: Member, messageId: string, channel: string): Promise<void> {
    if (this.tables.hasBotRoom(messageId)) return;
    let dm: string | undefined;
    try {
      dm = await this.fluxer.openDirectMessage(member.id);
      if (this.stopped) return;
      const room = this.tables.createFromMessage(member, messageId);
      if (!room) return;
      const { publicOrigin } = this.config;
      await this.fluxer.postMessage(dm, `You are the Table master. Sign in as the Fluxer account that requested the table.\n`
        + `Table master (keep private): ${publicOrigin}/tables/${room.tableId}/manage\n`
        + `Player invite (share with players): ${publicOrigin}/join/${room.tableId}#${room.invite}`, messageId);
    } catch (error) {
      if (this.stopped) return;
      if (dm && error instanceof Problem && error.code === 'too-many-tables') {
        await this.fluxer.postMessage(dm, `${error.message} Close a table in Poker Night before creating another.`, messageId);
        return;
      }
      await this.fluxer.postMessage(channel, 'Poker Night could not confirm a direct message. Check your DMs and allow messages from the bot, or open Poker Night in your browser. No invite will be posted here.', messageId);
    }
  }
}
