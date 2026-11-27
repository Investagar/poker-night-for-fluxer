import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Auth } from '../server/auth.ts';
import { loadConfig } from '../server/config.ts';
import { Fluxer } from '../server/fluxer.ts';
import { clientAddress } from '../server/limits.ts';
import { parseProxies } from '../server/config.ts';
import { scalar } from '../server/db.ts';
import { callback, cookieValue, env, harness, type Harness, request, signIn } from './helpers.ts';

let h: Harness;
before(async () => {
  h = await harness();
});
after(() => h.close());

test('login redirects to Fluxer with identify, S256 PKCE, state, and the fixed callback', async () => {
  const response = await h.app.inject({ method: 'GET', url: '/auth/login?redirect=https://evil.example/' });
  assert.equal(response.statusCode, 302);
  const location = new URL(response.headers.location as string);
  assert.equal(location.origin + location.pathname, h.fake.origin + '/oauth2/authorize');
  assert.equal(location.searchParams.get('scope'), 'identify');
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(location.searchParams.get('redirect_uri'), 'http://localhost:5173/auth/callback');
  assert.match(location.searchParams.get('state')!, /^[\w-]{43}$/);
  const cookie = ([] as string[]).concat(response.headers['set-cookie'] as string).join();
  assert.match(cookie, /pokerbot-local-login=.*HttpOnly; SameSite=Lax/);
});

test('a full sign-in creates a hashed, persistent session and drops OAuth tokens', async () => {
  const { response } = await callback(h, '1001');
  const result = await response();
  assert.equal(result.statusCode, 302);
  assert.equal(result.headers.location, '/');
  const token = cookieValue(result.headers['set-cookie'], 'pokerbot-local')!;
  assert.ok(token);
  assert.match(([] as string[]).concat(result.headers['set-cookie'] as string).join(), /pokerbot-local=[^;]+; Max-Age=28800; Path=\/; HttpOnly; SameSite=Lax/);
  const session = await request(h, 'GET', '/api/session', `pokerbot-local=${token}`);
  assert.deepEqual(session.json(), { user: { id: '1001', name: 'Player 1', avatar: null } });

  const hashes = h.db.prepare('SELECT id_hash FROM sessions').all().map((row) => row.id_hash);
  assert.ok(hashes.length >= 1 && !hashes.includes(token));
  const dump = JSON.stringify(['users', 'sessions', 'tables', 'invites', 'seats'].map((t) => h.db.prepare(`SELECT * FROM ${t}`).all()));
  assert.ok(h.fake.tokens.size > 0);
  for (const accessToken of h.fake.tokens.keys()) assert.ok(!dump.includes(accessToken));
});

test('the secure cookie is __Host- prefixed and Secure', () => {
  const config = loadConfig(env('https://chat.example.com', ':memory:', { PUBLIC_ORIGIN: 'https://poker.example.com' }));
  const auth = new Auth(config, h.db, new Fluxer(config), Date.now);
  assert.equal(auth.cookie, '__Host-pokerbot');
  assert.equal(auth.cookieHeader(auth.cookie, 'x', 60), '__Host-pokerbot=x; Max-Age=60; Path=/; HttpOnly; SameSite=Lax; Secure');
});

test('mismatched state is rejected without a session', async () => {
  const { flow, target } = await callback(h, '1002');
  target.searchParams.set('state', 'A'.repeat(43));
  const result = await h.app.inject({ method: 'GET', url: target.pathname + target.search, headers: { cookie: `pokerbot-local-login=${flow}` } });
  assert.equal(result.headers.location, '/?auth=expired');
  assert.equal(cookieValue(result.headers['set-cookie'], 'pokerbot-local'), undefined);
  const missing = await h.app.inject({ method: 'GET', url: target.pathname + target.search });
  assert.equal(missing.headers.location, '/?auth=expired');
});

test('expired state is rejected', async () => {
  const { response } = await callback(h, '1002');
  h.clock.now += 301_000;
  try {
    const result = await response();
    assert.equal(result.headers.location, '/?auth=expired');
    assert.equal(cookieValue(result.headers['set-cookie'], 'pokerbot-local'), undefined);
  } finally {
    h.clock.now -= 301_000;
  }
});

test('a state can only be used once', async () => {
  const { response } = await callback(h, '1002');
  assert.equal((await response()).headers.location, '/');
  const replay = await response();
  assert.equal(replay.headers.location, '/?auth=expired');
  assert.equal(cookieValue(replay.headers['set-cookie'], 'pokerbot-local'), undefined);
});

