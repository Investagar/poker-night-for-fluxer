import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { FluxerGateway } from '../server/gateway.ts';

interface Payload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

/** Reads one field after `in`-narrowing, so every access is checked at runtime. */
function field(payload: Payload, name: string): unknown {
  const { d } = payload;
  return d !== null && typeof d === 'object' && name in d ? (d as Record<string, unknown>)[name] : undefined;
}

interface GatewayServer {
  url: string;
  /** Resolves to the next accepted connection; the wait expires if the client stops reconnecting. */
  nextConnection(timeoutMs?: number): Promise<Connection>;
  close(): Promise<void>;
}

interface Connection {
  /** Resolves to the next client payload matching the predicate. */
  next(predicate?: (payload: Payload) => boolean, timeoutMs?: number): Promise<Payload>;
  send(payload: Payload): void;
  close(code: number, reason: string): Promise<void>;
  /** Resolves when the client closes this socket, with its close code. */
  closed(): Promise<number>;
  /** Stops the automatic heartbeat ACKs, simulating a dead link. */
  stopAcks: boolean;
}

const HELLO_MS = 80;

function gatewayServer(): Promise<GatewayServer> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  const accepted: Connection[] = [];
  const pending: ((connection: Connection) => void)[] = [];
  const register = (connection: Connection): void => {
    const waiter = pending.shift();
    if (waiter) waiter(connection);
    else accepted.push(connection);
  };

  wss.on('connection', (socket) => {
    const waiters: { predicate: (p: Payload) => boolean; resolve: (p: Payload) => void }[] = [];
    const received: Payload[] = [];
    let cursor = 0;
    const closed = Promise.withResolvers<number>();
    const connection: Connection = {
      stopAcks: false,
      next(predicate = () => true, timeoutMs = 5_000): Promise<Payload> {
        const index = received.findIndex((p, i) => i >= cursor && predicate(p));
        if (index >= 0) {
          cursor = index + 1;
          return Promise.resolve(received[index]);
        }
        const { promise, resolve, reject } = Promise.withResolvers<Payload>();
        const waiter = { predicate, resolve: (p: Payload) => { clearTimeout(timer); resolve(p); } };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error('timed out waiting for gateway payload'));
        }, timeoutMs);
        waiters.push(waiter);
        return promise;
      },
      send(payload: Payload): void {
        socket.send(JSON.stringify(payload));
      },
      close(code: number, reason: string): Promise<void> {
        socket.close(code, reason);
        return once(socket, 'close').then(() => undefined);
      },
      closed: () => closed.promise,
    };
    socket.on('message', (chunk: Buffer) => {
      const payload = JSON.parse(chunk.toString('utf8')) as Payload;
      received.push(payload);
      // A live gateway ACKs every client heartbeat so the keepalive never interferes with
      // what a test asserts; tests that need a missed ACK set `stopAcks` first.
      if (payload.op === 1 && !connection.stopAcks) socket.send(JSON.stringify({ op: 11 }));
      const waiter = waiters.find((w) => w.predicate(payload));
      if (waiter) {
        waiters.splice(waiters.indexOf(waiter), 1);
        cursor = received.length;
        waiter.resolve(payload);
      }
    });
    socket.on('close', (code: number) => closed.resolve(code));
    socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: HELLO_MS } }));
    register(connection);
  });

  const { promise: listening, resolve: resolveListening } = Promise.withResolvers<void>();
  wss.on('listening', () => resolveListening());
  return listening.then(() => {
    const { port } = wss.address() as AddressInfo;
    return {
      url: `ws://127.0.0.1:${port}`,
      nextConnection(timeoutMs = 5_000): Promise<Connection> {
        if (accepted.length) return Promise.resolve(accepted.shift()!);
        const { promise, resolve, reject } = Promise.withResolvers<Connection>();
        const waiter = (connection: Connection) => { clearTimeout(timer); resolve(connection); };
        const timer = setTimeout(() => {
          pending.splice(pending.indexOf(waiter), 1);
          reject(new Error('timed out waiting for a gateway connection'));
        }, timeoutMs);
        pending.push(waiter);
        return promise;
      },
      close: () => new Promise<void>((resolve) => {
        for (const socket of wss.clients) socket.terminate();
        wss.close(() => resolve());
      }),
    };
  });
}

/** Delivers gateway dispatches to an awaited queue instead of wall-clock polling. */
function dispatchQueue() {
  const seen: unknown[] = [];
  const waiters: { predicate: (data: unknown) => boolean; settle: (data: unknown) => void }[] = [];
  let cursor = 0;
  return {
    seen,
    push: (data: unknown): void => {
      seen.push(data);
      const index = waiters.findIndex((waiter) => waiter.predicate(data));
      if (index < 0) return;
      const [waiter] = waiters.splice(index, 1);
      waiter.settle(data);
    },
    /** Resolves on the next matching dispatch; a dispatch that does not match never cancels a waiter. */
    next(predicate: (data: unknown) => boolean, timeoutMs = 2_000): Promise<unknown> {
      const index = seen.findIndex((data, i) => i >= cursor && predicate(data));
      if (index >= 0) {
        cursor = index + 1;
        return Promise.resolve(seen[index]);
      }
      const { promise, resolve, reject } = Promise.withResolvers<unknown>();
      const waiter = {
        predicate,
        settle: (data: unknown): void => {
          clearTimeout(timer);
          cursor = seen.length;
          resolve(data);
        },
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error('timed out waiting for a dispatch'));
      }, timeoutMs);
      waiters.push(waiter);
      return promise;
    },
  };
}

