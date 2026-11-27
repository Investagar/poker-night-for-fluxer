import { WebSocket } from 'ws';

/**
 * Fluxer Gateway client over the instance's WebSocket endpoint. Receives
 * MESSAGE_CREATE dispatches, keeps the session alive, resumes across network
 * failures, and never logs or exposes the bot token.
 */

type Json = Record<string, unknown>;

/** Called only for MESSAGE_CREATE dispatches after READY, in sequence order. */
export type DispatchHandler = (data: unknown) => void;

const OPCODE = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 6,
  RECONNECT: 7,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11,
} as const;

/** Retrying after these cannot succeed until the bot token, shard or protocol version changes. */
const CLOSE_FATAL = new Set([4004, 4010, 4012]);
// A close that leaves the session resumable reconnects inside the documented
// 60,000 ms replay window. Failed dials and 4008 rate limits back off instead.
const RESUME_RECONNECT_MS = 1_000;
const BACKOFF_MS = 5_000;
const BACKOFF_CEILING_MS = 60_000;
/** An Identify or Resume the Gateway holds without a reply is retried after this. */
const AUTH_TIMEOUT_MS = 30_000;

export class FluxerGateway {
  private readonly url: URL;
  private readonly onDispatch: DispatchHandler;
  private readonly onDown: () => void;
  private readonly token: string;
  private socket: WebSocket | undefined;
  /** Server-provided heartbeat cadence; a connection is not live until Hello names it. */
  private heartbeatMs = 0;
  private heartbeatTimer: NodeJS.Timeout | undefined;
  private authTimer: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private acked = true;
  private closed = false;
  private connectAttempt = 0;
  /** True once this connection sent Identify or Resume; a dial failure never gets there. */
  private handshake = false;
  /** Last dispatch sequence this client has fully handed to the application. */
  private seq = 0;
  private sessionId = '';

