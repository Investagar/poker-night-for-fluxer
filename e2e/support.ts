import assert from 'node:assert/strict';
import { type ChildProcess, execFileSync, type ExecFileSyncOptionsWithStringEncoding, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { type Browser, type BrowserContext, chromium, type LaunchOptions, type Locator, type Page } from 'playwright-core';
import { FakeFluxer } from '../test/fake-fluxer.ts';
import { env, people } from '../test/helpers.ts';

export const artifacts = join(import.meta.dirname, 'artifacts');

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  server.close();
  await once(server, 'close');
  return address.port;
}

/**
 * The app under test, pointed at an in-test fake Fluxer: by default the built app (`npm run build` first) as a child
 * process; with E2E_TARGET=container, `docker compose up --build` under a separate project with its own volume.
 *
 * Container smoke uses Linux host networking with the app and fake both bound to 127.0.0.1. The override
 * changes only the test routing, not the image user, volume, health checks or filesystem restrictions.
 */
export class Stack {
  fake = new FakeFluxer([...people, { id: '2002', username: 'outsider', global_name: 'Outsider', member: false }]);
  origin = '';
  log = '';
  readonly container = process.env.E2E_TARGET === 'container';
  /** Optional settings for this stack; only enumerated safe keys pass through to the app. */
  private readonly extraEnv: Record<string, string>;
  private dir = mkdtempSync(join(tmpdir(), 'pokerbot-e2e-'));
  private child: ChildProcess | undefined;
  private port = 0;
  private envFile = join(this.dir, 'app.env');
  private settings: NodeJS.ProcessEnv = {};
  private readonly composeFile = join(this.dir, 'smoke-compose.yaml');
  private readonly project = basename(this.dir).toLowerCase();
  private configured = false;

  /** `env` may only set keys in SAFE_ENV; anything else is ignored rather than leaking into the app. */
  constructor(env: Record<string, string> = {}) {
    const safe = ['FLUXER_CHANNEL_ID', 'SESSION_SECONDS'];
    this.extraEnv = Object.fromEntries(Object.entries(env).filter(([key]) => safe.includes(key)));
  }

  async start(): Promise<void> {
    await this.fake.start();
    this.port = this.container ? 8080 : await freePort();
    this.origin = `http://127.0.0.1:${this.port}`;
    this.settings = { ...env(this.fake.apiOrigin, join(this.dir, 'pokerbot.sqlite')), PUBLIC_ORIGIN: this.origin, ...this.extraEnv };
    if (this.container) {
      writeFileSync(this.envFile, Object.entries({ ...this.settings, DATABASE_PATH: '/data/pokerbot.sqlite' }).map(([k, v]) => `${k}=${v}`).join('\n'));
      writeFileSync(this.composeFile, `
services:
  pokerbot:
    network_mode: host
    ports: !reset []
    environment:
      HOST: 127.0.0.1
      PORT: "8080"
`);
      this.configured = true;
      this.compose('up', '-d', '--build');
    } else {
      this.spawn(this.settings);
    }
    await this.ready();
  }

  compose(...args: string[]): string {
    return execFileSync('docker', ['compose', '-f', 'compose.yaml', '-f', this.composeFile, '-p', this.project, ...args], {
      env: { ...process.env, POKERBOT_ENV_FILE: this.envFile, POKERBOT_HOST_PORT: String(this.port) },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    });
  }

