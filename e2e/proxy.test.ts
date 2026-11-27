import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createHttps, request as httpsRequest } from 'node:https';
import { connect as netConnect, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { chromium, type Browser } from 'playwright-core';
import { FakeFluxer } from '../test/fake-fluxer.ts';
import { env, people } from '../test/helpers.ts';

/**
 * Stage 4's proxy contract with the fake Fluxer standing in for the real one. The app is told its public origin is
 * HTTPS while a TLS terminator forwards requests, WSS upgrades and the browser's own Origin header. Sign-in, secure
 * cookie naming, no-store headers, origin rejection and the 25 s heartbeat all run through that hop.
 */

async function freePort(): Promise<number> {
  const server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function certificate(dir: string): { cert: string; key: string } {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', key, '-out', cert, '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
  ], { stdio: 'ignore' });
  return { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') };
}

/** Minimal terminating proxy: forwards requests and raw upgrade bytes upstream with every header intact. */
function terminator(pem: { cert: string; key: string }, upstreamPort: number) {
  const server = createHttps({ cert: pem.cert, key: pem.key });
  server.on('request', (request, response) => {
    const upstream = httpRequest({
      host: '127.0.0.1', port: upstreamPort, method: request.method, path: request.url, headers: request.headers,
    }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    upstream.on('error', () => response.destroy());
    request.pipe(upstream);
  });
  server.on('upgrade', (request, socket, head) => {
    const upstream = netConnect(upstreamPort, '127.0.0.1', () => {
      const headers = Object.entries(request.headers)
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(', ') : value}`);
      upstream.write([`${request.method} ${request.url} HTTP/1.1`, ...headers, '', ''].join('\r\n'));
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return server;
}

/** Starts the built app the way the operator's proxy would see it: HTTP behind TLS, PUBLIC_ORIGIN on HTTPS. */
async function serve(dir: string, fluxerOrigin: string, origin: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['dist/server/index.js'], {
    env: { ...env(fluxerOrigin, join(dir, 'pokerbot.sqlite'), { PUBLIC_ORIGIN: origin }), HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  for (let i = 0; i < 200; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return child;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  child.kill();
  throw new Error('the app did not become ready:\n' + log);
}

/** Kills the app and waits for it to exit, so its SQLite handles are closed before the directory goes. */
function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  const closed = once(child, 'close');
  child.kill();
  return closed.then(() => undefined);
}

/** Status of a request made outside the browser, through the terminator, with a forged Origin. */
function forgedOrigin(path: string, origin: string, originHeader: string, cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: 'localhost', port: Number(new URL(origin).port), path, method: 'POST', rejectUnauthorized: false,
      headers: { origin: originHeader, cookie, 'content-type': 'application/json', 'content-length': '2' },
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on('error', reject);
    request.end('{}');
  });
}

test('HTTPS termination keeps the secure cookie, no-store headers, origin checks, and WSS heartbeats', { timeout: 180_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pokerbot-proxy-'));
  const fake = new FakeFluxer([...people]);
  await fake.start();
  const appPort = await freePort();
  const tls = terminator(certificate(dir), appPort);
  await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
  const origin = `https://localhost:${(tls.address() as AddressInfo).port}`;
  const app = await serve(dir, fake.apiOrigin, origin, appPort);
  let browser: Browser | undefined;
  t.after(async () => {
    await browser?.close();
    await stop(app);
    await new Promise<void>((resolve) => tls.close(() => resolve()));
    await fake.stop();
    // SQLite closes its handles on exit; Windows refuses the directory while one is still open.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const sockets: string[] = [];
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await page.goto(`${fake.origin}/login/1001`);
  await page.goto(origin);
  await page.getByRole('link', { name: 'Sign in with Fluxer' }).click();
  await page.getByRole('button', { name: 'Sign out' }).waitFor();

  const cookies = await context.cookies(origin);
  const session = cookies.find((cookie) => cookie.name === '__Host-pokerbot');
  assert.ok(session, 'an HTTPS public origin names the session cookie __Host-pokerbot');
  assert.equal(session.secure, true);
  assert.equal(session.httpOnly, true);
  assert.equal(session.path, '/');
  assert.equal(cookies.some((cookie) => cookie.name === 'pokerbot-local'), false);

  const api = await page.evaluate(async () => {
    const response = await fetch('/api/session');
    return { status: response.status, cache: response.headers.get('cache-control') };
  });
  assert.equal(api.status, 200);
  assert.match(api.cache ?? '', /no-store/);

  // The app compares Origin to PUBLIC_ORIGIN exactly, so a forged one is refused behind the proxy too.
  assert.equal(await forgedOrigin('/api/tables', origin, 'https://evil.example', `${session.name}=${session.value}`), 403);

  await page.getByRole('button', { name: 'Create a table' }).click();
  await page.waitForURL(/\/tables\/[\w-]{22}$/);
  await page.getByText('Live').waitFor();
  assert.ok(sockets.some((url) => url === `${origin.replace('https:', 'wss:')}/ws/tables/${page.url().split('/').at(-1)}`),
    `the table socket upgraded over TLS (${sockets.join(', ')})`);

  // The server pings every 25 s; an idle client behind the terminator must stay live instead of reconnecting.
  await sleep(26_000);
  assert.equal(await page.getByText('Reconnecting…').count(), 0);
  await page.getByText('Live').waitFor();
});
