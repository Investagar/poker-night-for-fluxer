import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigError, loadConfig } from '../server/config.ts';
import { env } from './helpers.ts';

const base = env('https://chat.example.com', '/data/pokerbot.sqlite', { PUBLIC_ORIGIN: 'https://poker.example.com', ALLOW_INSECURE_LOCAL: 'false' });

test('accepts a complete HTTPS configuration with defaults', () => {
  const config = loadConfig(base);
  assert.equal(config.publicOrigin, 'https://poker.example.com');
  assert.equal(config.sessionSeconds, 28800);
  assert.equal(config.secure, true);
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 8080);
  assert.equal(config.botCommands, false);
});

test('refuses partial credentials and names every missing key', () => {
  assert.throws(() => loadConfig({ ...base, FLUXER_CLIENT_SECRET: '', FLUXER_BOT_TOKEN: ' ' }),
    (error: Error) => error instanceof ConfigError && /FLUXER_BOT_TOKEN, FLUXER_CLIENT_SECRET/.test(error.message));
  assert.throws(() => loadConfig({ ...base, DATABASE_PATH: undefined }), /DATABASE_PATH/);
});

test('rejects origins with paths, queries, fragments, credentials, or other schemes', () => {
  for (const value of ['https://poker.example.com/app', 'https://poker.example.com?x=1', 'https://poker.example.com#x',
    'https://user:pass@poker.example.com', 'ftp://poker.example.com', 'poker.example.com', 'https://poker.example.com/?']) {
    assert.throws(() => loadConfig({ ...base, PUBLIC_ORIGIN: value }), ConfigError, value);
    assert.throws(() => loadConfig({ ...base, FLUXER_ORIGIN: value }), ConfigError, value);
  }
  assert.equal(loadConfig({ ...base, PUBLIC_ORIGIN: 'https://Poker.Example.com/' }).publicOrigin, 'https://poker.example.com');
});

test('plain HTTP needs the insecure-local opt-in and a local or private LAN host', () => {
  assert.throws(() => loadConfig({ ...base, PUBLIC_ORIGIN: 'http://localhost:5173' }), /HTTPS/);
  assert.throws(() => loadConfig({ ...base, FLUXER_ORIGIN: 'http://chat.example.com' }), /FLUXER_ORIGIN requires HTTPS/);
  for (const host of ['localhost:5173', '127.0.0.1:8080', '192.168.1.20', '10.1.2.3', '172.20.0.5', '[::1]:8080']) {
    const config = loadConfig({ ...base, PUBLIC_ORIGIN: `http://${host}`, FLUXER_ORIGIN: 'http://127.0.0.1:3000', ALLOW_INSECURE_LOCAL: 'true' });
    assert.equal(config.secure, false);
  }
  for (const host of ['poker.example.com', '8.8.8.8', '172.32.0.1']) {
    assert.throws(() => loadConfig({ ...base, PUBLIC_ORIGIN: `http://${host}`, ALLOW_INSECURE_LOCAL: 'true' }), /HTTPS/, host);
  }
});

test('validates booleans, session lifetime, IDs, and trusted proxy CIDRs', () => {
  assert.throws(() => loadConfig({ ...base, ALLOW_INSECURE_LOCAL: 'maybe' }), /ALLOW_INSECURE_LOCAL/);
  assert.throws(() => loadConfig({ ...base, FLUXER_BOT_COMMANDS: 'maybe' }), /FLUXER_BOT_COMMANDS/);
  assert.equal(loadConfig({ ...base, FLUXER_BOT_COMMANDS: 'true' }).botCommands, true);
  assert.throws(() => loadConfig({ ...base, SESSION_SECONDS: '10' }), /SESSION_SECONDS/);
  assert.throws(() => loadConfig({ ...base, SESSION_SECONDS: '1.5' }), /SESSION_SECONDS/);
  assert.equal(loadConfig({ ...base, SESSION_SECONDS: '3600' }).sessionSeconds, 3600);
  assert.throws(() => loadConfig({ ...base, FLUXER_GUILD_ID: 'abc' }), /FLUXER_GUILD_ID/);
  assert.equal(loadConfig({ ...base, FLUXER_CHANNEL_ID: '' }).channelId, undefined, 'an empty channel disables bot posts');
  assert.equal(loadConfig({ ...base }).channelId, undefined, 'an omitted channel disables bot posts');
  assert.equal(loadConfig({ ...base, FLUXER_CHANNEL_ID: ' 300 ' }).channelId, '300');
  assert.throws(() => loadConfig({ ...base, FLUXER_CHANNEL_ID: 'ch300' }), /FLUXER_CHANNEL_ID/);
  assert.throws(() => loadConfig({ ...base, FLUXER_CHANNEL_ID: '-1' }), /FLUXER_CHANNEL_ID/);
  assert.throws(() => loadConfig({ ...base, TRUSTED_PROXY_CIDRS: '0.0.0.0/0' }), /entire internet/);
  assert.throws(() => loadConfig({ ...base, TRUSTED_PROXY_CIDRS: '::/0' }), /entire internet/);
  assert.throws(() => loadConfig({ ...base, TRUSTED_PROXY_CIDRS: '10.0.0.0/33' }), /invalid/);
  assert.throws(() => loadConfig({ ...base, TRUSTED_PROXY_CIDRS: 'proxy.local' }), /invalid/);
  const proxies = loadConfig({ ...base, TRUSTED_PROXY_CIDRS: '172.18.0.0/16, 10.0.0.2, fd00::/8' }).trustedProxies;
  assert.ok(proxies.check('172.18.4.5', 'ipv4'));
  assert.ok(proxies.check('10.0.0.2', 'ipv4'));
  assert.ok(!proxies.check('10.0.0.3', 'ipv4'));
  assert.ok(proxies.check('fd12::1', 'ipv6'));
});

test('error messages never echo secret values', () => {
  try {
    loadConfig({ ...base, FLUXER_CLIENT_ID: 'super-secret-value', FLUXER_BOT_TOKEN: 'bot-secret' });
    assert.fail('expected failure');
  } catch (error) {
    assert.ok(!String(error).includes('super-secret-value'));
    assert.ok(!String(error).includes('bot-secret'));
  }
});
