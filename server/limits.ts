import { type BlockList, isIP } from 'node:net';

export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly perMinute: number;
  private readonly burst: number;
  private readonly maxKeys: number;

  constructor(perMinute: number, burst: number, maxKeys = 4096) {
    this.perMinute = perMinute;
    this.burst = burst;
    this.maxKeys = maxKeys;
  }

  /** Spends one token; returns 0 when allowed, otherwise the seconds until a token is available. */
  take(key: string, now = Date.now()): number {
    const bucket = this.buckets.get(key) ?? { tokens: this.burst, updated: now };
    this.buckets.delete(key);
    bucket.tokens = Math.min(this.burst, bucket.tokens + (Math.max(0, now - bucket.updated) * this.perMinute) / 60_000);
    bucket.updated = now;
    this.buckets.set(key, bucket);
    if (this.buckets.size > this.maxKeys) this.buckets.delete(this.buckets.keys().next().value!);
    if (bucket.tokens < 1) return Math.ceil(((1 - bucket.tokens) * 60) / this.perMinute);
    bucket.tokens -= 1;
    return 0;
  }
}

function normalize(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return mapped ? mapped[1] : address;
}

function trusted(address: string, proxies: BlockList): boolean {
  const family = isIP(address);
  return family !== 0 && proxies.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

/** Client address for rate limiting: forwarded hops are trusted only from configured proxy peers; IPv6 is grouped by /64. */
export function clientAddress(peer: string | undefined, forwarded: string | string[] | undefined, proxies: BlockList): string {
  let address = normalize(peer ?? 'unknown');
  const header = Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '';
  if (trusted(address, proxies) && header.length <= 1024) {
    const chain = header.split(',').map((part) => normalize(part.trim())).filter(Boolean);
    if (chain.length <= 16 && chain.every((part) => isIP(part))) {
      for (let i = chain.length - 1; i >= 0 && trusted(address, proxies); i -= 1) address = chain[i];
    }
  }
  if (isIP(address) === 6) {
    const groups = expandIpv6(address).slice(0, 4);
    return groups.join(':') + '::/64';
  }
  return address;
}

function expandIpv6(address: string): string[] {
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = address.includes('::') && tail ? tail.split(':') : [];
  const fill = address.includes('::') ? Array(8 - left.length - right.length).fill('0') : [];
  return [...left, ...fill, ...right].map((group) => group.toLowerCase().replace(/^0+(?=.)/, ''));
}
