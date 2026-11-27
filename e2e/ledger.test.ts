import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright-core';
import { CHANNEL_ID } from '../test/fake-fluxer.ts';
import { activate, artifacts, buyInAndWaitForSeat, confirmCheckbox, focusWithKeyboard, keyboardField, launch, player, Stack } from './support.ts';

const button = (page: Page, name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
const link = (page: Page, name: string) => page.getByRole('link', { name, exact: true });
const mobile = { width: 390, height: 844 };

async function settle(page: Page, amount: string) {
  await keyboardField(page, 'Cash-out amount (minor units)', amount);
  await focusWithKeyboard(page, page.getByRole('checkbox', { name: 'I confirm this external cash-out.' }));
  await page.keyboard.press('Space');
  await activate(page, button(page, 'Record cash-out'));
}

test('host grants per-seat values and repairs a cash typo through audited corrections', async (t) => {
  const stack = new Stack();
  await stack.start();
  t.after(() => stack.stop());
  const browser = await launch();
  t.after(() => browser.close());
  const { page: host } = await player(browser, stack, '1001', mobile);
  const { page: guest } = await player(browser, stack, '1002', mobile);
  await host.goto(stack.origin);
  await activate(host, link(host, 'Sign in with Fluxer'));
  await activate(host, button(host, 'Create a table'));
  await activate(host, button(host, 'Table master'));
  // Host funds their own seat first: the zero-stack dropdown includes the table master.
  const giveTarget = host.getByLabel('Player', { exact: true });
  await focusWithKeyboard(host, giveTarget);
  await host.keyboard.press('End');
  await confirmCheckbox(host, 'I confirm this external chip issuance.');
  await activate(host, button(host, 'Give chips'));
  await host.getByText(/Ready to play/).waitFor();
  await keyboardField(host, 'Chip value for red chips', '5');
  await activate(host, button(host, 'Save settings'));
  await host.keyboard.press('Escape');
  // The public chip values legend shows numeric values to everyone.
  await host.getByText('Chip values', { exact: true }).click();
  await host.getByText('red: 5', { exact: true }).waitFor();

  // The invite lives in the host's Invite dialog; nothing is posted to Fluxer automatically.
  await activate(host, button(host, 'Invite'));
  const invite = await host.getByLabel('Invite link').inputValue();
  assert.match(invite, /\/join\/[\w-]{22}#[\w-]{43}$/);
  await host.keyboard.press('Escape');
  await guest.goto(invite);
  await activate(guest, link(guest, 'Sign in with Fluxer'));
  await activate(guest, button(guest, 'Buy in'));
  await guest.getByText(/Buy-in request sent/).waitFor();

  // Confirm custom terms, not the table defaults, before the guest can see their new seat.
  await activate(host, button(host, 'Table master'));
  const request = host.getByRole('list', { name: 'Pending entry requests' }).getByRole('listitem').first();
  await request.getByText('Player 2 · ready to enter').waitFor();
  await keyboardField(host, 'Chips (chip units)', '875');
  await keyboardField(host, 'Recorded cash (USD minor units)', '1375');
  await confirmCheckbox(host, 'I confirm this entry and chip issuance.');
  assert.ok(await request.evaluate((node) => node.scrollWidth <= node.clientWidth));
  await request.screenshot({ path: join(artifacts, 'entry-approval-mobile.png') });
  await activate(host, request.getByRole('button', { name: 'Approve' }));
  await guest.getByRole('list', { name: 'Seats' }).getByRole('listitem').nth(1).getByText('You').waitFor();
  await guest.getByText(/Ready to play · 875 chips/).waitFor();
  // The legend is public once a seat holds chips; a guest never sees the Table master controls.
  await guest.getByText('Chip values', { exact: true }).click();
  await guest.getByText('red: 5', { exact: true }).waitFor();
  assert.equal(await guest.getByRole('button', { name: 'Table master' }).count(), 0);
  await host.keyboard.press('Escape');
  await focusWithKeyboard(host, host.getByLabel('Initial dealer'));
  // Heads-up the dealer acts first preflop, so deal to the host to have a turn to fold.
  await host.keyboard.press('Home');
  await host.keyboard.press('ArrowDown');
  await activate(host, button(host, 'Start game'));
  await activate(host, button(host, 'Table master'));
  await activate(host, button(host, 'Stop after hand'));
  await host.keyboard.press('Escape');
  await activate(host, button(host, 'Fold'));
  await host.getByText('Hand 1 details', { exact: true }).waitFor();
  await activate(host, button(host, 'Table master'));

  // Cash the guest out with a typo in the recorded amount, then repair it as an audited correction.
  const selected = host.getByLabel('Player cashing out');
  await focusWithKeyboard(host, selected);
  await host.keyboard.press('End');
  await settle(host, '1400');
  // The correction panel lives in the dialog that is already open.
  await host.getByText('Correct the settlement ledger', { exact: true }).click();
  await host.getByRole('listitem').filter({ hasText: 'Cash-out · 1400' })
    .getByRole('button', { name: 'Correct this record' }).click();
  await keyboardField(host, 'Recorded cash (minor units)', '0');
  await keyboardField(host, 'Reason (required, shown in the ledger)', 'Typo: no cash was exchanged');
  await confirmCheckbox(host, 'I confirm this correction.');
  await activate(host, button(host, 'Record correction'));
  await host.getByText(/Corrected entry \(originally #\d+\)/).waitFor();
  await host.getByText(/Typo: no cash was exchanged/).waitFor();
  await host.keyboard.press('Escape');

  // The guest sees the corrected total, but never the host's own records.
  await activate(guest, link(guest, 'Ledger and hand history'));
  await guest.getByText('Buy-in · 1375 USD minor units', { exact: true }).waitFor();
  await guest.getByText('Cash-out · 0 USD minor units', { exact: true }).waitFor();
  await guest.getByText(/Corrected entry \(originally #\d+\): Typo: no cash was exchanged/).waitFor();
  assert.equal(await guest.getByRole('row', { name: /Player 1/ }).count(), 0);
  await host.screenshot({ path: join(artifacts, 'corrections-host.png'), fullPage: true });
});

test('keyboard-only mobile settlement, private history, and authorized Fluxer posts', async (t) => {
  const stack = new Stack({ FLUXER_CHANNEL_ID: CHANNEL_ID });
  await stack.start();
  t.after(() => stack.stop());
  const browser = await launch();
  t.after(() => browser.close());
  // Two isolated mobile profiles: separate browser contexts, signed in independently.
  const { page: host } = await player(browser, stack, '1001', mobile);
  const { page: guest } = await player(browser, stack, '1002', mobile);
  await host.goto(stack.origin);
  await activate(host, link(host, 'Sign in with Fluxer'));
  await activate(host, button(host, 'Create a table'));
  await activate(host, button(host, 'Invite'));
  const invite = await host.getByLabel('Invite link').inputValue();
  await activate(host, button(host, 'Post invite to Fluxer'));
  await host.getByText('Posted to the configured Fluxer channel.').waitFor();
  assert.ok(stack.fake.messages[0].content.includes(invite));
  await host.keyboard.press('Escape');
  await activate(host, button(host, 'Table master'));
  await keyboardField(host, 'Buy-in value (minor units)', '1200');
  await activate(host, button(host, 'Save settings'));
  // Wait for the saved default to reach the issuance field before confirming.
  const recordedCash = host.getByLabel('Recorded cash (USD minor units)', { exact: true });
  await recordedCash.and(host.locator('input[value="1200"]')).waitFor();
  await confirmCheckbox(host, 'I confirm this external chip issuance.');
  await activate(host, button(host, 'Give chips'));
  await host.keyboard.press('Escape');
  await host.getByText(/Ready to play/).waitFor();
  await guest.goto(invite);
  await activate(guest, link(guest, 'Sign in with Fluxer'));
  await buyInAndWaitForSeat(guest, host);

  await focusWithKeyboard(host, host.getByLabel('Initial dealer'));
  await host.keyboard.press('Home');
  await host.keyboard.press('ArrowDown');
  await activate(host, button(host, 'Start game'));
  await activate(host, button(host, 'Table master'));
  await activate(host, button(host, 'Stop after hand'));
  await host.getByText(/Dealing will stop after this hand/).waitFor();
  await host.keyboard.press('Escape');
  await activate(host, button(host, 'Fold'));
  await host.getByText('Hand 1 details', { exact: true }).waitFor();
  await activate(host, button(host, 'Table master'));

  const selected = host.getByLabel('Player cashing out');
  await focusWithKeyboard(host, selected);
  await host.keyboard.press('End');
  assert.equal(await selected.inputValue(), '1002');
  await settle(host, '0');
  // The guest rebuys from an empty stack: the master issues a fresh stack without a new entry request.
  const rebuy = host.getByLabel('Player', { exact: true });
  await focusWithKeyboard(host, rebuy);
  assert.equal(await rebuy.inputValue(), '1002');
  await confirmCheckbox(host, 'I confirm this external chip issuance.');
  await activate(host, button(host, 'Give chips'));
  await host.keyboard.press('Escape');
  await guest.getByText(/Ready to play/).waitFor();

  // The guest cashes out again after the rebuy and can still see their records after leaving.
  await activate(host, button(host, 'Table master'));
  await selected.getByRole('option', { name: 'Player 2 · 1000 chips', exact: true }).waitFor({ state: 'attached' });
  await focusWithKeyboard(host, selected);
  await host.keyboard.press('End');
  assert.equal(await selected.inputValue(), '1002');
  await settle(host, '1300');
  await activate(guest, button(guest, 'Leave'));
  await guest.getByRole('heading', { name: 'You left the table' }).waitFor();
  await focusWithKeyboard(host, selected);
  await host.keyboard.press('End');
  assert.equal(await selected.inputValue(), '1001');
  await settle(host, '1000');
  await activate(host, button(host, 'Close table'));
  await host.getByRole('heading', { name: 'Table closed' }).waitFor();

  const row = (page: Page) => page.getByRole('table', { name: 'Cash totals in minor units' }).getByRole('row', { name: /Player 2/ });
  for (const page of [host, guest]) {
    await activate(page, link(page, 'Ledger and hand history'));
    await page.waitForFunction(() => document.activeElement === document.querySelector('main') && window.scrollY === 0);
    await row(page).getByRole('cell', { name: '1300', exact: true }).waitFor();
    await row(page).getByRole('cell', { name: '-1100', exact: true }).waitFor();
    await page.getByText('Rebuy · 1200 USD minor units', { exact: true }).waitFor();
    await page.getByText(/^Hand 1 ·/).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  assert.equal(await guest.getByRole('row', { name: /Player 1/ }).count(), 0);
  await host.getByRole('row', { name: /Player 1/ }).waitFor();
  await activate(host, button(host, 'Post settlement summary to Fluxer'));
  await host.getByText('Posted to the configured Fluxer channel.').waitFor();
  assert.match(stack.fake.messages.at(-1)!.content, /in 3600, out 2300, net -1300/);
  await host.screenshot({ path: join(artifacts, 'ledger-mobile.png'), fullPage: true });
});

test('the master repairs an unplayed stack and voids a wrong-seat grant', { timeout: 120_000 }, async (t) => {
  const stack = new Stack();
  await stack.start();
  t.after(() => stack.stop());
  const browser = await launch();
  t.after(() => browser.close());
  const { page: host } = await player(browser, stack, '1001', mobile);
  const { page: guest } = await player(browser, stack, '1002', mobile);
  await host.goto(stack.origin);
  await activate(host, link(host, 'Sign in with Fluxer'));
  await activate(host, button(host, 'Create a table'));
  await activate(host, button(host, 'Invite'));
  const invite = await host.getByLabel('Invite link').inputValue();
  await host.keyboard.press('Escape');
  await activate(host, button(host, 'Table master'));
  await confirmCheckbox(host, 'I confirm this external chip issuance.');
  await activate(host, button(host, 'Give chips'));
  await host.getByText(/Ready to play/).waitFor();
  await host.keyboard.press('Escape');
  await guest.goto(invite);
  await activate(guest, link(guest, 'Sign in with Fluxer'));
  await buyInAndWaitForSeat(guest, host);

  // Repair an unplayed stack; both the live seat and the replacement receipt must have the new count.
  await activate(host, button(host, 'Table master'));
  await host.getByText('Correct the settlement ledger', { exact: true }).click();
  const guestGrant = host.getByRole('listitem').filter({ hasText: 'Player 2 · 1000 chips' });
  await guestGrant.getByRole('button', { name: 'Correct this record' }).click();
  await keyboardField(host, 'Chips (chip units)', '750');
  await keyboardField(host, 'Reason (required, shown in the ledger)', 'Typo: granted 750 not 1000');
  await confirmCheckbox(host, 'I confirm this correction.');
  await activate(host, button(host, 'Record correction'));
  await host.getByText(/Player 2 · 750 chips · Corrected entry \(originally #\d+\): Typo: granted 750 not 1000/).waitFor();
  await guest.getByText(/Ready to play · 750 chips/).waitFor();

  // The host's own grant is voidable while its chips are still unplayed on that seat.
  const ownGrant = host.getByRole('listitem').filter({ hasText: 'Player 1 · 1000 chips' });
  await ownGrant.getByRole('button', { name: 'Void (wrong seat)' }).click();
  await keyboardField(host, 'Reason (required, shown in the ledger)', 'Wrong seat: nobody asked for these');
  await confirmCheckbox(host, 'I confirm this correction.');
  await activate(host, button(host, 'Record correction'));
  await host.getByText(/voided: Wrong seat: nobody asked for these/).waitFor();
  await host.keyboard.press('Escape');
  // The voided grant leaves that seat empty again, and the master is told to reissue from the panel.
  await host.getByText(/You are out of chips\. The table master can give you chips between hands\./).waitFor();
  await host.getByText('Two players with chips are needed to start.').waitFor();
  await host.screenshot({ path: join(artifacts, 'corrections-unplayed.png'), fullPage: true });
});
