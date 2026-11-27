import type { WebSocket } from 'ws';
import { PROTOCOL_VERSION } from './protocol.ts';

export interface Connection {
  socket: WebSocket;
  tableId: string;
  userId: string;
  sessionHash: string;
  alive: boolean;
}

const HEARTBEAT_MS = 25_000;

/** Live table sockets. Connection state is transient: closing a socket never touches seats. */
export class Hub {
  private readonly tables = new Map<string, Set<Connection>>();
  private readonly view: (tableId: string, userId: string, connected: Set<string>) => unknown;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;

  constructor(view: (tableId: string, userId: string, connected: Set<string>) => unknown, now: () => number) {
    this.view = view;
    this.now = now;
  }

  start(): void {
    this.timer = setInterval(() => {
      for (const connections of this.tables.values()) {
        for (const connection of connections) {
          if (!connection.alive) {
            connection.socket.terminate();
            continue;
          }
          connection.alive = false;
          connection.socket.ping();
          this.send(connection, { v: PROTOCOL_VERSION, type: 'tick', serverNow: this.now() });
        }
      }
    }, HEARTBEAT_MS);
    this.timer.unref();
  }

  stop(): void {
    this.stopping = true;
    clearInterval(this.timer);
    for (const connections of this.tables.values()) for (const connection of connections) connection.socket.close(1001, 'Server restarting');
    this.tables.clear();
  }

  add(connection: Connection): void {
    const connections = this.tables.get(connection.tableId) ?? new Set();
    this.tables.set(connection.tableId, connections);
    const wasConnected = this.connected(connection.tableId).has(connection.userId);
    connections.add(connection);
    connection.socket.on('pong', () => {
      connection.alive = true;
    });
    connection.socket.on('close', () => {
      if (this.stopping) return;
      connections.delete(connection);
      if (!connections.size) this.tables.delete(connection.tableId);
      if (!this.connected(connection.tableId).has(connection.userId)) this.broadcast(connection.tableId);
    });
    if (wasConnected) this.send(connection, this.view(connection.tableId, connection.userId, this.connected(connection.tableId)));
    else this.broadcast(connection.tableId);
  }

  connected(tableId: string): Set<string> {
    return new Set([...(this.tables.get(tableId) ?? [])].map((connection) => connection.userId));
  }

  send(connection: Connection, message: unknown): void {
    if (connection.socket.readyState === connection.socket.OPEN) connection.socket.send(JSON.stringify(message));
  }

  broadcast(tableId: string): void {
    const connected = this.connected(tableId);
    for (const connection of this.tables.get(tableId) ?? []) this.send(connection, this.view(tableId, connection.userId, connected));
  }

  close(predicate: (connection: Connection) => boolean, code: number, reason: string): void {
    for (const connections of this.tables.values()) {
      for (const connection of connections) if (predicate(connection)) connection.socket.close(code, reason);
    }
  }
}
