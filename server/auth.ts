import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from './config.ts';
import { scalar, transaction } from './db.ts';
import { Problem } from './errors.ts';
import type { Fluxer, Member } from './fluxer.ts';

export interface Session {
  hash: string;
  user: Member;
}

const FLOW_SECONDS = 300;
const MAX_SESSIONS = 10_000;
const MAX_USED_FLOWS = 4096;
const MEMBER_TTL_MS = 30_000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export function saveUser(db: DatabaseSync, member: Member, now: number): void {
  db.prepare(`INSERT INTO users (id, name, avatar, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar, updated_at = excluded.updated_at`)
    .run(member.id, member.name, member.avatar, now);
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export class Auth {
  readonly cookie: string;
  readonly flowCookie: string;
  private readonly config: Config;
  private readonly db: DatabaseSync;
  private readonly fluxer: Fluxer;
  private readonly now: () => number;
  private readonly secret = randomBytes(32);
  private readonly usedFlows = new Map<string, number>();
  private readonly checked = new Map<string, { member: Member; until: number }>();

  constructor(config: Config, db: DatabaseSync, fluxer: Fluxer, now: () => number) {
    this.config = config;
    this.db = db;
    this.fluxer = fluxer;
    this.now = now;
    this.cookie = config.secure ? '__Host-pokerbot' : 'pokerbot-local';
    this.flowCookie = this.cookie + '-login';
  }

  cookieHeader(name: string, value: string, seconds: number): string {
    return `${name}=${value}; Max-Age=${seconds}; Path=/; HttpOnly; SameSite=Lax${this.config.secure ? '; Secure' : ''}`;
  }

  private mac(purpose: string, payload: string): string {
    return createHmac('sha256', this.secret).update(purpose + ':' + payload).digest('base64url');
  }

  private flow(value: string | undefined): { payload: string; expires: number } | null {
    if (!value || value.length > 256) return null;
    const parts = value.split('.');
    if (parts.length !== 3 || parts[0].length !== 43 || !/^\d+$/.test(parts[1])) return null;
    const payload = parts[0] + '.' + parts[1];
    const expires = Number(parts[1]);
    const remaining = expires - this.now() / 1000;
    if (!safeEqual(parts[2], this.mac('cookie', payload)) || remaining <= 0 || remaining > FLOW_SECONDS) return null;
    if (this.usedFlows.has(payload)) return null;
    return { payload, expires };
  }

  private pruneFlows(): void {
    const now = this.now() / 1000;
    for (const [payload, expires] of this.usedFlows) if (expires <= now) this.usedFlows.delete(payload);
  }

  /** Starts sign-in; unauthenticated starts allocate no server-side state. */
  login(flowCookie: string | undefined): { location: string; cookie: string } {
    if (!this.fluxer.ready) throw new Problem(503, 'fluxer-unavailable', 'Fluxer discovery is unavailable. Try again shortly.');
    const existing = this.flow(flowCookie);
    const expires = existing?.expires ?? Math.floor(this.now() / 1000) + FLOW_SECONDS;
    const payload = existing?.payload ?? randomBytes(32).toString('base64url') + '.' + expires;
    const challenge = createHash('sha256').update(this.mac('pkce', payload)).digest('base64url');
    const query = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.publicOrigin + '/auth/callback',
      response_type: 'code',
      scope: 'identify',
      state: this.mac('state', payload),
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return {
      location: `${this.fluxer.webapp}/oauth2/authorize?${query}`,
      cookie: this.cookieHeader(this.flowCookie, payload + '.' + this.mac('cookie', payload),
        Math.max(1, Math.floor(expires - this.now() / 1000))),
    };
  }

  /** Completes sign-in and returns the new session token. Throws a Problem whose code becomes the UI state. */
  async callback(flowCookie: string | undefined, query: Record<string, unknown>, previousSession?: string): Promise<string> {
    const flow = this.flow(flowCookie);
    const state = typeof query.state === 'string' ? query.state : '';
    if (!flow || state.length > 256 || !safeEqual(this.mac('state', flow.payload), state)) {
      throw new Problem(400, 'expired', 'Sign-in expired. Try again.');
    }
    const code = typeof query.code === 'string' ? query.code : '';
    if (!code || code.length > 256) throw new Problem(400, 'cancelled', 'Sign-in was cancelled.');
    this.pruneFlows();
    if (this.usedFlows.size >= MAX_USED_FLOWS) throw new Problem(429, 'busy', 'Too many sign-in attempts. Try again shortly.');
    this.usedFlows.set(flow.payload, flow.expires);

    const accessToken = await this.fluxer.exchange(code, this.mac('pkce', flow.payload));
    const identity = await this.fluxer.identity(accessToken);
    // The OAuth tokens are deliberately dropped here: later checks use the bot's membership lookup.
    if (identity.bot || identity.system) throw new Problem(403, 'bot', 'Bot and system accounts cannot sign in.');
    const member = await this.fluxer.member(identity.id);
    this.checked.set(member.id, { member, until: this.now() + MEMBER_TTL_MS });

    const token = randomBytes(32).toString('base64url');
    const now = this.now();
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
      if (previousSession) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashToken(previousSession));
      if (scalar(this.db, 'SELECT count(*) FROM sessions') >= MAX_SESSIONS) throw new Problem(503, 'busy', 'Too many active sessions.');
      saveUser(this.db, member, now);
      this.db.prepare('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        .run(hashToken(token), member.id, now, now + this.config.sessionSeconds * 1000);
    });
    return token;
  }

  session(cookieHeader: string | undefined): Session | null {
    const token = parseCookies(cookieHeader).get(this.cookie);
    if (!token || token.length > 64) return null;
    return this.sessionByHash(hashToken(token));
  }

  /** Lets long-lived sockets re-validate the session they were opened with. */
  sessionByHash(hash: string): Session | null {
    const row = this.db.prepare(`SELECT users.id, users.name, users.avatar FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE sessions.id_hash = ? AND sessions.expires_at > ?`).get(hash, this.now()) as Member | undefined;
    return row ? { hash, user: { id: row.id, name: row.name, avatar: row.avatar } } : null;
  }

  /**
   * Rechecks community membership with a short cache. A confirmed non-member loses every session (callers close
   * sockets via onRevoked). With `failOpen`, a Fluxer outage keeps the last known profile instead of failing.
   */
  async recheck(session: Session, options: { failOpen: boolean }): Promise<Member> {
    const cached = this.checked.get(session.user.id);
    if (cached && cached.until > this.now()) return cached.member;
    try {
      const member = await this.fluxer.member(session.user.id);
      this.checked.set(member.id, { member, until: this.now() + MEMBER_TTL_MS });
      if (this.checked.size > 4096) this.checked.delete(this.checked.keys().next().value!);
      saveUser(this.db, member, this.now());
      return member;
    } catch (error) {
      if (error instanceof Problem && error.code === 'not-member') {
        this.checked.delete(session.user.id);
        this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(session.user.id);
        this.onRevoked(session.user.id);
        throw error;
      }
      if (options.failOpen) return session.user;
      throw error instanceof Problem ? error : new Problem(503, 'fluxer-unavailable', 'Fluxer is unavailable. Try again shortly.');
    }
  }

  onRevoked: (userId: string) => void = () => {};

  logout(cookieHeader: string | undefined): string | null {
    const session = this.session(cookieHeader);
    if (session) this.db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(session.hash);
    return session?.hash ?? null;
  }
}
