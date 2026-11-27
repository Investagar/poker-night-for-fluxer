import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Test-only stand-in for a Fluxer instance: discovery, OAuth2 (authorize/token/userinfo), bot REST and messages. */
export interface FakeUser {
  id: string;
  username: string;
  global_name?: string | null;
  avatar?: string | null;
  nick?: string | null;
  memberAvatar?: string | null;
  bot?: boolean;
  system?: boolean;
  member?: boolean;
}

export interface FakeMessage {
  channelId: string;
  content: string;
  nonce: string;
  flags: number;
  allowedMentions: { parse: string[] };
}

export const GUILD_ID = '100';
/** The one channel the configured bot may post to; a different ID does not exist for the bot. */
export const CHANNEL_ID = '300';
export const CLIENT_ID = '200';
export const CLIENT_SECRET = 'fake-client-secret';
export const BOT_TOKEN = 'fake-bot-token';

export class FakeFluxer {
  readonly users = new Map<string, FakeUser>();
  readonly messages: FakeMessage[] = [];
  readonly directMessages = new Map<string, string>();
  readonly blockedDirectMessages = new Set<string>();
  outage = false;
  botAccount = true;
  failMessages = 0;
  memberLookups = 0;
  origin = '';
  /** Guild the test channel belongs to; the bot's configured guild defaults to it. */
  channelGuildId = GUILD_ID;
  /** Optional observer of committed dispatch rows while the provider request is in flight. */
  onPost: (message: FakeMessage) => void = () => {};
  /** Optional barrier for a channel lookup that is still in flight. */
  onChannelCheck: (() => Promise<void>) | null = null;
  /** First error an `onPost` observer threw, so a test can rethrow it even when the app saw only HTTP 500. */
  postError: unknown = null;
  /** The fake receives `failNext` failures once, then serves requests again. */
  failNext = 0;
  /** Origin advertised for API calls, e.g. one a container can reach. Defaults to `origin`. */
  apiOrigin = '';
  private server: Server | undefined;
  private readonly codes = new Map<string, { userId: string; challenge: string; redirectUri: string; used: boolean }>();
  /** Issued OAuth access tokens, so tests can assert the app never stores them. */
  readonly tokens = new Map<string, string>();

  constructor(users: FakeUser[] = []) {
    for (const user of users) this.users.set(user.id, user);
  }

