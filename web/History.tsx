import { useEffect, useState } from 'react';
import type { HistoryTable, LedgerView } from '../server/protocol.ts';
import { api } from './api.ts';
import { BotPost } from './BotPost.tsx';
import { HandResult } from './Table.tsx';

type Navigate = (path: string) => void;

export function HistoryIndex({ navigate }: { navigate: Navigate }) {
  const [tables, setTables] = useState<HistoryTable[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    api<{ tables: HistoryTable[] }>('/api/history').then(({ tables: result }) => {
      if (active) setTables(result);
    }).catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, []);
  return (
    <section className="panel" aria-labelledby="history-title">
      <h2 id="history-title">Table history</h2>
      {error ? <p role="alert">{error}</p> : !tables ? <p>Loading table history…</p> : !tables.length ? <p>No table history yet.</p> : (
        <ul className="table-list">
          {tables.map((table) => <li key={table.id}>
            <a href={`/history/${table.id}`} onClick={(event) => { event.preventDefault(); navigate(`/history/${table.id}`); }}>
              {table.hostName}’s table
            </a>
            <span>{table.closed ? 'Closed' : 'Open'}</span>
          </li>)}
        </ul>
      )}
    </section>
  );
}

export const LABELS = { 'buy-in': 'Buy-in', rebuy: 'Rebuy', 'cash-out': 'Cash-out' };

export function History({ tableId, navigate }: { tableId: string; navigate: Navigate }) {
  const [record, setRecord] = useState<LedgerView | null>(null);
  const [error, setError] = useState('');
  const [before, setBefore] = useState<number | null>(null);
  const [beforeHand, setBeforeHand] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    const query = new URLSearchParams();
    if (before !== null) query.set('before', String(before));
    if (beforeHand !== null) query.set('beforeHand', String(beforeHand));
    api<LedgerView>(`/api/history/${tableId}?${query}`).then((result) => {
      if (active) setRecord(result);
    }).catch((reason: Error) => { if (active) setError(reason.message); });
    return () => { active = false; };
  }, [tableId, before, beforeHand]);

  return (
    <>
      <a className="button" href="/history" onClick={(event) => { event.preventDefault(); navigate('/history'); }}>All table history</a>
      {error ? <p className="notice" role="alert">{error}</p> : !record ? <p role="status">Loading ledger and hand history…</p> : (
        <>
          <section className="panel" aria-labelledby="ledger-title">
            <h2 id="ledger-title">Settlement ledger</h2>
            <p>{record.hostName}’s table · {record.closed ? 'Closed' : 'Open'}. {record.host ? 'All player records.' : 'Only your cash records.'}</p>
            <p>External settlements in integer minor units. No payments are made by Poker Night.</p>
            {record.totals.length > 0 ? <table className="ledger-totals">
              <caption className="visually-hidden">Cash totals in minor units</caption>
              <thead><tr><th scope="col">Player</th><th scope="col">In</th><th scope="col">Out</th><th scope="col">Net</th></tr></thead>
              <tbody>{record.totals.map((row) => <tr key={row.userId}>
                <th scope="row">{row.name} · {row.currency}</th>
                <td>{row.inMinor}</td><td>{row.outMinor}</td><td>{row.netMinor}</td>
              </tr>)}</tbody>
            </table> : <p>No settlements recorded.</p>}
            {record.host && record.botPosts && record.totals.length > 0 && <BotPost tableId={tableId} type="settlement" />}
          </section>
          <section className="panel" aria-labelledby="journal-title">
            <h2 id="journal-title">Journal</h2>
            {record.entries.length ? <ol className="journal">
              {record.entries.map((row) => <li key={row.id} className={row.superseded ? 'superseded' : undefined}>
                <b>{LABELS[row.kind]} · {row.amountMinor} {row.currency} minor units</b>
                <span>
                  {row.name} · {row.chips} chips · Recorded by {row.actorName}
                  {row.correction && ` · ${row.correction.voided ? 'Voided' : 'Corrected'} entry (originally #${row.correction.entryId}): ${row.correction.reason}`}
                  {row.superseded && ' · superseded'}
                </span>
                <time dateTime={new Date(row.createdAt).toISOString()}>{new Date(row.createdAt).toLocaleString()}</time>
              </li>)}
            </ol> : <p>No journal entries.</p>}
            <div className="button-row">
              {record.next !== null && <button type="button" className="button" onClick={() => setBefore(record.next)}>Older entries</button>}
              {before !== null && <button type="button" className="button" onClick={() => setBefore(null)}>Latest entries</button>}
            </div>
          </section>
          <section className="panel" aria-labelledby="hands-title">
            <h2 id="hands-title">Completed hands</h2>
            {record.hands.length ? record.hands.map((hand) => <details key={hand.id}>
              <summary>Hand {hand.id} · {new Date(hand.endedAt).toLocaleString()}</summary>
              <HandResult last={hand} />
            </details>) : <p>No completed hands recorded.</p>}
            <div className="button-row">
              {record.nextHand !== null && <button type="button" className="button" onClick={() => setBeforeHand(record.nextHand)}>Older hands</button>}
              {beforeHand !== null && <button type="button" className="button" onClick={() => setBeforeHand(null)}>Latest hands</button>}
            </div>
          </section>
        </>
      )}
    </>
  );
}