  constructor(url: string, token: string, onDispatch: DispatchHandler, onDown: () => void) {
    if (!url) throw new Error('FluxerGateway requires a gateway URL');
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('FluxerGateway requires a valid gateway URL');
    }
    if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error('FluxerGateway requires a ws:// or wss:// gateway URL');
    this.url = parsed;
    this.token = token;
    this.onDispatch = onDispatch;
    this.onDown = onDown;
  }

  /** Opens the connection loop; idempotent. Returns immediately; dispatches arrive via callback. */
  start(): void {
    if (this.socket || this.reconnectTimer) return;
    this.closed = false;
    this.connectAttempt = 0;
    this.connect();
  }

  /** Stops reconnecting and closes any open socket; idempotent. */
  stop(): void {
    this.closed = true;
    this.clearTimers();
    // A client close with 1000 ends the session server-side, so drop session state with it.
    this.sessionId = '';
    this.seq = 0;
    this.socket?.close(1000, 'client stop');
    this.socket = undefined;
  }

  private connect(): void {
    if (this.closed) return;
    this.handshake = false;
    this.socket = new WebSocket(this.urlObject(), { handshakeTimeout: 15_000 });
    const socket = this.socket;
    socket.on('open', () => {
      if (this.socket !== socket) return;
      this.connectAttempt = 0;
      this.acked = true;
      this.heartbeatMs = 0;
    });
    socket.on('message', (chunk: Buffer) => {
      if (this.socket !== socket) return;
      try {
        this.receive(JSON.parse(chunk.toString('utf8')));
      } catch {
        // Ignore a frame that is not valid JSON; the Gateway never sends one.
      }
    });
    socket.on('close', (code: number) => {
      if (this.socket === socket) this.handleClose(code);
    });
    socket.on('error', () => socket.close());
  }

  /** Keeps the instance's published query, forces v=1 JSON, and drops compression options this client cannot honor. */
  private urlObject(): string {
    const url = new URL(this.url.toString());
    url.searchParams.delete('compress');
    url.searchParams.delete('stream');
    url.searchParams.set('v', '1');
    url.searchParams.set('encoding', 'json');
    return url.toString();
  }

  private receive(payload: unknown): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const { op, d, s, t } = payload as { op?: unknown; d?: unknown; s?: unknown; t?: unknown };
    if (typeof op !== 'number') return;
    switch (op) {
      case OPCODE.HELLO: {
        const interval = (d as Json | null | undefined)?.heartbeat_interval;
        if (typeof interval !== 'number' || !Number.isFinite(interval) || interval <= 0) return;
        this.heartbeatMs = interval;
        this.sendIdentify();
        this.scheduleHeartbeat();
        return;
      }
      case OPCODE.DISPATCH: {
        if (typeof t !== 'string') return;
        if (t === 'READY' || t === 'RESUMED') {
          // The handshake is over even when the event repeats a sequence this client already
          // processed, so the auth timer must be cleared before the stale-sequence check.
          clearTimeout(this.authTimer);
          this.authTimer = undefined;
          if (t === 'READY') {
            const id = (d as Json | null | undefined)?.session_id;
            if (typeof id === 'string' && id) this.sessionId = id;
          }
        }
        if (typeof s !== 'number' || !Number.isSafeInteger(s) || s <= this.seq) return;
        this.seq = s;
        // READY and RESUMED are consumed above; replayed events arrive before RESUMED.
        if (t === 'MESSAGE_CREATE') this.onDispatch(d);
        return;
      }
      case OPCODE.HEARTBEAT:
        // The Gateway demands a heartbeat when our ACK went missing; reply at once with
        // our sequence and count that reply as the beat we then owe the next interval.
        this.acked = false;
        this.sendHeartbeat();
        this.scheduleHeartbeat();
        return;
      case OPCODE.HEARTBEAT_ACK:
        this.acked = true;
        return;
      case OPCODE.RECONNECT:
        // The Gateway closes this socket with 4000 next; the close handler resumes.
        return;
      case OPCODE.INVALID_SESSION:
        // d: false: the session cannot resume, but the socket stays open for a fresh Identify.
        this.sessionId = '';
        this.seq = 0;
        this.sendIdentify();
        return;
      default:
        return;
    }
  }

  private sendIdentify(): void {
    this.handshake = true;
    clearTimeout(this.authTimer);
    this.authTimer = setTimeout(() => this.socket?.close(4000, 'auth timeout'), AUTH_TIMEOUT_MS);
    this.authTimer.unref?.();
    const d = {
      token: this.token,
      properties: { os: process.platform, browser: 'Pokerbot', device: 'pokerbot' },
    };
    if (this.sessionId) {
      this.send({ op: OPCODE.RESUME, d: { ...d, session_id: this.sessionId, seq: this.seq } });
      return;
    }
    this.send({ op: OPCODE.IDENTIFY, d });
  }

  private send(payload: Json): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  private sendHeartbeat(): void {
    this.send({ op: OPCODE.HEARTBEAT, d: this.seq > 0 ? this.seq : null });
  }

  private scheduleHeartbeat(): void {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (!this.acked) {
        // No ACK since the last beat: the link is broken; the Gateway would close 4009 anyway.
        this.socket?.close(4009, 'heartbeat timeout');
        return;
      }
      this.acked = false;
      this.sendHeartbeat();
      this.scheduleHeartbeat();
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private clearTimers(): void {
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.authTimer);
    clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = undefined;
    this.authTimer = undefined;
    this.reconnectTimer = undefined;
  }

  private handleClose(code: number): void {
    this.clearTimers();
    this.socket = undefined;
    if (this.closed) return;
    if (CLOSE_FATAL.has(code) || code === 1000 || code === 1001) {
      this.sessionId = '';
      this.seq = 0;
      this.onDown();
      return;
    }
    this.connectAttempt += 1;
    // A connected session resumes promptly; a dial that never reached the server,
    // and 4008 rate limits, wait out a capped exponential backoff.
    const delay = code !== 4008 && this.handshake && this.sessionId
      ? RESUME_RECONNECT_MS
      : Math.min(BACKOFF_CEILING_MS, BACKOFF_MS * 2 ** Math.min(this.connectAttempt - 1, 4));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
