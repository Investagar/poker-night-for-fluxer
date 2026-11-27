import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { buildApp, type PokerApp } from '../server/app.ts';
import { loadConfig } from '../server/config.ts';
import { openDatabase } from '../server/db.ts';
import type { Card } from '../server/game/cards.ts';
import { BOT_TOKEN, CLIENT_ID, CLIENT_SECRET, FakeFluxer, type FakeUser, GUILD_ID } from './fake-fluxer.ts';

export const ORIGIN = 'http://localhost:5173';

export const people: FakeUser[] = Array.from({ length: 12 }, (_, i) => ({
  id: String(1001 + i),
  username: `player${i + 1}`,
  global_name: `Player ${i + 1}`,
  avatar: i % 2 ? `hash${i}` : null,
}));

export function env(fluxerOrigin: string, databasePath: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PUBLIC_ORIGIN: ORIGIN,
    FLUXER_ORIGIN: fluxerOrigin,
    FLUXER_GUILD_ID: GUILD_ID,
    FLUXER_BOT_TOKEN: BOT_TOKEN,
    FLUXER_CLIENT_ID: CLIENT_ID,
    FLUXER_CLIENT_SECRET: CLIENT_SECRET,
    DATABASE_PATH: databasePath,
    ALLOW_INSECURE_LOCAL: 'true',
    ...extra,
  };
}

export interface Harness extends PokerApp {
  fake: FakeFluxer;
  db: DatabaseSync;
  dbPath: string;
  clock: { now: number };
  /** Closes the app and database, then starts a fresh process-equivalent on the same database file. */
  restart(): Promise<Harness>;
  close(): Promise<void>;
}

