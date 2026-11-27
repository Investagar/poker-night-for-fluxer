import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { parseCard } from '../server/game/cards.ts';
import { describe, evaluate } from '../server/game/evaluate.ts';
import type { Snapshot } from '../server/protocol.ts';
import { activate, artifacts, buyInAndWaitForSeat, confirmCheckbox, focusWithKeyboard, keyboardField, launch, player, signIn, Stack } from './support.ts';

const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });

function recordSnapshots(page: Page, snapshots: Snapshot[]): void {
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      const data = JSON.parse(String(payload)) as Snapshot;
      if (data.type === 'snapshot') snapshots.push(data);
    });
  });
}

const cardName = /^[2-9TJQKA][cdhs]$/;
function cardsIn(value: unknown): string[] {
  if (typeof value === 'string') return cardName.test(value) ? [value] : [];
  if (value && typeof value === 'object') return Object.values(value).flatMap(cardsIn);
  return [];
}

const mobile = { width: 390, height: 844 };
const seat = (page: Page, n: number) => page.getByRole('list', { name: 'Seats' }).getByRole('listitem').nth(n - 1);
const yourHand = (page: Page) => page.getByRole('status', { name: 'Your hand', exact: true });

async function expectHandLabel(page: Page, frame: Snapshot): Promise<void> {
  assert.ok(frame.hand);
  const cards = [...frame.you.cards, ...frame.hand.board].map(parseCard);
  const label = describe(evaluate(cards));
  await yourHand(page).and(page.getByText(label, { exact: true })).waitFor();
}

