import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Browser } from 'playwright-core';
import { artifacts, launch, player, signIn, Stack } from './support.ts';

let stack: Stack;
let browser: Browser;

before(async () => {
  stack = new Stack();
  await stack.start();
  browser = await launch();
});

after(async () => {
  await browser?.close();
  await stack?.stop();
});

test('healthz answers ok and static assets include license notices', async () => {
  const health = await (await fetch(`${stack.origin}/healthz`)).json();
  assert.equal(health.status, 'ok');

  const response = await fetch(stack.origin);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const html = await response.text();
  assert.match(html, /<!doctype html>/i);
  const manifestMatch = /<script[^>]+src="([^"]+)"/.exec(html);
  assert.ok(manifestMatch, 'index.html references a bundled script');
  const script = await fetch(stack.origin + manifestMatch[1]);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('cache-control') ?? '', /immutable/);
  assert.match(await script.text(), /The above copyright notice and this permission notice/);
  const notices = await fetch(`${stack.origin}/third-party-licenses.md`);
  assert.equal(notices.status, 200);
  assert.match(await notices.text(), /react-dom.*\(MIT\)/i);
});

test('container is healthy with a read-only root and writable /data owned by its non-root user', {
  skip: process.env.E2E_TARGET !== 'container',
}, async () => {
  let health = stack.health();
  for (let i = 0; health === 'starting' && i < 24; i += 1) {
    await sleep(1000);
    health = stack.health();
  }
  assert.equal(health, 'healthy');
  const { uid, uidNow } = JSON.parse(stack.exec(`
    const fs = require('node:fs');
    const probe = fs.mkdtempSync('/data/.smoke-');
    fs.rmdirSync(probe);
    console.log(JSON.stringify({ uid: fs.statSync('/data').uid, uidNow: process.getuid() }));
  `)) as { uid: number; uidNow: number };
  assert.notEqual(uidNow, 0, 'container must not run as root');
  assert.match(stack.exec(`
    const { readFileSync } = require('node:fs');
    console.log(readFileSync('/app/LICENSE', 'utf8') + readFileSync('/app/third-party-notices.md', 'utf8'));
  `), /MIT License[\s\S]*abstract-logging/);
  assert.equal(uid, uidNow, '/data must be owned by the runtime uid');
  const { imageId, readOnlyRoot } = stack.runtimeInfo();
  assert.equal(readOnlyRoot, true);
  assert.match(imageId, /^(?:sha256:)?[a-f0-9]{64}$/);
  if (process.env.E2E_IMAGE_ID_FILE) writeFileSync(process.env.E2E_IMAGE_ID_FILE, `${imageId}\n`);
});

test('two isolated fake-auth browser sessions create and join, and a restart restores both seats', async () => {
  const host = await player(browser, stack, '1001');
  await host.page.goto(stack.origin);
  await signIn(host.page);
  await host.page.getByRole('heading', { name: 'Your tables' }).waitFor();
  await host.page.getByRole('button', { name: 'Create a table' }).click();
  await host.page.waitForURL(/\/tables\/[\w-]{22}$/);
  const tableId = host.page.url().split('/').at(-1)!;
  await host.page.getByRole('button', { name: 'Invite', exact: true }).click();
  const invite = await host.page.getByLabel('Invite link').inputValue();
  assert.match(invite, /\/join\/[\w-]{22}#[\w-]{43}$/);
  await host.page.getByRole('dialog', { name: 'Invite players' }).getByRole('button', { name: 'Done' }).click();
  await host.page.getByRole('list', { name: 'Seats' }).getByRole('listitem').nth(0).getByText('Player 1').waitFor();

  const guest = await player(browser, stack, '1002');
  await guest.page.goto(invite);
  await guest.page.getByRole('link', { name: 'Sign in with Fluxer' }).click();
  await guest.page.getByRole('button', { name: 'Buy in', exact: true }).click();
  await guest.page.getByText(/Buy-in request sent/).waitFor();
  // Approve through the Table master; the guest then lands seated on the table.
  await host.page.getByRole('button', { name: 'Table master', exact: true }).click();
  const request = host.page.getByRole('list', { name: 'Pending entry requests' }).getByRole('listitem').first();
  await request.getByText(/ready to enter/).waitFor();
  await request.getByRole('checkbox', { name: 'I confirm this entry and chip issuance.' }).check();
  await request.getByRole('button', { name: 'Approve' }).click();
  await guest.page.waitForURL(/\/tables\/[\w-]{22}$/);
  await guest.page.getByRole('list', { name: 'Seats' }).getByRole('listitem').nth(1).getByText('Player 2').waitFor();
  await host.page.getByRole('list', { name: 'Seats' }).getByRole('listitem').nth(1).getByText('Player 2').waitFor();

  await stack.restart();
  await host.page.getByText('Live').waitFor({ timeout: 15_000 });
  await guest.page.getByText('Live').waitFor({ timeout: 15_000 });
  await host.page.getByRole('list', { name: 'Seats' }).getByRole('listitem').nth(1).getByText('Player 2').waitFor();
  await guest.page.getByRole('list', { name: 'Seats' }).getByRole('listitem').nth(1).getByText('You').waitFor();
  await host.page.screenshot({ path: join(artifacts, 'smoke-after-restart.png'), fullPage: true });

  // A bot-managed table link opens the Table master dialog directly for the host.
  await host.page.goto(`${stack.origin}/tables/${tableId}/manage`);
  await host.page.getByRole('dialog', { name: 'Table master' }).waitFor();
  assert.ok(await host.page.getByRole('heading', { name: 'Table settings' }).isVisible());
  await host.page.keyboard.press('Escape');
  await host.context.close();
  await guest.context.close();
});