test('gateway identifies, heartbeats, and resumes after a server-ordered reconnect', { timeout: 15_000 }, async (t) => {
  const server = await gatewayServer();
  const dispatches = dispatchQueue();
  let downCalls = 0;
  const gw = new FluxerGateway(`${server.url}/gateway?v=0&keep=me`, 'bot-token-123',
    dispatches.push, () => { downCalls += 1; });
  // Registered before any assertion so a failure still releases the socket and the listening server.
  t.after(async () => {
    gw.stop();
    await server.close();
  });

  gw.start();
  const conn = await server.nextConnection();

  const identify = await conn.next((p) => p.op === 2);
  assert.equal(field(identify, 'token'), 'bot-token-123', 'the raw token is sent without a prefix');
  assert.equal(typeof field(identify, 'properties'), 'object');

  conn.send({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess-1' } });
  conn.send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'm1', content: '!pokernight' } });
  const first = await dispatches.next((d) => field({ op: 0, d }, 'id') === 'm1');
  assert.deepEqual(first, { id: 'm1', content: '!pokernight' });

  const heartbeat = await conn.next((p) => p.op === 1);
  assert.equal(heartbeat.d, 2, 'the heartbeat carries the last processed dispatch sequence');

  // A drain close keeps the session, so the client resumes inside the 60,000 ms replay window.
  await conn.close(4000, 'Session drain requested; reconnect to continue');
  const conn2 = await server.nextConnection();
  const resume = await conn2.next((p) => p.op === 6);
  assert.equal(field(resume, 'token'), 'bot-token-123');
  assert.equal(field(resume, 'session_id'), 'sess-1');
  assert.equal(field(resume, 'seq'), 2);

  conn2.send({ op: 0, t: 'MESSAGE_CREATE', s: 3, d: { id: 'm2' } });
  // RESUMED repeats the last sequence this client already processed; it still ends the handshake.
  conn2.send({ op: 0, t: 'RESUMED', s: 3 });
  await dispatches.next((d) => field({ op: 0, d }, 'id') === 'm2');
  assert.deepEqual(dispatches.seen.map((dispatch) => (dispatch as { id?: unknown }).id), ['m1', 'm2'],
    'replay delivers each event once');
  assert.equal(downCalls, 0);

  // A beat may already be in flight from before m2, so wait for the one carrying the new sequence.
  const heartbeat2 = await conn2.next((p) => p.op === 1 && p.d === 3);
  assert.equal(heartbeat2.d, 3, 'the sequence survives the resume');

  gw.stop();
  assert.equal(await conn2.closed(), 1000);
});

test('gateway re-identifies on the same socket after Invalid Session and stops on a fatal close', { timeout: 15_000 }, async (t) => {
  const server = await gatewayServer();
  const dispatches = dispatchQueue();
  let downCalls = 0;
  const down = Promise.withResolvers<void>();
  const gw = new FluxerGateway(server.url, 'bot-token-123', dispatches.push, () => {
    downCalls += 1;
    down.resolve();
  });
  t.after(async () => {
    gw.stop();
    await server.close();
  });

  gw.start();
  const conn = await server.nextConnection();
  await conn.next((p) => p.op === 2, 2_000);
  conn.send({ op: 0, t: 'READY', s: 10, d: { session_id: 'old' } });
  conn.send({ op: 0, t: 'MESSAGE_CREATE', s: 11, d: { id: 'before-invalidation' } });
  await dispatches.next((d) => field({ op: 0, d }, 'id') === 'before-invalidation');

  await conn.close(4000, 'Reconnect');
  const replacement = await server.nextConnection();
  const resume = await replacement.next((p) => p.op === 6);
  assert.equal(field(resume, 'seq'), 11);
  replacement.send({ op: 9, d: false });
  const reidentify = await replacement.next((p) => p.op === 2);
  assert.equal(field(reidentify, 'token'), 'bot-token-123');

  replacement.send({ op: 0, t: 'READY', s: 1, d: { session_id: 'new' } });
  replacement.send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'after-invalidation' } });
  await dispatches.next((d) => field({ op: 0, d }, 'id') === 'after-invalidation');

  // An invalid token cannot be fixed by retrying; the client must not reconnect.
  await replacement.close(4004, 'Invalid token');
  await down.promise;
  await assert.rejects(() => server.nextConnection(300), /timed out/);
  assert.equal(downCalls, 1, 'a fatal close reports the connection down exactly once');
});

test('gateway resumes from its last sequence after a heartbeat timeout', { timeout: 15_000 }, async (t) => {
  const server = await gatewayServer();
  const dispatches = dispatchQueue();
  const gw = new FluxerGateway(server.url, 'bot-token-123', dispatches.push, () => {});
  t.after(async () => {
    gw.stop();
    await server.close();
  });

  gw.start();
  const conn = await server.nextConnection();
  await conn.next((p) => p.op === 2, 2_000);
  conn.send({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess-3' } });
  conn.send({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: 'm1' } });
  await dispatches.next((d) => field({ op: 0, d }, 'id') === 'm1');

  const firstBeat = await conn.next((p) => p.op === 1);
  assert.equal(firstBeat.d, 2, 'the beat carries the sequence from before the reconnect');
  conn.stopAcks = true; // a dead link stops answering: the next beat gets no ACK
  assert.equal(await conn.closed(), 4009, 'the client closes with the documented heartbeat-timeout code');

  const conn2 = await server.nextConnection();
  const resume = await conn2.next((p) => p.op === 6);
  assert.equal(field(resume, 'seq'), 2, 'the resume offers the last processed sequence');

  conn2.send({ op: 0, t: 'RESUMED', s: 2 });
});
