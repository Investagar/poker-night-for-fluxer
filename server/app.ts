import { join, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest, LogController } from 'fastify';
import { Auth, parseCookies, type Session } from './auth.ts';
import { PokerBot } from './bot.ts';
import type { Config } from './config.ts';
import { Problem } from './errors.ts';
import { Fluxer } from './fluxer.ts';
import type { Card } from './game/cards.ts';
import { isRecord } from './guards.ts';
import { type Connection, Hub } from './hub.ts';
import { Ledger } from './ledger.ts';
import { clientAddress, RateLimiter } from './limits.ts';
import { Notifications } from './notifications.ts';
import { COMMAND_ID, Play } from './play.ts';
import { type NotificationRequest, PROTOCOL_VERSION } from './protocol.ts';
import { TABLE_ID, Tables } from './tables.ts';

export interface AppOptions {
  config: Config;
  db: DatabaseSync;
  now?: () => number;
  logger?: boolean;
  /** Test seam for a known deal; production always shuffles with node:crypto. */
  deck?: () => Card[];
}

export interface PokerApp {
  app: FastifyInstance;
  fluxer: Fluxer;
  auth: Auth;
  bot: PokerBot;
  tables: Tables;
  play: Play;
  hub: Hub;
}

interface TableRoute {
  Params: { tableId: string };
}

const MAX_MESSAGE_BYTES = 4096;

function historyCursor(value: unknown): number {
  if (value === undefined) return Number.MAX_SAFE_INTEGER + 1;
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value)) {
    const cursor = Number(value);
    if (Number.isSafeInteger(cursor)) return cursor;
  }
  throw new Problem(400, 'bad-cursor', 'History cursors must be positive safe integers.');
}

function notificationRequest(value: unknown): NotificationRequest {
  if (isRecord(value) && typeof value.id === 'string' && COMMAND_ID.test(value.id)) {
    const { id, type, token } = value;
    if (type === 'settlement' && Object.keys(value).length === 2) return { id, type };
    if (type === 'invite' && typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token) && Object.keys(value).length === 3) {
      return { id, type, token };
    }
  }
  throw new Problem(400, 'bad-notification', 'Provide a post ID and either a settlement request or the current invite token.');
}

