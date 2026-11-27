import { useCallback, useEffect, useRef, useState } from 'react';
import { PROTOCOL_VERSION, type Command, type CommandMessage, type ServerMessage, type Snapshot } from '../server/protocol.ts';
import { api, ApiError, newCommandId } from './api.ts';

export type Connection = 'connecting' | 'live' | 'reconnecting' | 'signed-out' | 'not-member' | 'not-found' | 'left';

const WATCHDOG_MS = 60_000;
const ACK_TIMEOUT_MS = 15_000;
const RELOAD_FLAG = 'pokerbot-protocol-reload';

interface Pending {
  message: CommandMessage;
  version: number;
}

/**
 * One socket per tab. HTTP preflight identifies terminal authorization failures. Only the fresh socket
 * snapshot enables commands or allows retrying a single unacknowledged command against the same state.
 */
export function useTableSocket(tableId: string) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [error, setError] = useState('');
  const clockOffset = useRef(0);
  const [busy, setBusy] = useState(false);
  const sender = useRef<((command: Command) => void) | undefined>(undefined);
  const send = useCallback((command: Command) => sender.current?.(command), []);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let pending: Pending | undefined;
    let current: Snapshot | undefined;
    let attempt = 0;
    let retry: number | undefined;
    let watchdog: number | undefined;
    let ackTimer: number | undefined;
    let stopped = false;

    const clearPending = () => {
      pending = undefined;
      clearTimeout(ackTimer);
      setBusy(false);
    };

    const accept = (next: Snapshot, fresh: boolean): boolean => {
      if (next.v !== PROTOCOL_VERSION) {
        // The server was upgraded under this tab; load the matching client once.
        if (!sessionStorage.getItem(RELOAD_FLAG)) {
          sessionStorage.setItem(RELOAD_FLAG, '1');
          location.reload();
        } else {
          setError('This page does not match the server version. Reload to continue.');
        }
        return false;
      }
      if (!fresh && current && current.version > next.version) return false;
      sessionStorage.removeItem(RELOAD_FLAG);
      clockOffset.current = next.serverNow - Date.now();
      current = next;
      setSnapshot(next);
      return true;
    };

    const transmit = (ws: WebSocket, packet: CommandMessage) => {
      ws.send(JSON.stringify(packet));
      clearTimeout(ackTimer);
      ackTimer = window.setTimeout(() => ws.close(4000, 'No command acknowledgement'), ACK_TIMEOUT_MS);
    };

    const schedule = () => {
      if (stopped) return;
      setConnection((current) => (current === 'live' || current === 'connecting' ? 'reconnecting' : current));
      const delay = Math.min(30_000, 500 * 2 ** attempt) * (0.5 + Math.random() / 2);
      attempt += 1;
      retry = window.setTimeout(() => void open(), delay);
    };

    const open = async () => {
      try {
        const initial = await api<Snapshot>(`/api/tables/${tableId}`);
        if (!stopped && !current) accept(initial, true);
      } catch (e) {
        if (stopped) return;
        if (e instanceof ApiError && e.status === 401) return setConnection('signed-out');
        if (e instanceof ApiError && e.code === 'not-member') return setConnection('not-member');
        if (e instanceof ApiError && e.status === 404) return setConnection('not-found');
        return schedule();
      }
      if (stopped) return;
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/tables/${tableId}`);
      socket = ws;
      let ready = false;
      const resetWatchdog = () => {
        clearTimeout(watchdog);
        watchdog = window.setTimeout(() => ws.close(4000, 'No heartbeat'), WATCHDOG_MS);
      };
      ws.onopen = () => {
        if (stopped) return;
        resetWatchdog();
      };
      ws.onmessage = (event) => {
        if (stopped) return;
        resetWatchdog();
        const message = JSON.parse(String(event.data)) as ServerMessage;
        switch (message.type) {
          case 'snapshot': {
            if (!accept(message, !ready) || ready) return;
            ready = true;
            attempt = 0;
            setConnection('live');
            if (pending) {
              const command = pending.message.command;
              const sameTarget = command.type === 'act'
                ? !message.game.paused && message.hand?.id === command.handId && message.hand.turn === command.turn
                : message.version === pending.version;
              if (sameTarget) transmit(ws, pending.message);
              else {
                clearPending();
                setError('The table changed before the command was acknowledged. Check the current state before acting.');
              }
            }
            break;
          }
          case 'tick':
            clockOffset.current = message.serverNow - Date.now();
            break;
          case 'ack':
            if (message.id !== pending?.message.id) return;
            clearPending();
            if (!message.ok) setError(message.error);
            break;
          case 'error':
            clearPending();
            setError(message.error);
            break;
          default: {
            const unexpected: never = message;
            void unexpected;
          }
        }
      };
      ws.onclose = (event) => {
        clearTimeout(watchdog);
        clearTimeout(ackTimer);
        if (socket !== ws || stopped) return;
        if (event.code === 4001) return setConnection('signed-out');
        if (event.code === 4003) return setConnection('not-member');
        if (event.code === 4004) {
          clearPending();
          return setConnection('left');
        }
        schedule();
      };
      sender.current = (command) => {
        if (!ready || stopped || !current || socket !== ws || ws.readyState !== WebSocket.OPEN || pending) return;
        const message: CommandMessage = { v: PROTOCOL_VERSION, type: 'command', id: newCommandId(), command };
        pending = { version: current.version, message };
        setError('');
        setBusy(true);
        transmit(ws, message);
      };
    };

    void open();
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearTimeout(watchdog);
      clearTimeout(ackTimer);
      sender.current = undefined;
      socket?.close(1000, 'Leaving table');
    };
  }, [tableId]);

  return { snapshot, connection, error, clockOffset, busy, send };
}
