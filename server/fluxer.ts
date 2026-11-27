import { setTimeout as sleep } from 'node:timers/promises';
import type { Config } from './config.ts';
import { Problem } from './errors.ts';

export interface Member {
  id: string;
  name: string;
  avatar: string | null;
}

export interface Identity {
  id: string;
  bot: boolean;
  system: boolean;
}

type Json = Record<string, unknown>;

const TIMEOUT_MS = 10_000;
// Node 26.12.1+ fixes CVE-2026-111497; not advertising Brotli keeps upstream decoding on gzip/deflate regardless.
const ACCEPT_ENCODING = 'gzip, deflate';
const SUPPRESS_EMBEDS = 1 << 2;

function endpoint(value: unknown, schemes: string[]): string {
  if (typeof value !== 'string') throw new Problem(503, 'fluxer-unavailable', 'Fluxer returned an invalid service endpoint.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Problem(503, 'fluxer-unavailable', 'Fluxer returned an invalid service endpoint.');
  }
  if (!schemes.includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) {
    throw new Problem(503, 'fluxer-unavailable', 'Fluxer returned an invalid service endpoint.');
  }
  return value.replace(/\/+$/, '');
}

function object(value: unknown): Json {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

export class Fluxer {
  api = '';
  webapp = '';
  media = '';
  botId = '';
  /**
   * Gateway WebSocket URL from instance discovery, or '' when discovery never
   * published one or it is unusable under the configured security policy.
   * A missing or malformed gateway alone never fails discovery.
   */
  gateway = '';
  private readonly config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  get ready(): boolean {
    return Boolean(this.api && this.webapp && this.botId);
  }

  async discover(): Promise<void> {
    const response = await fetch(this.config.fluxerOrigin + '/.well-known/fluxer', {
      headers: { 'accept-encoding': ACCEPT_ENCODING },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Problem(503, 'fluxer-unavailable', `Fluxer discovery returned HTTP ${response.status}.`);
    const endpoints = object(object(await response.json()).endpoints);
    const schemes = this.config.allowInsecureLocal ? ['https:', 'http:'] : ['https:'];
    let api = endpoint(endpoints.api_public || endpoints.api, schemes);
    if (!api.endsWith('/v1')) api += '/v1';
    const webapp = endpoint(endpoints.webapp, schemes);
    const media = endpoints.media ? endpoint(endpoints.media, schemes) : '';
    let gateway = '';
    if (typeof endpoints.gateway === 'string' && endpoints.gateway) {
      // The gateway is optional and a bad value there must not break sign-in.
      try {
        const url = new URL(endpoints.gateway);
        if (!schemes.includes(url.protocol) || !url.hostname || url.username || url.password || url.hash) throw new Error();
        gateway = endpoints.gateway;
      } catch {
        gateway = '';
      }
    }
    this.api = api;
    const me = object(await this.request('GET', '/users/@me'));
    if (me.bot !== true || typeof me.id !== 'string') {
      this.api = '';
      throw new Problem(503, 'fluxer-unavailable', 'FLUXER_BOT_TOKEN must belong to a bot account.');
    }
    this.webapp = webapp;
    this.media = media;
    this.gateway = gateway;
    this.botId = me.id;
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    if (!this.api) throw new Problem(503, 'fluxer-unavailable', 'Fluxer discovery is not complete.');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(this.api + path, {
          method,
          headers: {
            authorization: 'Bot ' + this.config.botToken,
            'accept-encoding': ACCEPT_ENCODING,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          redirect: method === 'GET' ? 'follow' : 'error', // Do not forward an invite payload to a redirect target.
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch {
        throw new Problem(503, 'fluxer-unavailable', 'Fluxer could not be reached.');
      }
      if (method === 'GET' && response.status === 429 && attempt < 3) {
        const data = object(await response.json().catch(() => ({})));
        const seconds = Math.min(30, Math.max(1, Number(data.retry_after) || 1));
        await sleep(seconds * 1000);
        continue;
      }
      if (response.status === 404) throw new Problem(404, 'not-found', 'Fluxer community or member was not found.');
      if (!response.ok) {
        throw new Problem(503, 'fluxer-unavailable', 'Fluxer request failed. Check bot permissions and instance availability.');
      }
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
    throw new Problem(503, 'fluxer-unavailable', 'Fluxer rate limit exceeded.');
  }

  async member(userId: string): Promise<Member> {
    let member: Json;
    try {
      member = object(await this.request('GET', `/guilds/${this.config.guildId}/members/${encodeURIComponent(userId)}`));
    } catch (error) {
      if (error instanceof Problem && error.status === 404) {
        throw new Problem(403, 'not-member', 'Join the configured Fluxer community to play.');
      }
      throw error;
    }
    const user = object(member.user);
    if (user.bot === true || user.system === true) throw new Problem(403, 'not-member', 'Bot and system accounts cannot play.');
    const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : '');
    const name = (text(member.nick) || text(user.global_name) || text(user.username) || 'Member').slice(0, 64);
    const memberAvatar = text(member.avatar);
    const hash = memberAvatar || text(user.avatar);
    let avatar: string | null = null;
    if (this.media && hash) {
      const uid = encodeURIComponent(userId);
      const path = memberAvatar ? `guilds/${encodeURIComponent(this.config.guildId)}/users/${uid}/avatars/` : `avatars/${uid}/`;
      avatar = `${this.media}/${path}${encodeURIComponent(hash)}.webp?size=64`;
    }
    return { id: userId, name, avatar };
  }

  async checkPostChannel(id: string): Promise<void> {
    const channel = object(await this.request('GET', `/channels/${encodeURIComponent(id)}`));
    if (channel.guild_id !== this.config.guildId) {
      throw new Problem(503, 'fluxer-unavailable', 'The configured post channel must belong to the configured community.');
    }
  }

  async postMessage(id: string, content: string, nonce: string): Promise<string> {
    const message = object(await this.request('POST', `/channels/${encodeURIComponent(id)}/messages`, {
      content,
      nonce,
      flags: SUPPRESS_EMBEDS,
      allowed_mentions: { parse: [] },
    }));
    if (typeof message.id !== 'string' || !message.id) {
      throw new Problem(503, 'fluxer-unavailable', 'Fluxer did not confirm the message.');
    }
    return message.id;
  }

  async openDirectMessage(userId: string): Promise<string> {
    const channel = object(await this.request('POST', '/users/@me/channels', { recipient_id: userId }));
    if (typeof channel.id !== 'string' || !channel.id) {
      throw new Problem(503, 'fluxer-unavailable', 'Fluxer did not confirm the direct message channel.');
    }
    if (channel.type !== 1) throw new Problem(503, 'fluxer-unavailable', 'Fluxer returned a non-direct-message channel.');
    const recipients = Array.isArray(channel.recipients) ? channel.recipients : [];
    if (recipients.length !== 1 || object(recipients[0]).id !== userId) {
      throw new Problem(503, 'fluxer-unavailable', 'Fluxer returned a direct message with an unexpected recipient.');
    }
    return channel.id;
  }

  async exchange(code: string, verifier: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(this.api + '/oauth2/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept-encoding': ACCEPT_ENCODING },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: this.config.publicOrigin + '/auth/callback',
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Problem(502, 'signin-failed', 'Fluxer could not complete sign-in.');
    }
    const token = object(await response.json().catch(() => ({}))).access_token;
    if (!response.ok || typeof token !== 'string' || !token) throw new Problem(502, 'signin-failed', 'Fluxer could not complete sign-in.');
    return token;
  }

  async identity(accessToken: string): Promise<Identity> {
    let response: Response;
    try {
      response = await fetch(this.api + '/oauth2/userinfo', {
        headers: { authorization: 'Bearer ' + accessToken, 'accept-encoding': ACCEPT_ENCODING },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new Problem(502, 'signin-failed', 'Fluxer could not verify your identity.');
    }
    const data = object(await response.json().catch(() => ({})));
    if (!response.ok || typeof data.id !== 'string' || !/^\d{1,20}$/.test(data.id)) {
      throw new Problem(502, 'signin-failed', 'Fluxer could not verify your identity.');
    }
    return { id: data.id, bot: data.bot === true, system: data.system === true };
  }
}