export async function buildApp({ config, db, now = Date.now, logger = true, deck }: AppOptions): Promise<PokerApp> {
  const fluxer = new Fluxer(config);
  const auth = new Auth(config, db, fluxer, now);
  const tables = new Tables(db, now);
  const ledger = new Ledger(db);
  const notifications = new Notifications(db, config, fluxer, now);
  const botPosts = Boolean(config.channelId);
  const play = new Play(db, now, ledger, botPosts, deck, tables);
  const hub = new Hub((tableId, userId, connected) => play.view(tableId, userId, connected), now);
  play.onChange = (tableId) => hub.broadcast(tableId);
  auth.onRevoked = (userId) => hub.close((connection) => connection.userId === userId, 4003, 'not-member');
  // A sign-in costs two requests; ten friends behind one home NAT must fit in a burst.
  const authLimit = new RateLimiter(30, 30);
  const authGlobalLimit = new RateLimiter(600, 100);
  const mutationLimit = new RateLimiter(120, 20);

  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16 * 1024,
    requestTimeout: 10_000,
  });
  play.onError = (error) => app.log.error({ err: error }, 'table timer failed');
  const bot = new PokerBot(config, db, fluxer, tables, now, (message) => app.log.warn(message));

  const wsOrigin = config.publicOrigin.replace(/^http/, 'ws');
  app.addHook('onRequest', async (request, reply) => {
    const media = fluxer.media ? ' ' + new URL(fluxer.media).origin : '';
    reply.headers({
      'content-security-policy': `default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; object-src 'none'; img-src 'self' data:${media}; connect-src 'self' ${wsOrigin}`,
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    const encoding = request.headers['content-encoding'];
    if (encoding && encoding !== 'identity') throw new Problem(415, 'unsupported-encoding', 'Compressed request bodies are not accepted.');
    if (request.url.startsWith('/auth/')) {
      const retry = authLimit.take(clientAddress(request.socket.remoteAddress, request.headers['x-forwarded-for'], config.trustedProxies), now())
        || authGlobalLimit.take('all', now());
      // Sign-in steps are browser navigations: show the page's notice rather than a JSON error.
      if (retry && request.method === 'GET') return reply.header('retry-after', String(retry)).redirect('/?auth=busy', 302);
      if (retry) throw new Problem(429, 'rate-limited', 'Too many requests. Wait a moment and try again.', retry);
    }
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.origin !== config.publicOrigin) {
      throw new Problem(403, 'bad-origin', 'This request must come from the Poker Night page.');
    }
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    if (error instanceof Problem) {
      if (error.retryAfter) reply.header('retry-after', String(error.retryAfter));
      return reply.code(error.status).send({ error: error.message, code: error.code });
    }
    if (error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode).send({ error: 'Invalid request.', code: 'bad-request' });
    }
    request.log.error({ err: error }, 'request failed');
    return reply.code(500).send({ error: 'Something went wrong.', code: 'internal' });
  });

  const requireSession = (request: FastifyRequest): Session => {
    const session = auth.session(request.headers.cookie);
    if (!session) throw new Problem(401, 'signed-out', 'Sign in with Fluxer.');
    return session;
  };
  const limitMutation = (session: Session): void => {
    const retry = mutationLimit.take(session.user.id, now());
    if (retry) throw new Problem(429, 'rate-limited', 'Too many requests. Wait a moment and try again.', retry);
  };
  const tableId = (request: FastifyRequest<TableRoute>): string => {
    const id = request.params.tableId;
    if (!TABLE_ID.test(id)) throw new Problem(404, 'not-found', 'Table not found. Ask the host for an invite.');
    return id;
  };

  app.get('/healthz', async (_request, reply) => reply.header('cache-control', 'no-store').send({ status: 'ok' }));

  app.get('/auth/login', async (request, reply) => {
    const { location, cookie } = auth.login(parseCookies(request.headers.cookie).get(auth.flowCookie));
    return reply.header('set-cookie', cookie).header('cache-control', 'no-store').redirect(location, 302);
  });

  app.get<{ Querystring: Record<string, unknown> }>('/auth/callback', async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    const setCookies = [auth.cookieHeader(auth.flowCookie, '', 0)];
    reply.header('cache-control', 'no-store');
    try {
      const token = await auth.callback(cookies.get(auth.flowCookie), request.query, cookies.get(auth.cookie));
      setCookies.push(auth.cookieHeader(auth.cookie, token, config.sessionSeconds));
      return reply.header('set-cookie', setCookies).redirect('/', 302);
    } catch (error) {
      const code = error instanceof Problem ? error.code : 'signin-failed';
      if (!(error instanceof Problem)) request.log.error({ err: error }, 'sign-in failed');
      const state = ['expired', 'cancelled', 'bot', 'not-member', 'busy', 'fluxer-unavailable'].includes(code) ? code : 'signin-failed';
      return reply.header('set-cookie', setCookies).redirect('/?auth=' + state, 302);
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const hash = auth.logout(request.headers.cookie);
    if (hash) hub.close((connection) => connection.sessionHash === hash, 4001, 'signed-out');
    return reply.header('set-cookie', auth.cookieHeader(auth.cookie, '', 0)).code(204).send();
  });

  app.get('/api/session', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const session = requireSession(request);
    try {
      return { user: await auth.recheck(session, { failOpen: true }) };
    } catch (error) {
      if (error instanceof Problem && error.code === 'not-member') reply.header('set-cookie', auth.cookieHeader(auth.cookie, '', 0));
      throw error;
    }
  });

  app.get('/api/tables', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return { tables: tables.list(requireSession(request).user.id) };
  });

  app.get('/api/history', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    return { tables: ledger.tables(requireSession(request).user.id) };
  });

  app.get<TableRoute & { Querystring: { before?: unknown; beforeHand?: unknown } }>('/api/history/:tableId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const session = requireSession(request);
    const { before, beforeHand } = request.query;
    return ledger.view(tableId(request), session.user.id, historyCursor(before), historyCursor(beforeHand), botPosts);
  });

  app.post('/api/tables', async (request) => {
    const session = requireSession(request);
    limitMutation(session);
    const member = await auth.recheck(session, { failOpen: false });
    return tables.create(member.id);
  });

  app.get<TableRoute>('/api/tables/:tableId', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const id = tableId(request);
    const session = requireSession(request);
    tables.requireSeated(session.user.id, id);
    return play.view(id, session.user.id, hub.connected(id));
  });

  const joinSchema = {
    body: { type: 'object', required: ['token'], properties: { token: { type: 'string', maxLength: 64 } } },
  };
  app.post<TableRoute & { Body: { token: string } }>('/api/tables/:tableId/join', { schema: joinSchema }, async (request) => {
    const id = tableId(request);
    const session = requireSession(request);
    limitMutation(session);
    const member = await auth.recheck(session, { failOpen: false });
    const result = tables.requestEntry(member.id, id, request.body.token);
    if (result.notifyHost) {
      hub.broadcast(id);
      bot.notifyEntry(result.notifyHost, id, result.state.requestId!);
    }
    return result.state;
  });

  app.get<TableRoute>('/api/tables/:tableId/entry-request', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const session = requireSession(request);
    return tables.entryStatus(session.user.id, tableId(request));
  });

  app.post<TableRoute>('/api/tables/:tableId/invite', async (request) => {
    const id = tableId(request);
    const session = requireSession(request);
    limitMutation(session);
    return { invite: tables.rotateInvite(session.user.id, id) };
  });

  app.post<TableRoute>('/api/tables/:tableId/notifications', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const session = requireSession(request);
    limitMutation(session);
    return notifications.post(tableId(request), session.user.id, notificationRequest(request.body));
  });

  const handleMessage = async (connection: Connection, message: unknown): Promise<void> => {
    const reject = (code: string, error: string) => hub.send(connection, { v: PROTOCOL_VERSION, type: 'error', code, error });
    if (!isRecord(message) || message.type !== 'command') return reject('unknown-message', 'Unknown message.');
    if (message.v !== PROTOCOL_VERSION) return reject('protocol-version', 'Reload the page to get the current version.');
    const id = message.id;
    if (typeof id !== 'string' || !COMMAND_ID.test(id)) return reject('bad-command', 'Commands need an ID of 8 to 64 letters, digits, - or _.');
    const fail = (code: string, error: string) => hub.send(connection, { v: PROTOCOL_VERSION, type: 'ack', id, ok: false, code, error });
    const session = auth.sessionByHash(connection.sessionHash);
    if (!session) {
      connection.socket.close(4001, 'signed-out');
      return;
    }
    if (mutationLimit.take(session.user.id, now())) return fail('rate-limited', 'Too many actions. Wait a moment and try again.');
    try {
      await auth.recheck(session, { failOpen: true });
    } catch (error) {
      if (error instanceof Problem) return fail(error.code, error.message);
      throw error;
    }
    if (!auth.sessionByHash(connection.sessionHash)) {
      connection.socket.close(4001, 'signed-out');
      return;
    }
    const ack = play.command(session.user.id, connection.tableId, id, message.command);
    hub.send(connection, ack);
    if (ack.ok && isRecord(message.command) && message.command.type === 'leave') {
      hub.close((c) => c.tableId === connection.tableId && c.userId === session.user.id, 4004, 'left-table');
    }
  };

  await app.register(fastifyWebsocket, { options: { maxPayload: MAX_MESSAGE_BYTES } });

  app.get<TableRoute>('/ws/tables/:tableId', {
    websocket: true,
    preValidation: async (request) => {
      if (request.headers.origin !== config.publicOrigin) throw new Problem(403, 'bad-origin', 'Unexpected origin.');
      const id = tableId(request);
      const session = requireSession(request);
      tables.requireSeated(session.user.id, id);
      // A Fluxer outage must not lock seated players out of a game in progress.
      await auth.recheck(session, { failOpen: true });
    },
  }, (socket, request) => {
    const session = auth.session(request.headers.cookie);
    const id = tableId(request);
    if (!session) {
      socket.close(4001, 'signed-out');
      return;
    }
    const connection: Connection = { socket, tableId: id, userId: session.user.id, sessionHash: session.hash, alive: true };
    let queue = Promise.resolve();
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        socket.close(1003, 'Text messages only');
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        socket.close(1007, 'Invalid JSON');
        return;
      }
      queue = queue.then(() => handleMessage(connection, message)).catch((error: unknown) => {
        request.log.error({ err: error }, 'command failed');
        hub.send(connection, { v: PROTOCOL_VERSION, type: 'error', code: 'internal', error: 'Something went wrong.' });
      });
    });
    hub.add(connection);
  });

  const webRoot = fileURLToPath(new URL('../web/', import.meta.url));
  const assetRoot = join(webRoot, 'assets') + sep;
  await app.register(fastifyStatic, {
    root: webRoot,
    dotfiles: 'ignore',
    wildcard: false,
    setHeaders(res, path) {
      res.header('cache-control', path.startsWith(assetRoot) ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  for (const path of ['/tables/:tableId', '/tables/:tableId/manage', '/join/:tableId', '/history', '/history/:tableId']) {
    app.get(path, async (_request, reply) => reply.header('cache-control', 'no-cache').sendFile('index.html'));
  }

  app.addHook('onClose', async () => {
    bot.stop();
    play.stop();
    hub.stop();
  });
  hub.start();
  play.recover();

  return { app, fluxer, auth, bot, tables, play, hub };
}