test('keyboard-only mobile play: private cards, reconnect facing a raise, restart and showdown', async (t) => {
  const stack = new Stack();
  t.after(() => stack.stop());
  await stack.start();
  const browser = await launch();
  t.after(() => browser.close());
  const { page: host } = await player(browser, stack, '1001', mobile);
  await host.emulateMedia({ reducedMotion: 'reduce' });
  const guest = await player(browser, stack, '1002', mobile);
  const { page: third } = await player(browser, stack, '1003', mobile);
  const hostFrames: Snapshot[] = [];
  const guestFrames: Snapshot[] = [];
  const thirdFrames: Snapshot[] = [];
  recordSnapshots(host, hostFrames);
  recordSnapshots(guest.page, guestFrames);
  recordSnapshots(third, thirdFrames);

  await host.goto(stack.origin);
  await signIn(host);
  await activate(host, button(host, 'Create a table'));
  await activate(host, button(host, 'Invite'));
  const invite = await host.getByLabel('Invite link').inputValue();
  await host.keyboard.press('Escape');
  await activate(host, button(host, 'Table master'));
  await focusWithKeyboard(host, host.getByLabel('Turn seconds'));
  await host.keyboard.press('Control+a');
  await host.keyboard.type('60');
  await activate(host, button(host, 'Save settings'));
  // The host funds their own seat first so a dealer rotation can complete for the guests.
  await confirmCheckbox(host, 'I confirm this external chip issuance.');
  await activate(host, button(host, 'Give chips'));
  await host.keyboard.press('Escape');
  for (const [page, seatIndex] of [[guest.page, 2], [third, 3]] as const) {
    await page.goto(invite);
    await signIn(page);
    await buyInAndWaitForSeat(page, host, seatIndex);
  }
  // Approval issued each guest the settings' stack, so both seats are already funded.
  const dealer = host.getByLabel('Initial dealer');
  await focusWithKeyboard(host, dealer);
  await host.keyboard.press('End');
  await host.keyboard.press('Home');
  if (await dealer.inputValue() !== '1') await host.keyboard.press('ArrowDown');
  assert.equal(await dealer.inputValue(), '1');
  assert.equal(await yourHand(host).count(), 0, 'no hand label before cards are dealt');
  await activate(host, button(host, 'Start game'));
  const raise = button(host, 'Raise');
  await raise.waitFor();
  for (const [page, frames] of [[host, hostFrames], [guest.page, guestFrames], [third, thirdFrames]] as const) {
    await page.getByLabel('Your cards', { exact: true }).getByRole('listitem').nth(1).waitFor();
    await expectHandLabel(page, frames.find((f) => f.hand?.id === 1)!);
  }
  const deal = (frames: Snapshot[]) => frames.find((f) => f.hand?.id === 1)!;
  assert.equal(deal(hostFrames).settings.turnSeconds, 60);
  const thirdCards = deal(thirdFrames).you.cards;
  assert.equal(thirdCards.length, 2);
  for (const frames of [hostFrames, guestFrames, thirdFrames]) {
    const initial = deal(frames);
    assert.equal(initial.you.cards.length, 2);
    assert.deepEqual(cardsIn(initial), initial.you.cards, `seat ${initial.you.seat} sees only its own hole cards`);
  }
  assert.equal(await button(guest.page, 'Table master').count(), 0);
  assert.equal(await host.getByRole('spinbutton', { name: 'Raise to' }).count(), 0, 'the default dock has no sizing field');
  for (const viewport of [{ width: 1120, height: 840 }, { width: 320, height: 640 }, mobile]) {
    await host.setViewportSize(viewport);
    const board = host.locator('.table-board');
    const cards = host.getByLabel('Your cards', { exact: true });
    const actions = host.getByRole('group', { name: 'Betting actions' });
    const seats = host.getByRole('list', { name: 'Seats' });
    const [boardBox, cardsBox, actionsBox, seatsBox] = await Promise.all(
      [board, cards, actions, seats].map((part) => part.boundingBox()),
    );
    assert.ok(boardBox && cardsBox && actionsBox && seatsBox);
    assert.ok(boardBox.y + boardBox.height <= cardsBox.y && cardsBox.y + cardsBox.height <= actionsBox.y);
    assert.ok(seatsBox.y + seatsBox.height <= cardsBox.y, 'seats surround the board instead of becoming a second list');
    const pageSize = await host.evaluate(() => ({ scrollY, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(actionsBox.y + actionsBox.height + pageSize.scrollY <= viewport.height, `betting fits the ${viewport.width}px initial viewport`);
    assert.ok(pageSize.scrollWidth <= viewport.width, 'no horizontal overflow');
  }
  await host.screenshot({ path: join(artifacts, 'table-mobile-playing.png'), fullPage: true });

  await activate(host, raise);
  const amount = host.getByRole('spinbutton', { name: 'Raise to', exact: true });
  const confirm = button(host, 'Confirm raise');
  assert.ok(await amount.evaluate((node) => node === document.activeElement), 'opening the editor focuses the amount');
  await host.keyboard.type('19');
  assert.equal(await confirm.isEnabled(), false, 'a raise below the minimum cannot be submitted');
  await host.keyboard.press('Escape');
  await amount.waitFor({ state: 'hidden' });
  assert.ok(await raise.evaluate((node) => node === document.activeElement), 'Escape restores focus to Raise');
  await activate(host, raise);
  await activate(host, confirm);
  const call = (page: Page) => button(page, 'Call 15');
  await call(guest.page).waitFor();
  const tableUrl = guest.page.url();
  await guest.page.close();
  await seat(host, 2).getByText(/offline|away/i).waitFor();
  guest.page = await guest.context.newPage();
  recordSnapshots(guest.page, guestFrames);
  await guest.page.goto(tableUrl);
  await call(guest.page).waitFor();
  const before = guestFrames.at(-1)!;
  assert.equal(before.you.seat, 2);
  assert.equal(before.hand?.toAct, 2);
  assert.deepEqual(before.you.cards, deal(guestFrames).you.cards);
  await expectHandLabel(guest.page, before);

  await stack.restart();
  for (const page of [host, guest.page]) await page.getByText('Hand paused', { exact: true }).waitFor();
  assert.equal(await call(guest.page).count(), 0);
  const paused = guestFrames.at(-1)!;
  assert.equal(paused.hand?.deadline, null);
  assert.equal(paused.hand?.turn, before.hand?.turn);
  assert.deepEqual(paused.you.cards, before.you.cards);
  await expectHandLabel(guest.page, paused);
  await activate(host, button(host, 'Resume hand'));
  await activate(host, button(host, 'Table master'));
  await activate(host, button(host, 'Stop after hand'));
  await host.getByText(/Dealing will stop after this hand/).waitFor();
  await host.keyboard.press('Escape');
  await activate(guest.page, call(guest.page));
  await activate(third, button(third, 'Fold'));
  await yourHand(third).waitFor({ state: 'hidden' });
  for (const boardSize of [3, 4, 5]) {
    for (const [page, frames] of [[host, hostFrames], [guest.page, guestFrames]] as const) {
      await page.getByRole('list', { name: 'Board', exact: true }).getByRole('listitem').nth(boardSize - 1).waitFor();
      await expectHandLabel(page, frames.findLast((frame) => frame.hand?.board.length === boardSize)!);
    }
    if (boardSize === 5) await host.screenshot({ path: join(artifacts, 'table-mobile-hand-label.png'), fullPage: true });
    await activate(guest.page, button(guest.page, 'Check'));
    await activate(host, button(host, 'Check'));
  }
  for (const page of [host, guest.page]) {
    await yourHand(page).waitFor({ state: 'hidden' });
    await page.getByText('Hand 1 details', { exact: true }).press('Enter');
    await page.getByRole('heading', { name: 'Hand 1 result' }).waitFor();
  }
  for (const frames of [hostFrames, guestFrames]) {
    const result = frames.find((f) => f.last?.id === 1)!.last!;
    assert.equal(result.board.length, 5);
    assert.deepEqual(result.shown.map((p) => p.seat).sort(), [1, 2]);
    for (const card of thirdCards) assert.ok(!frames.some((f) => cardsIn(f).includes(card)), 'folded cards never reach another player');
  }
  await guest.page.screenshot({ path: join(artifacts, 'table-mobile-showdown.png'), fullPage: true });
});

test('ten seated clients each see only their own hole cards', { timeout: 180_000 }, async (t) => {
  const stack = new Stack();
  t.after(() => stack.stop());
  await stack.start();
  const browser = await launch();
  t.after(() => browser.close());
  const { page: host } = await player(browser, stack, '1001', mobile);
  const pages: Page[] = [host];
  const captured: Snapshot[][] = [];
  const watch = (page: Page): void => {
    const own: Snapshot[] = [];
    captured.push(own);
    recordSnapshots(page, own);
  };
  watch(host);
  await host.goto(stack.origin);
  await signIn(host);
  await activate(host, button(host, 'Create a table'));
  await activate(host, button(host, 'Invite'));
  const invite = await host.getByLabel('Invite link').inputValue();
  await host.keyboard.press('Escape');
  await activate(host, button(host, 'Table master'));
  await confirmCheckbox(host, 'I confirm this external chip issuance.');
  await activate(host, button(host, 'Give chips'));
  await host.getByText(/Ready to play/).waitFor();
  await host.keyboard.press('Escape');
  for (let id = 1002; id <= 1010; id += 1) {
    const { page } = await player(browser, stack, String(id), mobile);
    pages.push(page);
    watch(page);
    await page.goto(invite);
    await signIn(page);
    await buyInAndWaitForSeat(page, host, id - 1000);
  }
  await seat(host, 10).getByText('Player 10').waitFor();

  await focusWithKeyboard(host, host.getByLabel('Initial dealer'));
  await host.keyboard.press('Home');
  await host.keyboard.press('ArrowDown');
  await activate(host, button(host, 'Start game'));
  for (const page of pages) {
    await page.getByLabel('Your cards', { exact: true }).getByRole('listitem').nth(1).waitFor();
  }
  for (const own of captured) {
    const dealt = own.find((frame) => frame.hand?.id === 1);
    assert.ok(dealt, 'every seated client saw the opening deal');
    assert.equal(dealt.you.cards.length, 2);
    assert.equal(dealt.seats.filter(Boolean).length, 10);
    assert.deepEqual(cardsIn(dealt), dealt.you.cards, `seat ${dealt.you.seat} receives only its own hole cards`);
  }
});