  async start(port = 0, host = '127.0.0.1'): Promise<void> {
    this.server = createServer((request, response) => {
      this.handle(request, response).catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
    });
    this.server.listen(port, host);
    await once(this.server, 'listening');
    const address = this.server.address() as AddressInfo;
    this.origin = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${address.port}`;
    if (!this.apiOrigin) this.apiOrigin = this.origin;
  }

  async stop(): Promise<void> {
    if (!this.server?.listening) return;
    this.server.close();
    this.server.closeAllConnections();
    await once(this.server, 'close');
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }

  private async body(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.origin);
    const path = url.pathname;
    const auth = request.headers.authorization ?? '';

    if (path === '/.well-known/fluxer') {
      return this.json(response, 200, {
        endpoints: { api: this.apiOrigin + '/api', webapp: this.origin, gateway: 'ws://unused.invalid', media: this.origin + '/media' },
      });
    }
    if (path.startsWith('/login/')) {
      // Browser tests pick the signed-in Fluxer account by visiting this page first.
      const id = decodeURIComponent(path.slice('/login/'.length));
      response.writeHead(200, { 'set-cookie': `fake_user=${id}; Path=/; HttpOnly`, 'content-type': 'text/plain' }).end('signed in as ' + id);
      return;
    }
    if (path === '/oauth2/authorize') {
      const userId = /(?:^|;\s*)fake_user=([^;]+)/.exec(request.headers.cookie ?? '')?.[1];
      const q = url.searchParams;
      if (q.get('client_id') !== CLIENT_ID || q.get('response_type') !== 'code' || q.get('scope') !== 'identify'
        || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state') || !q.get('redirect_uri')) {
        return this.json(response, 400, { error: 'invalid_request' });
      }
      if (!userId || !this.users.has(userId)) return this.json(response, 401, { error: 'login_required' });
      const code = this.issueCode(userId, q.get('code_challenge')!, q.get('redirect_uri')!);
      const target = new URL(q.get('redirect_uri')!);
      target.searchParams.set('code', code);
      target.searchParams.set('state', q.get('state')!);
      response.writeHead(302, { location: target.toString() }).end();
      return;
    }
    if (path === '/api/v1/oauth2/token' && request.method === 'POST') {
      const form = new URLSearchParams(await this.body(request));
      if (form.get('client_id') !== CLIENT_ID || form.get('client_secret') !== CLIENT_SECRET) {
        return this.json(response, 400, { error: 'invalid_client' });
      }
      const grant = this.codes.get(form.get('code') ?? '');
      if (!grant || grant.used || form.get('grant_type') !== 'authorization_code') return this.json(response, 400, { error: 'invalid_grant' });
      grant.used = true;
      const verifier = form.get('code_verifier') ?? '';
      if (grant.redirectUri !== form.get('redirect_uri') || createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) {
        return this.json(response, 400, { error: 'invalid_grant' });
      }
      const token = randomBytes(16).toString('hex');
      this.tokens.set(token, grant.userId);
      return this.json(response, 200, { access_token: token, token_type: 'Bearer', expires_in: 604800, refresh_token: 'r' + token, scope: 'identify' });
    }
    if (path === '/api/v1/oauth2/userinfo') {
      const user = this.users.get(this.tokens.get(auth.replace(/^Bearer /, '')) ?? '');
      if (!user) return this.json(response, 401, { code: 'UNAUTHORIZED' });
      return this.json(response, 200, {
        sub: user.id, id: user.id, username: user.username, discriminator: '0001', global_name: user.global_name ?? null,
        avatar: user.avatar ?? null, bot: user.bot ?? false, system: user.system ?? false, flags: 0,
      });
    }
    if (!path.startsWith('/api/v1/')) return this.json(response, 404, { code: 'NOT_FOUND' });
    if (auth !== 'Bot ' + BOT_TOKEN) return this.json(response, 401, { code: 'UNAUTHORIZED' });
    if (path === '/api/v1/users/@me') return this.json(response, 200, { id: '900', username: 'pokerbot', bot: this.botAccount });
    if (path === '/api/v1/users/@me/channels' && request.method === 'POST') {
      const body = JSON.parse(await this.body(request));
      const userId = body?.recipient_id;
      if (typeof userId !== 'string' || !this.users.has(userId)) return this.json(response, 404, { code: 'UNKNOWN_USER' });
      if (this.blockedDirectMessages.has(userId)) return this.json(response, 403, { code: 'ACCESS_DENIED' });
      const id = this.directMessages.get(userId) ?? String(6000 + this.directMessages.size);
      this.directMessages.set(userId, id);
      return this.json(response, 200, { id, type: 1, recipients: [{ id: userId }] });
    }
    const guildChannel = /^\/api\/v1\/channels\/(\d+)$/.exec(path);
    if (guildChannel && request.method === 'GET') {
      if (this.outage) return this.json(response, 503, { code: 'SERVICE_UNAVAILABLE' });
      if (guildChannel[1] !== CHANNEL_ID) return this.json(response, 404, { code: 'UNKNOWN_CHANNEL' });
      if (this.onChannelCheck) await this.onChannelCheck();
      // The channel genuinely lives in `channelGuildId`; the bot must notice a configured-guild mismatch itself.
      return this.json(response, 200, { id: CHANNEL_ID, guild_id: this.channelGuildId });
    }
    const member = /^\/api\/v1\/guilds\/(\d+)\/members\/(\d+)$/.exec(path);
    if (member) {
      this.memberLookups += 1;
      if (this.outage) return this.json(response, 503, { code: 'SERVICE_UNAVAILABLE' });
      const user = this.users.get(member[2]);
      if (member[1] !== GUILD_ID || !user || user.member === false) return this.json(response, 404, { code: 'UNKNOWN_MEMBER' });
      return this.json(response, 200, {
        user: { id: user.id, username: user.username, global_name: user.global_name ?? null, avatar: user.avatar ?? null, bot: user.bot ?? false },
        nick: user.nick ?? null,
        avatar: user.memberAvatar ?? null,
      });
    }
    const channel = /^\/api\/v1\/channels\/(\d+)\/messages$/.exec(path);
    if (channel && request.method === 'POST') {
      if (this.outage || this.failMessages > 0 || this.failNext > 0) {
        if (this.failNext > 0) this.failNext -= 1;
        else this.failMessages = Math.max(0, this.failMessages - 1);
        return this.json(response, 503, { code: 'SERVICE_UNAVAILABLE' });
      }
      const body: unknown = JSON.parse(await this.body(request));
      if (!body || typeof body !== 'object' || !('content' in body) || typeof body.content !== 'string'
        || !('nonce' in body) || typeof body.nonce !== 'string'
        || !('flags' in body) || body.flags !== 4
        || !('allowed_mentions' in body) || JSON.stringify(body.allowed_mentions) !== '{"parse":[]}') {
        return this.json(response, 400, { code: 'INVALID_FORM_BODY' });
      }
      const { content, nonce } = body;
      const message: FakeMessage = {
        channelId: channel[1], content, nonce, flags: 4, allowedMentions: { parse: [] },
      };
      try {
        this.onPost(message);
      } catch (error) {
        this.postError ??= error;
        throw error;
      }
      const existing = this.messages.find((m) => m.channelId === channel[1] && m.nonce === nonce);
      if (!existing) this.messages.push(message);
      return this.json(response, 200, { id: String(this.messages.length), channel_id: channel[1], content, nonce });
    }
    return this.json(response, 404, { code: 'NOT_FOUND' });
  }

  issueCode(userId: string, challenge: string, redirectUri: string): string {
    const code = randomBytes(16).toString('hex');
    this.codes.set(code, { userId, challenge, redirectUri, used: false });
    return code;
  }
}
