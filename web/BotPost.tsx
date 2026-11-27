import { useRef, useState } from 'react';
import type { NotificationRequest, NotificationResult } from '../server/protocol.ts';
import { api, ApiError, newCommandId } from './api.ts';

type BotPostRequest = Omit<Extract<NotificationRequest, { type: 'invite' }>, 'id'> | { type: 'settlement' };

/** Host-requested Fluxer post, one command ID per distinct request; retrying polls the same post's status. */
export function BotPost({ tableId, ...post }: { tableId: string } & BotPostRequest) {
  const id = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const send = async () => {
    id.current ??= newCommandId();
    setBusy(true);
    try {
      const body: NotificationRequest = { ...post, id: id.current };
      const { status } = await api<NotificationResult>(`/api/tables/${tableId}/notifications`, body);
      if (status === 'sent') setMessage('Posted to the configured Fluxer channel.');
      else if (status === 'pending') setMessage('Post is still in progress. Check its status.');
      else setMessage('Delivery was not confirmed. Check the Fluxer channel before posting again.');
      if (status !== 'pending') id.current = null;
    } catch (error) {
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) id.current = null;
      setMessage(error instanceof Error ? error.message : 'Could not confirm delivery.');
    } finally {
      setBusy(false);
    }
  };
  return <div className="bot-post">
    <p className="hint">Posts {post.type === 'invite' ? 'the invite link' : 'aggregate cash totals (no names or cards)'} to the operator’s configured Fluxer channel.</p>
    <button type="button" className="button" disabled={busy} onClick={() => void send()}>
      {id.current && !busy ? 'Check post status' : post.type === 'invite' ? 'Post invite to Fluxer' : 'Post settlement summary to Fluxer'}
    </button>
    {message && <p className="status-line" role="status">{message}</p>}
  </div>;
}
