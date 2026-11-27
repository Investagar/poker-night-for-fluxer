import { BlockList, isIP } from 'node:net';

export interface Config {
  publicOrigin: string;
  fluxerOrigin: string;
  guildId: string;
  channelId?: string;
  botCommands: boolean;
  botToken: string;
  clientId: string;
  clientSecret: string;
  databasePath: string;
  sessionSeconds: number;
  allowInsecureLocal: boolean;
  trustedProxies: BlockList;
  secure: boolean;
  host: string;
  port: number;
}

export class ConfigError extends Error {}

const LAN = new BlockList();
LAN.addSubnet('127.0.0.0', 8, 'ipv4');
LAN.addSubnet('10.0.0.0', 8, 'ipv4');
LAN.addSubnet('172.16.0.0', 12, 'ipv4');
LAN.addSubnet('192.168.0.0', 16, 'ipv4');
LAN.addAddress('::1', 'ipv6');
LAN.addSubnet('fc00::', 7, 'ipv6');

function origin(name: string, value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be an HTTP(S) origin`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new ConfigError(`${name} must be an HTTP(S) origin without credentials`);
  }
  if (url.pathname !== '/' || url.search || url.hash || /[?#]/.test(value)) {
    throw new ConfigError(`${name} must not contain a path, query, or fragment`);
  }
  return url.origin;
}

function flag(name: string, value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  if (['', 'false', '0', 'no', 'off'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  throw new ConfigError(`${name} must be true or false`);
}

export function parseProxies(value: string): BlockList {
  const list = new BlockList();
  for (const entry of value.split(',').map((x) => x.trim()).filter(Boolean)) {
    const [address, prefixText, extra] = entry.split('/');
    const family = isIP(address);
    const max = family === 6 ? 128 : 32;
    const prefix = prefixText === undefined ? max : Number(prefixText);
    if (!family || extra !== undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > max || prefixText === '') {
      throw new ConfigError(`TRUSTED_PROXY_CIDRS contains an invalid address or CIDR: ${entry}`);
    }
    if (prefix === 0) throw new ConfigError('TRUSTED_PROXY_CIDRS must list the actual proxy addresses, not the entire internet');
    list.addSubnet(address, prefix, family === 6 ? 'ipv6' : 'ipv4');
  }
  return list;
}

function localHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  const address = hostname.replace(/^\[|\]$/g, '');
  const family = isIP(address);
  return family !== 0 && LAN.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new ConfigError(`${name} is required`);
    return value;
  };
  const missing = ['PUBLIC_ORIGIN', 'FLUXER_ORIGIN', 'FLUXER_GUILD_ID', 'FLUXER_BOT_TOKEN', 'FLUXER_CLIENT_ID',
    'FLUXER_CLIENT_SECRET', 'DATABASE_PATH'].filter((name) => !env[name]?.trim());
  if (missing.length) throw new ConfigError(`Missing required settings: ${missing.join(', ')}`);

  const allowInsecureLocal = flag('ALLOW_INSECURE_LOCAL', env.ALLOW_INSECURE_LOCAL);
  const publicOrigin = origin('PUBLIC_ORIGIN', required('PUBLIC_ORIGIN'));
  const fluxerOrigin = origin('FLUXER_ORIGIN', required('FLUXER_ORIGIN'));
  const secure = publicOrigin.startsWith('https://');
  if (!secure && (!allowInsecureLocal || !localHost(new URL(publicOrigin).hostname))) {
    throw new ConfigError('PUBLIC_ORIGIN requires HTTPS (localhost and private LAN IPs can opt out with ALLOW_INSECURE_LOCAL=true)');
  }
  if (!fluxerOrigin.startsWith('https://') && !allowInsecureLocal) throw new ConfigError('FLUXER_ORIGIN requires HTTPS');

  const guildId = required('FLUXER_GUILD_ID');
  if (!/^\d{1,20}$/.test(guildId)) throw new ConfigError('FLUXER_GUILD_ID must be a numeric community ID');
  const channelId = env.FLUXER_CHANNEL_ID?.trim() || undefined;
  if (channelId && !/^\d{1,20}$/.test(channelId)) throw new ConfigError('FLUXER_CHANNEL_ID must be a numeric channel ID');
  const botCommands = flag('FLUXER_BOT_COMMANDS', env.FLUXER_BOT_COMMANDS);
  const clientId = required('FLUXER_CLIENT_ID');
  if (!/^\d{1,20}$/.test(clientId)) throw new ConfigError('FLUXER_CLIENT_ID must be a numeric application ID');

  const sessionSeconds = env.SESSION_SECONDS?.trim() ? Number(env.SESSION_SECONDS) : 28800;
  if (!Number.isInteger(sessionSeconds) || sessionSeconds < 300 || sessionSeconds > 604800) {
    throw new ConfigError('SESSION_SECONDS must be an integer from 300 to 604800');
  }
  const port = env.PORT?.trim() ? Number(env.PORT) : 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError('PORT must be a TCP port');

  return {
    publicOrigin,
    fluxerOrigin,
    guildId,
    channelId,
    botCommands,
    botToken: required('FLUXER_BOT_TOKEN'),
    clientId,
    clientSecret: required('FLUXER_CLIENT_SECRET'),
    databasePath: required('DATABASE_PATH'),
    sessionSeconds,
    allowInsecureLocal,
    trustedProxies: parseProxies(env.TRUSTED_PROXY_CIDRS ?? ''),
    secure,
    host: env.HOST?.trim() || '127.0.0.1',
    port,
  };
}
