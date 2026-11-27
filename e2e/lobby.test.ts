import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { activate, artifacts, buyInAndWaitForSeat, launch, player, signIn, Stack } from './support.ts';

let stack: Stack;
let browser: Browser;
let host: Page;
let guest: Page;
let guestContext: BrowserContext;
let invite = '';

before(async () => {
  stack = new Stack();
  await stack.start();
  browser = await launch();
});
after(async () => {
  await browser?.close();
  await stack?.stop();
});

const seat = (page: Page, n: number) => page.getByRole('list', { name: 'Seats' }).getByRole('listitem').nth(n - 1);

test('signed-out and not-a-member states', async () => {
  const { page, context } = await player(browser, stack, '2002');
  await page.goto(stack.origin);
  await page.getByRole('heading', { name: 'Sign in to play' }).waitFor();
  await page.getByRole('link', { name: 'Sign in with Fluxer' }).click();
  await page.getByRole('heading', { name: 'Join the community first' }).waitFor();
  assert.ok(!(await context.cookies()).some((c) => c.name === 'pokerbot-local'));
  await context.close();
});

test('host creates a table using only the keyboard', async () => {
  ({ page: host } = await player(browser, stack, '1001'));
  await host.goto(stack.origin);
  await signIn(host);
  await host.getByRole('heading', { name: 'Your tables' }).waitFor();
  for (let i = 0; i < 10; i += 1) {
    await host.keyboard.press('Tab');
    if (await host.evaluate(() => document.activeElement?.textContent === 'Create a table')) break;
  }
  await host.keyboard.press('Enter');
  await host.waitForURL(/\/tables\/[\w-]{22}$/);
  const inviteButton = host.getByRole('button', { name: 'Invite', exact: true });
  const inviteDialog = host.getByRole('dialog', { name: 'Invite players' });
  await activate(host, inviteButton);
  await inviteDialog.getByRole('button', { name: 'Done' }).waitFor();
  invite = await host.getByLabel('Invite link').inputValue();
  assert.match(invite, /\/join\/[\w-]{22}#[\w-]{43}$/);
  await host.keyboard.press('Escape');
  await inviteDialog.waitFor({ state: 'hidden' });
  assert.ok(await inviteButton.evaluate((node) => node === document.activeElement), 'Escape returns focus to Invite');
  await seat(host, 1).getByText('Player 1').waitFor();
});

test('a guest follows the invite through sign-in and the host sees the join live', async () => {
  ({ page: guest, context: guestContext } = await player(browser, stack, '1002'));
  await guest.goto(invite);
  await guest.getByRole('heading', { name: 'Sign in to take your seat' }).waitFor();
  assert.ok(!guest.url().includes('#'), 'token is removed from the address bar');
  await guest.getByRole('link', { name: 'Sign in with Fluxer' }).click();
  await buyInAndWaitForSeat(guest, host);
  await seat(guest, 2).getByText('Player 2').waitFor();
  // Player 2's Fluxer avatar hash is `hash1`; the seat shows the distinct profile image from the media CDN.
  await seat(guest, 2).locator('.avatar img[src*="hash1.webp"]').waitFor({ state: 'attached' });
  assert.equal(await guest.evaluate(() => sessionStorage.getItem('pokerbot-invite')), null);
  await seat(host, 2).getByText('Player 2').waitFor();
  await host.screenshot({ path: join(artifacts, 'lobby-host-desktop.png'), fullPage: true });
});

test('a dropped guest reconnects to the same seat', async () => {
  const url = guest.url();
  await guest.close();
  await seat(host, 2).getByText('Offline').waitFor();
  guest = await guestContext.newPage();
  await guest.goto(url);
  await seat(guest, 2).getByText('You').waitFor();
  const [opponent, ownSeat] = await Promise.all([seat(guest, 1).boundingBox(), seat(guest, 2).boundingBox()]);
  assert.ok(opponent && ownSeat && opponent.y < ownSeat.y);
  assert.ok(Math.abs(opponent.x + opponent.width / 2 - ownSeat.x - ownSeat.width / 2) < 1, 'heads-up players sit across the felt');
  await seat(host, 2).getByText('Player 2').waitFor();
  await seat(host, 2).getByText('Offline').waitFor({ state: 'hidden' });
});

test('an app or container restart shows reconnecting, then restores both seats', async () => {
  await stack.restart();
  await host.getByText('Live').waitFor({ timeout: 15_000 });
  await guest.getByText('Live').waitFor({ timeout: 15_000 });
  await seat(host, 2).getByText('Player 2').waitFor();
  await seat(guest, 1).getByText('Player 1').waitFor();
});

test('ten seats fill, an eleventh member is told the table is full', async () => {
  for (let id = 1003; id <= 1010; id += 1) {
    const { page, context } = await player(browser, stack, String(id));
    try {
      await page.goto(invite);
      await signIn(page);
      await buyInAndWaitForSeat(page, host, id - 1000);
    } catch (error) {
      const notice = (await page.getByRole('alert').allTextContents()).join(' ');
      throw new Error(`Player ${id - 1000} could not take their seat${notice ? ': ' + notice : ''}`, { cause: error });
    } finally {
      await context.close();
    }
  }
  await seat(host, 10).getByText('Player 10').waitFor();
  const { page, context } = await player(browser, stack, '1011');
  await page.goto(invite);
  await page.getByRole('link', { name: 'Sign in with Fluxer' }).click();
  await activate(page, page.getByRole('button', { name: 'Buy in', exact: true }));
  await page.getByText('This table is full').waitFor();
  await context.close();
});

test('a replaced invite link is rejected for new players', async () => {
  await host.getByRole('button', { name: 'Invite', exact: true }).click();
  await host.getByRole('button', { name: 'Replace invite link' }).click();
  await host.getByText('New invite link created').waitFor();
  const fresh = await host.getByLabel('Invite link').inputValue();
  assert.notEqual(fresh, invite);
  await host.getByRole('dialog', { name: 'Invite players' }).getByRole('button', { name: 'Done' }).click();
  const { page, context } = await player(browser, stack, '1012');
  await page.goto(invite);
  await page.getByRole('link', { name: 'Sign in with Fluxer' }).click();
  await activate(page, page.getByRole('button', { name: 'Buy in', exact: true }));
  await page.getByText('invalid or has been replaced').waitFor();
  await context.close();
});

test('mobile width keeps every seat readable without horizontal scrolling', async () => {
  const { page, context } = await player(browser, stack, '1001', { width: 390, height: 844 });
  await page.goto(stack.origin);
  await signIn(page);
  await page.getByRole('link', { name: 'Your table', exact: true }).click();
  await seat(page, 10).getByText('Player 10').waitFor();
  for (const width of [320, 390, 681, 1280]) {
    await page.setViewportSize({ width, height: width < 400 ? 844 : 900 });
    const layoutFits = await page.getByRole('list', { name: 'Seats' }).getByRole('listitem').evaluateAll((seats) => {
      const boxes = seats.map((seat) => seat.getBoundingClientRect());
      return document.documentElement.scrollWidth <= innerWidth && boxes.every((a, i) =>
        a.left >= 0 && a.right <= innerWidth && !boxes.slice(i + 1).some((b) =>
          a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom));
    });
    assert.ok(layoutFits, `ten seats fit without overlap at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, 'lobby-host-mobile.png'), fullPage: true });
  await context.close();
});

test('a pending entry survives guest reload, a dropped poll, and invite replacement', async (t) => {
  const { page: master, context: masterContext } = await player(browser, stack, '1001');
  t.after(() => masterContext.close());
  const { page: guestPage, context: entryContext } = await player(browser, stack, '1002');
  t.after(() => entryContext.close());
  await master.goto(stack.origin);
  await signIn(master);
  await master.getByRole('button', { name: 'Create a table' }).click();
  const inviteButton = master.getByRole('button', { name: 'Invite', exact: true });
  const inviteDialog = master.getByRole('dialog', { name: 'Invite players' });
  await inviteButton.click();
  const original = await master.getByLabel('Invite link').inputValue();
  await inviteDialog.getByRole('button', { name: 'Done' }).click();

  await guestPage.goto(original);
  await signIn(guestPage);
  await guestPage.getByRole('button', { name: 'Buy in', exact: true }).click();
  const waiting = guestPage.getByText(/Buy-in request sent/);
  await waiting.waitFor();
  const joinUrl = guestPage.url();
  assert.equal(new URL(joinUrl).hash, '');

  await inviteButton.click();
  await inviteDialog.getByRole('button', { name: 'Replace invite link' }).click();
  await inviteDialog.getByText('New invite link created').waitFor();
  await inviteDialog.getByRole('button', { name: 'Done' }).click();

  await guestPage.reload();
  await waiting.waitFor({ timeout: 4_000 });
  assert.equal(await guestPage.getByRole('button', { name: 'Buy in', exact: true }).count(), 0);
  await guestPage.route('**/entry-request', (route) => route.abort(), { times: 1 });
  const retrying = guestPage.getByText('Could not reach the table server. Retrying…');
  await retrying.waitFor();
  await retrying.waitFor({ state: 'hidden' });
  await waiting.waitFor();
  await guestPage.close();

  await master.getByRole('button', { name: 'Table master', exact: true }).click();
  const requests = master.getByRole('list', { name: 'Pending entry requests' }).getByRole('listitem');
  const request = requests.filter({ hasText: 'Player 2 · ready to enter' });
  await request.waitFor();
  assert.equal(await requests.count(), 1, 'refreshing never duplicates the request');
  await request.getByRole('checkbox', { name: 'I confirm this entry and chip issuance.' }).check();
  await request.getByRole('button', { name: 'Approve' }).click();
  await request.waitFor({ state: 'hidden' });

  const returning = await entryContext.newPage();
  await returning.goto(joinUrl);
  await returning.waitForURL(/\/tables\/[\w-]{22}$/);
  await seat(returning, 2).getByText('You').waitFor();
});