test('bot, system, and non-member accounts get no session', async () => {
  h.fake.users.set('2003', { id: '2003', username: 'system', system: true });
  for (const [id, state] of [['2001', 'bot'], ['2003', 'bot'], ['2002', 'not-member']]) {
    const result = await (await callback(h, id)).response();
    assert.equal(result.headers.location, `/?auth=${state}`, id);
    assert.equal(cookieValue(result.headers['set-cookie'], 'pokerbot-local'), undefined);
  }
});

test('a Fluxer outage blocks sign-in but keeps an existing session usable', async () => {
  const cookie = await signIn(h, '1003');
  h.clock.now += 31_000;
  h.fake.outage = true;
  try {
    assert.equal((await (await callback(h, '1004')).response()).headers.location, '/?auth=fluxer-unavailable');
    const session = await request(h, 'GET', '/api/session', cookie);
    assert.equal(session.statusCode, 200);
  } finally {
    h.fake.outage = false;
  }
});

test('a confirmed non-member loses every session', async () => {
  const cookie = await signIn(h, '1005');
  h.fake.users.get('1005')!.member = false;
  h.clock.now += 31_000;
  try {
    const session = await request(h, 'GET', '/api/session', cookie);
    assert.equal(session.statusCode, 403);
    assert.equal(session.json().code, 'not-member');
    assert.equal(scalar(h.db, 'SELECT count(*) FROM sessions WHERE user_id = ?', '1005'), 0);
  } finally {
    h.fake.users.get('1005')!.member = true;
  }
});

test('logout requires the page origin and deletes the session', async () => {
  const cookie = await signIn(h, '1006');
  const foreign = await h.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(foreign.statusCode, 403);
  const noOrigin = await h.app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie } });
  assert.equal(noOrigin.statusCode, 403);
  assert.equal((await request(h, 'POST', '/auth/logout', cookie)).statusCode, 204);
  assert.equal((await request(h, 'GET', '/api/session', cookie)).statusCode, 401);
});

test('sessions expire', async () => {
  const cookie = await signIn(h, '1007');
  h.clock.now += 28_801_000;
  try {
    assert.equal((await request(h, 'GET', '/api/session', cookie)).statusCode, 401);
  } finally {
    h.clock.now -= 28_801_000;
  }
});

test('auth routes are rate limited per client address with Retry-After', async () => {
  const limited = await harness();
  try {
    const login = (remoteAddress: string) => limited.app.inject({ method: 'GET', url: '/auth/login', remoteAddress });
    for (let i = 0; i < 30; i += 1) assert.match(String((await login('203.0.113.9')).headers.location), /oauth2\/authorize/);
    const blocked = await login('203.0.113.9');
    assert.equal(blocked.headers.location, '/?auth=busy', 'navigations land on the page notice');
    assert.ok(Number(blocked.headers['retry-after']) >= 1);
    const logout = await limited.app.inject({ method: 'POST', url: '/auth/logout', remoteAddress: '203.0.113.9', headers: { origin: 'http://localhost:5173' } });
    assert.equal(logout.statusCode, 429);
    assert.ok(Number(logout.headers['retry-after']) >= 1);
    assert.match(String((await login('203.0.113.10')).headers.location), /oauth2\/authorize/);
  } finally {
    await limited.close();
  }
});

test('forwarded addresses are trusted only from configured proxies; IPv6 is grouped by /64', () => {
  const proxies = parseProxies('10.0.0.2');
  assert.equal(clientAddress('10.0.0.2', '198.51.100.7', proxies), '198.51.100.7');
  assert.equal(clientAddress('10.0.0.2', '198.51.100.7, 10.0.0.2', proxies), '198.51.100.7');
  assert.equal(clientAddress('203.0.113.1', '198.51.100.7', proxies), '203.0.113.1');
  assert.equal(clientAddress('::ffff:10.0.0.2', '198.51.100.8', proxies), '198.51.100.8');
  assert.equal(clientAddress('10.0.0.2', 'garbage', proxies), '10.0.0.2');
  assert.equal(clientAddress('2001:db8:1:2:aaaa::1', undefined, proxies), '2001:db8:1:2::/64');
  assert.equal(clientAddress('2001:db8:1:2:bbbb::9', undefined, proxies), '2001:db8:1:2::/64');
});