interface HarnessOptions {
  fake?: FakeFluxer;
  dir?: string;
  clock?: { now: number };
  env?: Record<string, string>;
  deck?: () => Card[];
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const fake = options.fake ?? new FakeFluxer([...people, { id: '2001', username: 'robot', bot: true }, { id: '2002', username: 'outsider', member: false }]);
  if (!fake.origin) await fake.start();
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'pokerbot-test-'));
  const dbPath = join(dir, 'pokerbot.sqlite');
  const clock = options.clock ?? { now: Date.now() };
  const config = loadConfig(env(fake.origin, dbPath, options.env));
  const db = openDatabase(dbPath);
  const built = await buildApp({ config, db, now: () => clock.now, logger: false, deck: options.deck });
  await built.fluxer.discover();
  const h: Harness = {
    ...built,
    fake,
    db,
    dbPath,
    clock,
    async restart() {
      await built.app.close();
      db.close();
      return harness({ ...options, fake, dir, clock });
    },
    async close() {
      await built.app.close();
      db.close();
      await fake.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

export function cookieValue(header: string | string[] | number | undefined, name: string): string | undefined {
  for (const cookie of Array.isArray(header) ? header : typeof header === 'string' ? [header] : []) {
    const [pair] = cookie.split(';');
    const index = pair.indexOf('=');
    if (pair.slice(0, index) === name) return pair.slice(index + 1);
  }
  return undefined;
}

let addresses = 0;

/** Starts sign-in, completes the fake authorize step as `userId`, and returns the callback response. */
export async function callback(h: Harness, userId: string) {
  // Each simulated browser gets its own address so the per-IP auth limit does not couple unrelated tests.
  addresses += 1;
  const remoteAddress = `198.18.${addresses >> 8}.${addresses & 255}`;
  const login = await h.app.inject({ method: 'GET', url: '/auth/login', remoteAddress });
  const flow = cookieValue(login.headers['set-cookie'], h.auth.flowCookie)!;
  const authorize = await fetch(login.headers.location as string, { redirect: 'manual', headers: { cookie: `fake_user=${userId}` } });
  const target = new URL(authorize.headers.get('location')!);
  return {
    flow,
    target,
    response: () => h.app.inject({ method: 'GET', url: target.pathname + target.search, remoteAddress, headers: { cookie: `${h.auth.flowCookie}=${flow}` } }),
  };
}

export async function signIn(h: Harness, userId: string): Promise<string> {
  const response = await (await callback(h, userId)).response();
  const token = cookieValue(response.headers['set-cookie'], h.auth.cookie);
  if (!token) throw new Error(`sign-in failed: ${response.headers.location}`);
  return `${h.auth.cookie}=${token}`;
}

export function request(h: Harness, method: 'GET' | 'POST', url: string, cookie?: string, body?: object) {
  return h.app.inject({
    method,
    url,
    headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    payload: body ? JSON.stringify(body) : undefined,
  });
}

let admissions = 0;

/** Failure of one admission step; `.code` carries the server's rejection code (or join HTTP code). */
export class AdmitError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * The entry-request flow: POST join only creates a waiting request; the table master's buyin approval with the
 * requestId seats the guest and issues the stack in one command. Returns the granted seat; the ack's failure code
 * surfaces as an AdmitError so tests can assert rejections without losing the code.
 */
export async function admitGuest(h: Harness, tableId: string, guestId: string, guestCookie: string, token: string,
  { chips = 1000, amountMinor = 0, currency = 'USD' }: { chips?: number; amountMinor?: number; currency?: string } = {}): Promise<number> {
  const joined = await request(h, 'POST', `/api/tables/${tableId}/join`, guestCookie, { token });
  if (joined.statusCode !== 200) throw new AdmitError(joined.json().code ?? 'join-failed', `join failed: ${joined.body}`);
  const state = joined.json() as { status: string; requestId?: number };
  if (state.status !== 'waiting' || state.requestId === undefined) {
    if (state.status === 'seated') return h.tables.seatOf(tableId, guestId)!;
    throw new AdmitError(state.status === 'declined' ? 'declined' : 'join-failed', `join did not wait: ${joined.body}`);
  }
  const hostId = String(h.db.prepare('SELECT host_id FROM tables WHERE id = ?').get(tableId)?.host_id);
  const hostCookie = await signIn(h, hostId);
  const ack = await h.play.command(hostId, tableId, `admit-${(admissions += 1)}`,
    { type: 'buyin', userId: guestId, amountMinor, currency, chips, requestId: state.requestId });
  if (!ack.ok) throw new AdmitError(ack.code, `approval failed: ${ack.code}: ${ack.error}`);
  return h.tables.seatOf(tableId, guestId)!;
}

export async function listen(h: Harness): Promise<number> {
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  return (h.app.server.address() as AddressInfo).port;
}

export interface Client {
  ws: WebSocket;
  messages: Record<string, any>[];
  next(predicate?: (message: Record<string, any>) => boolean, timeoutMs?: number): Promise<Record<string, any>>;
  closed: Promise<{ code: number; reason: string }>;
}

/** Status of a raw WebSocket upgrade attempt, for asserting why a handshake was refused. */
export function upgradeStatus(port: number, tableId: string, headers: Record<string, string>): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const req = httpRequest({
    host: '127.0.0.1',
    port,
    path: `/ws/tables/${tableId}`,
    headers: {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-version': '13',
      'sec-websocket-key': Buffer.from('the sample nonce').toString('base64'),
      ...headers,
    },
  });
  req.on('upgrade', (response, socket) => {
    socket.destroy();
    resolve(response.statusCode ?? 0);
  });
  req.on('response', (response) => {
    response.resume();
    resolve(response.statusCode ?? 0);
  });
  req.on('error', reject);
  req.end();
  return promise;
}

type Message = Record<string, any>;

export function connect(port: number, tableId: string, headers: Record<string, string>): Promise<Client> {
  const opened = Promise.withResolvers<Client>();
  const closed = Promise.withResolvers<{ code: number; reason: string }>();
  // Node's WebSocket accepts a non-standard `{ headers }` options object that the DOM typings do not describe.
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/tables/${tableId}`, { headers } as unknown as string[]);
  const messages: Message[] = [];
  const waiters: { predicate: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  let cursor = 0;
  ws.addEventListener('close', (e) => closed.resolve({ code: e.code, reason: e.reason }));
  ws.addEventListener('error', () => opened.reject(new Error('socket rejected')));
  ws.addEventListener('message', (event) => {
    const message: Message = JSON.parse(String(event.data));
    messages.push(message);
    const waiter = waiters.find((w) => w.predicate(message));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      cursor = messages.length;
      waiter.resolve(message);
    }
  });
  ws.addEventListener('open', () => opened.resolve({
    ws,
    messages,
    closed: closed.promise,
    next(predicate = () => true, timeoutMs = 3000) {
      const index = messages.findIndex((m, i) => i >= cursor && predicate(m));
      if (index >= 0) {
        cursor = index + 1;
        return Promise.resolve(messages[index]);
      }
      const { promise, resolve, reject } = Promise.withResolvers<Message>();
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), timeoutMs);
      waiters.push({ predicate, resolve: (m) => { clearTimeout(timer); resolve(m); } });
      return promise;
    },
  }));
  return opened.promise;
}