  private spawn(settings: NodeJS.ProcessEnv): void {
    this.child = spawn(process.execPath, ['dist/server/index.js'], {
      env: { ...settings, PORT: String(this.port), PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout!.on('data', (chunk) => { this.log += chunk; });
    this.child.stderr!.on('data', (chunk) => { this.log += chunk; });
  }

  /** Waits until the app answers /healthz and /auth/login really redirects to the Fluxer authorize URL. */
  private async ready(): Promise<void> {
    for (let i = 0; i < 300; i += 1) {
      try {
        const health = await fetch(this.origin + '/healthz', { redirect: 'manual' });
        if (health.ok) {
          const response = await fetch(this.origin + '/auth/login', { redirect: 'manual' });
          if (response.status === 302 && response.headers.get('location')?.startsWith(this.fake.origin + '/oauth2/authorize?')) return;
        }
      } catch {
        // not listening yet
      }
      await sleep(100);
    }
    throw new Error('app did not become ready:\n' + (this.container ? this.compose('logs') : this.log));
  }

  exec(command: string): string {
    return this.compose('exec', '-T', 'pokerbot', 'node', '-e', command);
  }

  health(): string {
    const id = this.compose('ps', '-q').trim();
    const options: ExecFileSyncOptionsWithStringEncoding = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
    // Rootless Podman can run without a systemd user timer. Execute its configured check explicitly.
    if (/podman/i.test(execFileSync('docker', ['--version'], options))) {
      execFileSync('docker', ['healthcheck', 'run', id], options);
    }
    return execFileSync('docker', ['inspect', '--format', '{{.State.Health.Status}}', id], options).trim();
  }

  runtimeInfo(): { imageId: string; readOnlyRoot: boolean } {
    const id = this.compose('ps', '-q', 'pokerbot').trim();
    const format = '{"imageId":{{json .Image}},"readOnlyRoot":{{json .HostConfig.ReadonlyRootfs}}}';
    return JSON.parse(execFileSync('docker', ['inspect', '--format', format, id], { encoding: 'utf8' }));
  }

  async restart(): Promise<void> {
    if (this.container) {
      this.compose('restart', 'pokerbot');
    } else {
      await this.kill();
      this.spawn(this.settings);
    }
    await this.ready();
  }

  private async kill(): Promise<void> {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const closed = once(this.child, 'close');
    this.child.kill('SIGTERM');
    await closed;
  }

  async stop(): Promise<void> {
    try {
      if (this.configured) this.compose('down', '-v');
    } finally {
      await this.kill();
      await this.fake.stop();
      rmSync(this.dir, { recursive: true, force: true });
    }
  }
}

export async function launch(options: LaunchOptions = {}): Promise<Browser> {
  mkdirSync(artifacts, { recursive: true });
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, ...options });
}

/** A fresh, isolated browser profile signed in to the app as `userId` through the fake Fluxer consent flow. */
export async function player(browser: Browser, stack: Stack, userId: string, viewport = { width: 1280, height: 900 }): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto(`${stack.fake.origin}/login/${userId}`);
  return { context, page };
}

export async function signIn(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Sign in with Fluxer' }).click();
  await page.getByRole('button', { name: 'Sign out' }).waitFor();
}

/** Walks Tab until `control` itself holds focus; fails loudly when a control is not keyboard-reachable. */
export async function focusWithKeyboard(page: Page, control: Locator): Promise<void> {
  await control.and(page.locator(':enabled, a[href]')).waitFor();
  for (let i = 0; i < 50; i += 1) {
    if (await control.evaluate((node) => node === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  assert.fail('Control not reachable with Tab');
}

/** Keyboard-only activation: focus the control with Tab, then press Enter. */
export async function activate(page: Page, control: Locator): Promise<void> {
  await focusWithKeyboard(page, control);
  await page.keyboard.press('Enter');
}

/**
 * Guest clicks Buy in on the join page; the host approves through the Table master entry list, and the guest
 * reaches the table seat. Covers the signed-in join page through the host approval flow.
 */
export async function buyInAndWaitForSeat(guest: Page, host: Page, seatIndex = 2): Promise<void> {
  await activate(guest, guest.getByRole('button', { name: 'Buy in', exact: true }));
  await guest.getByText(/Buy-in request sent/).waitFor();
  await activate(host, host.getByRole('button', { name: 'Table master', exact: true }));
  const request = host.getByRole('list', { name: 'Pending entry requests' }).getByRole('listitem').first();
  await request.getByText(/awaiting rotation|ready to enter/).waitFor();
  await focusWithKeyboard(host, request.getByRole('checkbox', { name: 'I confirm this entry and chip issuance.' }));
  await host.keyboard.press('Space');
  await activate(host, request.getByRole('button', { name: 'Approve' }));
  // Close the panel so the next step can reach the table tools again instead of being trapped in the modal.
  await host.keyboard.press('Escape');
  await guest.waitForURL(/\/tables\/[\w-]{22}$/);
  await guest.getByRole('list', { name: 'Seats' }).getByRole('listitem').nth(seatIndex - 1).getByText('You').waitFor();
}

/** Focuses a confirmation checkbox from the keyboard and toggles it with Space, never by clicking. */
export async function confirmCheckbox(page: Page, label: string): Promise<void> {
  await focusWithKeyboard(page, page.getByRole('checkbox', { name: label, exact: true }));
  await page.keyboard.press('Space');
}

/** Focuses a labeled field with the keyboard, selects all, and types a value. */
export async function keyboardField(page: Page, label: string | RegExp, value: string): Promise<void> {
  await focusWithKeyboard(page, page.getByLabel(label, { exact: typeof label === 'string' }));
  await page.keyboard.press('Control+a');
  await page.keyboard.type(value);
}