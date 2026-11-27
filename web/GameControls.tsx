import { useEffect, useId, useRef, useState } from 'react';
import {
  type Action, CHIP_COLORS, type ChipColor, type ChipDenominations, type Command, DEFAULT_CHIP_DENOMINATIONS,
  type LedgerEntry, type LedgerView, MAX_CHIPS, MAX_CORRECTION_REASON, MAX_MINOR, type Options, type SeatView,
  type EntryRequest, type Settings, type Snapshot,
} from '../server/protocol.ts';
import { api } from './api.ts';
import { LABELS } from './History.tsx';
import { Avatar } from './Table.tsx';

interface GameControlsProps {
  snapshot: Snapshot;
  /** True while the socket is reconnecting or signed out: every button is dead and the table shows why. */
  disabled: boolean;
  send: (command: Command) => void;
}

const FIELDS: { key: 'smallBlind' | 'bigBlind' | 'turnSeconds' | 'startingChips' | 'buyInMinor' | 'currency'; label: string; min?: number; max?: number; type: 'number' | 'text' }[] = [
  { key: 'smallBlind', label: 'Small blind', min: 1, type: 'number' },
  { key: 'bigBlind', label: 'Big blind', min: 1, type: 'number' },
  { key: 'turnSeconds', label: 'Turn seconds', min: 10, max: 300, type: 'number' },
  { key: 'startingChips', label: 'Starting chips', min: 1, type: 'number' },
  { key: 'buyInMinor', label: 'Buy-in value (minor units)', min: 0, max: MAX_MINOR, type: 'number' },
  { key: 'currency', label: 'Currency', type: 'text' },
];

const CORRECTION_LABELS = { ...LABELS, rebuy: 'Rebuy' } as Record<LedgerEntry['kind'], string>;

/** Table configuration and settlements are separate from the live action dock. */
export function HostControls({ snapshot, send, disabled }: GameControlsProps) {
  const { game, hand, settings, closed } = snapshot;
  const busy = disabled || hand !== null;
  const denominations = { ...DEFAULT_CHIP_DENOMINATIONS, ...settings.denominations };
  const editable = closed ? { ...denominations } : { ...denominations, white: 1 };
  return (
    <div className="host-panel">
      <EntryRequests snapshot={snapshot} send={send} disabled={disabled} />
      {closed ? <p className="hint">This table is closed. Only the ledger history remains available.</p> : <>
        {game.running && (
          <div className="stop-dealing">
            <p className="hint">Finish the current hand without dealing another.</p>
            <button type="button" className="button" disabled={disabled} onClick={() => send({ type: 'stop' })}>Stop after hand</button>
          </div>
        )}
        {hand && <p className="hint" role="status">{game.running
          ? 'Settings, chip grants, and cash-outs are available between hands.'
          : 'Dealing will stop after this hand. Settings, chip grants, and cash-outs are available between hands.'}</p>}
        <form hidden={hand !== null} key={JSON.stringify(settings)} onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          const number = (key: keyof Settings) => Number(data.get(key));
          send({ type: 'settings', settings: {
            smallBlind: number('smallBlind'), bigBlind: number('bigBlind'),
            turnSeconds: number('turnSeconds'), startingChips: number('startingChips'),
            buyInMinor: number('buyInMinor'), currency: String(data.get('currency')).trim().toUpperCase(),
            denominations: Object.fromEntries(CHIP_COLORS.map((c) => [c, c === 'white' ? 1 : Number(data.get(`denomination-${c}`))])) as ChipDenominations,
          } });
        }}>
          <h3>Table settings</h3>
          <div className="host-fields">
            {FIELDS.map((f) => (
              <div className="host-field" key={f.key === 'currency' ? `${f.key}:${snapshot.currencyLocked}` : f.key}>
                <label htmlFor={`setting-${f.key}`}>{f.label}</label>
                <input id={`setting-${f.key}`} name={f.key} type={f.type}
                  inputMode={f.type === 'number' ? 'numeric' : undefined}
                  min={f.min} max={f.max} maxLength={f.key === 'currency' ? 3 : undefined}
                  disabled={busy} readOnly={f.key === 'currency' && snapshot.currencyLocked} required defaultValue={snapshot.settings[f.key]} />
              </div>
            ))}
          </div>
          {snapshot.currencyLocked && <p className="hint">Currency is locked to {settings.currency} after the first ledger entry.</p>}
          <fieldset className="denominations" disabled={busy}>
            <legend>Chip values (chip units per color)</legend>
            <p className="hint">White is always worth 1 unit. Editing values between hands never revalues existing stacks.</p>
            <div className="host-fields">
              {CHIP_COLORS.map((color) => (
                <div className="host-field" key={color}>
                  <label htmlFor={`setting-denomination-${color}`} className="chip-label">
                    <span className={`chip-dot ${color}`} aria-hidden="true" /> {color}
                  </label>
                  <input id={`setting-denomination-${color}`} name={`denomination-${color}`} type="number" inputMode="numeric"
                    min={1} max={MAX_CHIPS} disabled={busy || color === 'white'} readOnly={color === 'white'}
                    required defaultValue={denominations[color]} aria-label={`Chip value for ${color} chips`} />
                </div>
              ))}
            </div>
          </fieldset>
          <button type="submit" className="button" disabled={busy}>Save settings</button>
        </form>
        {!hand && (
          <>
            <GiveChips snapshot={snapshot} send={send} disabled={disabled} />
            <CashOut snapshot={snapshot} send={send} disabled={disabled} />
            <div className="close-table">
              <p className="hint">Cash out all remaining stacks before closing. History stays available.</p>
              <button type="button" className="button danger" disabled={disabled} onClick={() => send({ type: 'close' })}>Close table</button>
            </div>
          </>
        )}
      </>}
      {!closed && <Corrections snapshot={snapshot} send={send} disabled={busy} editable={editable} />}
    </div>
  );
}

function EntryRequests({ snapshot, send, disabled }: { snapshot: Snapshot; send: GameControlsProps['send']; disabled: boolean }) {
  const { entryRequests: requests, hand, settings } = snapshot;
  if (requests.length === 0) return null;
  return (
    <div className="entry-requests" role="region" aria-label="Pending entry requests">
      <p role="status" aria-live="polite">
        <span className="entry-count" aria-hidden="true">{requests.length}</span>
        <span className="visually-hidden">{requests.length} pending entry request{requests.length === 1 ? '' : 's'}.</span>
        {requests.length === 1 ? 'A player is waiting to buy in.' : 'Players are waiting to buy in.'}
      </p>
      <ul aria-label="Pending entry requests">
        {requests.map((request) => (
          <EntryApproval key={`${request.id}:${settings.currency}:${settings.startingChips}:${settings.buyInMinor}`}
            request={request} settings={settings} send={send} disabled={disabled || hand !== null} />
        ))}
      </ul>
      {requests.some((r) => r.remaining === 0) && snapshot.hand !== null &&
        <p className="hint" role="status">Approvals open between hands.</p>}
    </div>
  );
}

function EntryApproval({ request, settings, send, disabled }: {
  request: EntryRequest; settings: Settings; send: GameControlsProps['send']; disabled: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const ready = request.remaining === 0;
  return (
    <li>
      <span className="entry-player">
        <Avatar name={request.user.name} src={request.user.avatar} />
        <span>{request.user.name} · {ready ? 'ready to enter' : `awaiting rotation (${request.remaining})`}</span>
      </span>
      <form className="entry-approval" onSubmit={(event) => {
        event.preventDefault();
        if (disabled || !ready || !confirmed) return;
        const data = new FormData(event.currentTarget);
        setConfirmed(false);
        send({
          type: 'buyin', userId: request.user.id, requestId: request.id, currency: settings.currency,
          chips: Number(data.get('chips')), amountMinor: Number(data.get('amountMinor')),
        });
      }}>
        {ready && <>
          <IssuanceFields settings={settings} disabled={disabled} onChange={() => setConfirmed(false)} />
          <label className="confirm-row">
            <input type="checkbox" required checked={confirmed} disabled={disabled}
              onChange={(event) => setConfirmed(event.currentTarget.checked)} /> I confirm this entry and chip issuance.
          </label>
        </>}
        <div className="button-row">
          {ready && <button type="submit" className="button primary" disabled={disabled || !confirmed}>Approve</button>}
          <button type="button" className="tool-button" disabled={disabled}
            onClick={() => send({ type: 'decline-entry', requestId: request.id })}>Decline</button>
        </div>
      </form>
    </li>
  );
}

/** Start and resume stay on the table rather than inside the settings dialog. */
export function DealControls({ snapshot, send, disabled }: GameControlsProps) {
  const [dealerChoice, setDealerChoice] = useState('');
  const { game, hand } = snapshot;
  if (game.paused && hand) {
    return <div className="deal-controls">
      <button type="button" className="button primary" disabled={disabled} onClick={() => send({ type: 'resume' })}>Resume hand</button>
    </div>;
  }
  if (hand || game.running) return null;
  const eligible = snapshot.seats.filter((s): s is SeatView => s !== null && s.stack > 0 && !s.away);
  const first = game.dealer === null;
  const picked = eligible.find((seat) => String(seat.seat) === dealerChoice)?.seat;
  if (eligible.length < 2) return <p className="hint deal-controls">Two players with chips are needed to start.</p>;
  return (
    <div className="deal-controls">
      {first && <div className="host-field">
        <label htmlFor="setting-dealer">Initial dealer</label>
        <select id="setting-dealer" disabled={disabled} value={picked === undefined ? '' : dealerChoice}
          onChange={(event) => setDealerChoice(event.target.value)}>
          <option value="">Choose a player</option>
          {eligible.map((s) => <option key={s.seat} value={s.seat}>{s.name} (seat {s.seat})</option>)}
        </select>
      </div>}
      <button type="button" className="button primary" disabled={disabled || (first && picked === undefined)}
        onClick={() => send(picked === undefined ? { type: 'start' } : { type: 'start', dealer: picked })}>Start game</button>
    </div>
  );
}

/** Host grants a fresh stack to a seated player who has no chips, recording the external amount separately. */
function GiveChips({ snapshot, send, disabled }: { snapshot: Snapshot; send: GameControlsProps['send']; disabled: boolean }) {
  const [userId, setUserId] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const { settings, currencyLocked } = snapshot;
  const candidates = snapshot.seats.filter((s): s is SeatView => s !== null && s.stack === 0);
  if (!candidates.length) return null;
  const target = candidates.find((s) => s.userId === userId) ?? candidates[0];
  // The quote covers every term the form submits, so changing settings or the stack invalidates a prior confirmation
  // and remounts the inputs with the current defaults instead of leaving stale amounts behind.
  const quote = `${target.userId}:${target.stack}:${settings.currency}:${settings.startingChips}:${settings.buyInMinor}`;
  const confirmed = confirmation === quote;
  return (
    <form className="give-form" aria-labelledby="give-title" key={quote} onSubmit={(event) => {
      event.preventDefault();
      if (!confirmed || disabled) return;
      const data = new FormData(event.currentTarget);
      setConfirmation('');
      send({
        type: 'buyin', userId: target.userId,
        amountMinor: Number(data.get('amountMinor')), currency: settings.currency,
        chips: Number(data.get('chips')),
      });
    }}>
      <h3 id="give-title">Give chips</h3>
      <p className="hint">Choose a seated player with no chips and confirm the exact stack and the recorded cash separately.</p>
      <div className="host-fields cashout-fields">
        <div className="host-field">
          <label htmlFor="give-user">Player</label>
          <select id="give-user" disabled={disabled} value={target.userId} onChange={(event) => {
            setUserId(event.target.value);
            setConfirmation('');
          }}>
            {candidates.map((s) => <option key={s.userId} value={s.userId}>{s.name}{s.userId === snapshot.hostId ? ' (table master)' : ''} · seat {s.seat}</option>)}
          </select>
        </div>
        <IssuanceFields settings={settings} disabled={disabled} onChange={() => setConfirmation('')} />
      </div>
      <p className="hint">Poker Night records settlements but never moves money{currencyLocked ? `; currency is locked to ${settings.currency}` : ''}.</p>
      <label className="confirm-row">
        <input type="checkbox" required disabled={disabled} checked={confirmed}
          onChange={(event) => setConfirmation(event.target.checked ? quote : '')} /> I confirm this external chip issuance.
      </label>
      <button type="submit" className="button primary" disabled={disabled || !confirmed}>Give chips</button>
    </form>
  );
}

function IssuanceFields({ settings, disabled, onChange }: { settings: Settings; disabled: boolean; onChange: () => void }) {
  const id = useId();
  return (
    <>
      <div className="host-field">
        <label htmlFor={`${id}-chips`}>Chips (chip units)</label>
        <input id={`${id}-chips`} name="chips" type="number" inputMode="numeric" min={1} max={MAX_CHIPS}
          disabled={disabled} required defaultValue={settings.startingChips} onChange={onChange} />
      </div>
      <div className="host-field">
        <label htmlFor={`${id}-amount`}>Recorded cash ({settings.currency} minor units)</label>
        <input id={`${id}-amount`} name="amountMinor" type="number" inputMode="numeric" min={0} max={MAX_MINOR}
          disabled={disabled} required defaultValue={settings.buyInMinor} onChange={onChange} />
      </div>
    </>
  );
}

interface CorrectionDraft {
  entryId: number;
  kind: 'amount' | 'void';
  amountMinor: number;
  chips: number;
  reason: string;
}

/** Host repairs an earlier settlement record; originals stay, reasons and actor are kept. */
function Corrections({ snapshot, send, disabled, editable }: {
  snapshot: Snapshot; send: GameControlsProps['send']; disabled: boolean; editable: ChipDenominations;
}) {
  const { tableId, hand, version } = snapshot;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<CorrectionDraft | null>(null);
  const [view, setView] = useState<LedgerView | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const record = view?.entries.find((entry) => entry.id === draft?.entryId);
  const journalVersion = hand === null ? version : null;

  useEffect(() => {
    if (!open || journalVersion === null) return;
    let current = true;
    setLoading(true);
    const query = before === null ? '' : `?before=${before}`;
    api<LedgerView>(`/api/history/${tableId}${query}`).then((result) => {
      if (!current) return;
      setView(result);
      setError('');
    }).catch((reason: Error) => {
      if (current) setError(reason.message);
    }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [open, before, journalVersion, tableId]);

  const blocked = disabled || loading;
  const stale = record?.superseded === true || record?.correction?.voided === true;
  const canSubmit = draft && record && !blocked && confirmed && !stale && draft.reason.trim().length > 0
    && (draft.kind === 'void' || draft.amountMinor !== record.amountMinor || draft.chips !== (record.kind === 'cash-out' ? 0 : record.chips));

  return (
    <details className="corrections" onToggle={(event) => {
      if (event.currentTarget.open) setBefore(null);
      setOpen(event.currentTarget.open);
    }}>
      <summary>Correct the settlement ledger</summary>
      {error && <p className="notice" role="alert">{error} <button type="button" className="link-button" onClick={() => setError('')}>Dismiss</button></p>}
      {loading && view === null && <p className="status-line" role="status">Loading ledger…</p>}
      {view && <p className="hint">Records stay as they are; corrections append and keep the original visible.</p>}
      {view && (
        <ol className="journal correction-list">
          {view.entries.map((entry) => {
            const eligible = !entry.superseded && !entry.correction?.voided;
            return (
              <li key={entry.id} className={entry.superseded ? 'superseded' : undefined}>
                <b>{CORRECTION_LABELS[entry.kind]} · {entry.amountMinor} {entry.currency} minor units</b>
                <span>{entry.name} · {entry.chips} chips · {entry.correction ? `Corrected entry (originally #${entry.correction.entryId})${entry.correction.voided ? ' · voided' : ''}: ${entry.correction.reason}` : ''}{entry.superseded ? ' · superseded' : ''}</span>
                {eligible && (
                  <div className="button-row">
                    <button type="button" className="tool-button" disabled={blocked}
                      onClick={() => { setDraft({ entryId: entry.id, kind: 'amount', amountMinor: entry.amountMinor, chips: entry.kind === 'cash-out' ? 0 : entry.chips, reason: '' }); setConfirmed(false); }}>
                      Correct this record
                    </button>
                    {entry.chipCorrectionAvailable && (
                      <button type="button" className="tool-button" disabled={blocked}
                        onClick={() => { setDraft({ entryId: entry.id, kind: 'void', amountMinor: 0, chips: 0, reason: '' }); setConfirmed(false); }}>
                        Void (wrong seat)
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {view?.next != null && <button type="button" className="button" disabled={blocked} onClick={() => { setDraft(null); setBefore(view.next); }}>Older entries</button>}
      {before !== null && <button type="button" className="button" disabled={blocked} onClick={() => { setDraft(null); setBefore(null); }}>Latest entries</button>}
      {draft && record && (
        <form className="correction-form" aria-label="Confirm ledger correction" onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          send({ type: 'correct-ledger', entryId: draft.entryId, amountMinor: draft.amountMinor, chips: draft.chips, reason: draft.reason.trim() });
          setDraft(null);
          setConfirmed(false);
          setBefore(null);
        }}>
          <h4>{draft.kind === 'void' ? 'Void this record' : `Correct ${CORRECTION_LABELS[record.kind]}`}</h4>
          <p className="hint">Record #{record.id} · {record.name} · currently {record.amountMinor} {record.currency} minor units and {record.chips} chips.</p>
          {stale && <p className="notice" role="alert">This receipt is no longer current. Pick the latest non-void entry.</p>}
          {draft.kind === 'void' ? (
            <p className="hint">Voids this issuance and returns its chips to zero for the wrong seat. The record stays visible.</p>
          ) : (
            <div className="host-fields cashout-fields">
              <div className="host-field">
                <label htmlFor="correction-amount">Recorded cash (minor units)</label>
                <input id="correction-amount" type="number" inputMode="numeric" min={0} max={MAX_MINOR} disabled={blocked || stale}
                  required value={draft.amountMinor} onChange={(e) => { setDraft({ ...draft, amountMinor: Number(e.currentTarget.value) }); setConfirmed(false); }} />
              </div>
              {record.chipCorrectionAvailable && (
                <div className="host-field">
                  <label htmlFor="correction-chips">Chips (chip units)</label>
                  <input id="correction-chips" type="number" inputMode="numeric" min={1} max={MAX_CHIPS} disabled={blocked || stale}
                    required value={draft.chips} onChange={(e) => { setDraft({ ...draft, chips: Number(e.currentTarget.value) }); setConfirmed(false); }} />
                </div>
              )}
            </div>
          )}
          {record.chipCorrectionAvailable && draft.kind === 'amount' && (
            <p className="hint">Chips {record.chips} → {draft.chips}; denomination values today: {CHIP_COLORS.map((c) => `${c} ${editable[c]}`).join(', ')}.</p>
          )}
          <div className="host-field">
            <label htmlFor="correction-reason">Reason (required, shown in the ledger)</label>
            <input id="correction-reason" type="text" maxLength={MAX_CORRECTION_REASON} disabled={blocked || stale} required
              value={draft.reason} onChange={(e) => { setDraft({ ...draft, reason: e.currentTarget.value }); setConfirmed(false); }} />
          </div>
          <label className="confirm-row">
            <input type="checkbox" disabled={blocked || stale} checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this correction.
          </label>
          <div className="button-row">
            <button type="submit" className="button danger" disabled={!canSubmit}>Record correction</button>
            <button type="button" className="tool-button" onClick={() => { setDraft(null); setConfirmed(false); }}>Cancel</button>
          </div>
        </form>
      )}
    </details>
  );
}

/** Public chip values legend: every seat's stack in chip units plus the editable denomination reference. */
export function ChipLegend({ snapshot, editable }: { snapshot: Snapshot; editable: ChipDenominations }) {
  const seated = snapshot.seats.filter((s): s is SeatView => s !== null && s.stack > 0);
  if (!seated.length) return null;
  return (
    <details className="chip-legend">
      <summary>Chip values</summary>
      <p className="hint">One white chip equals 1 unit. Chip values apply to future stacks only.</p>
      <ul className="chip-values">
        {CHIP_COLORS.map((color) => <li key={color}><span className={`chip-dot ${color}`} aria-hidden="true" /> {color}: {editable[color]}</li>)}
      </ul>
      <table className="ledger-totals">
        <caption className="visually-hidden">Chip stacks in chip units</caption>
        <thead><tr><th scope="col">Player</th><th scope="col">Chips</th></tr></thead>
        <tbody>{seated.map((s) => (
          <tr key={s.userId}><th scope="row">{s.name}</th><td>{s.stack.toLocaleString()}</td></tr>
        ))}</tbody>
      </table>
    </details>
  );
}

/** Host-confirmed external settlement: quotes the selected player's exact stack and currency, checkbox-gated. */
function CashOut({ snapshot, send, disabled }: { snapshot: Snapshot; send: GameControlsProps['send']; disabled: boolean }) {
  const [userId, setUserId] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const { settings, currencyLocked } = snapshot;
  const funded = snapshot.seats.filter((s): s is SeatView => s !== null && s.stack > 0);
  const target = funded.find((seat) => seat.userId === userId) ?? funded[0];
  if (!target) return null;
  const quote = `${target.userId}:${target.stack}:${settings.currency}`;
  const confirmed = confirmation === quote;
  return (
    <form className="cashout-form" aria-labelledby="cashout-title" onSubmit={(event) => {
      event.preventDefault();
      if (!confirmed || disabled) return;
      const amountMinor = Number(new FormData(event.currentTarget).get('amountMinor'));
      setConfirmation('');
      send({ type: 'cashout', userId: target.userId, amountMinor, currency: settings.currency, chips: target.stack });
    }}>
      <h3 id="cashout-title">Cash out</h3>
      <p className="hint">Cash-outs are external settlements between players. Poker Night never moves money.</p>
      <div className="host-fields cashout-fields">
        <div className="host-field">
          <label htmlFor="cashout-user">Player cashing out</label>
          <select id="cashout-user" disabled={disabled} value={target.userId} onChange={(event) => {
            setUserId(event.target.value);
            setConfirmation('');
          }}>
            {funded.map((seat) => <option key={seat.userId} value={seat.userId}>{seat.name} · {seat.stack} chips</option>)}
          </select>
        </div>
        <div className="host-field">
          <label htmlFor="cashout-amount">Cash-out amount (minor units)</label>
          <input id="cashout-amount" name="amountMinor" type="number" inputMode="numeric" min={0} max={MAX_MINOR}
            disabled={disabled} required defaultValue={0} onChange={() => setConfirmation('')} />
        </div>
      </div>
      <p className="hint">{target.name}: {target.stack} chips. Record cash separately in {settings.currency} minor units{currencyLocked ? ' (locked)' : ''}.</p>
      <label className="confirm-row">
        <input type="checkbox" required disabled={disabled} checked={confirmed}
          onChange={(event) => setConfirmation(event.target.checked ? quote : '')} /> I confirm this external cash-out.
      </label>
      <button type="submit" className="button danger" disabled={disabled || !confirmed}>Record cash-out</button>
    </form>
  );
}

function BettingActions({ hand, options, stack, disabled, send }: {
  hand: NonNullable<Snapshot['hand']>;
  options: Options;
  stack: number;
  disabled: boolean;
  send: GameControlsProps['send'];
}) {
  const sizing = options.raise;
  const [amount, setAmount] = useState(sizing ? String(sizing.min) : '');
  const [editing, setEditing] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const editorId = useId();
  const rangeId = `${editorId}-range`;
  const chips = Number(amount);
  const valid = sizing && Number.isSafeInteger(chips) && chips >= sizing.min && chips <= sizing.max;
  const sizeLabel = sizing?.kind === 'bet' ? 'Bet' : 'Raise';
  const close = () => {
    setEditing(false);
    setAmount(sizing ? String(sizing.min) : '');
    toggle.current?.focus();
  };
  const act = (action: Action, chips?: number) => send({
    type: 'act', handId: hand.id, turn: hand.turn, action, ...(chips === undefined ? {} : { amount: chips }),
  });
  return (
    <>
      <div className="action-row" role="group" aria-label="Betting actions">
        {options.fold && <button type="button" className="button" disabled={disabled} onClick={() => act('fold')}>Fold</button>}
        {options.check && <button type="button" className="button primary" disabled={disabled} onClick={() => act('check')}>Check</button>}
        {options.call > 0 && <button type="button" className="button primary" disabled={disabled} onClick={() => act('call')}>Call {options.call}</button>}
        {sizing ? (
          <button ref={toggle} type="button" className="button" disabled={disabled} aria-expanded={editing}
            aria-controls={editing ? editorId : undefined} onClick={editing ? close : () => setEditing(true)}>{sizeLabel}</button>
        ) : stack > 0 && options.call === stack && (
          <button type="button" className="button" disabled={disabled} onClick={() => act('allin')}>All-in</button>
        )}
      </div>
      {editing && sizing && (
        <form id={editorId} className="bet-editor" aria-label={`${sizeLabel} amount`} onSubmit={(event) => {
          event.preventDefault();
          if (!disabled && valid) act(sizing.kind, chips);
        }} onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            close();
          }
        }}>
          <div className="bet-field">
            <label htmlFor={`${editorId}-amount`}>{sizing.kind === 'bet' ? 'Bet' : 'Raise to'}</label>
            <input id={`${editorId}-amount`} aria-describedby={rangeId} type="number" inputMode="numeric"
              min={sizing.min} max={sizing.max} required value={amount} autoFocus
              onFocus={(event) => event.currentTarget.select()} onChange={(event) => setAmount(event.target.value)} disabled={disabled} />
            <span id={rangeId} className="hint">{sizing.min}–{sizing.max} chips</span>
          </div>
          <div className="button-row">
            <button type="submit" className="button primary" disabled={disabled || !valid}>Confirm {sizeLabel.toLowerCase()}</button>
            <button type="button" className="button danger" disabled={disabled} onClick={() => act('allin')}>All-in</button>
            <button type="button" className="tool-button" onClick={close}>Cancel</button>
          </div>
        </form>
      )}
    </>
  );
}

function PlayerControls({ snapshot, send, disabled }: GameControlsProps) {
  const { hand, you, seats, settings } = snapshot;
  const me = seats[you.seat - 1];
  if (!me) return null;
  const funded = me.stack > 0;
  if (hand && !you.options && !me.away) return null;
  return (
    <section className="player-controls" aria-label={hand ? 'Your actions' : 'Your seat'}>
      {hand && you.options ? (
        <BettingActions key={`${hand.id}:${hand.turn}`} hand={hand} options={you.options} stack={me.stack} disabled={disabled} send={send} />
      ) : !hand && !funded ? (
        <p className="waiting-buyin">
          {you.boughtIn ? 'You are out of chips. The table master can give you chips between hands.' :
            `Waiting for the table master to give you chips. Terms: ${settings.startingChips} chips · ${settings.buyInMinor} ${settings.currency} minor units.`}
        </p>
      ) : !hand ? <p>{me.away ? 'Sitting out' : 'Ready to play'} <span aria-hidden="true">·</span> {me.stack.toLocaleString()} chips</p> : null}
      <div className="button-row">
        {!hand && !funded && me.userId !== snapshot.hostId &&
          <button type="button" className="button" disabled={disabled} onClick={() => send({ type: 'leave' })}>Leave</button>}
        {me.away && <button type="button" className="button" disabled={disabled} onClick={() => send({ type: 'back' })}>Back</button>}
      </div>
    </section>
  );
}

export function GameControls({ snapshot, disabled, send }: GameControlsProps) {
  const paused = snapshot.hand !== null && snapshot.game.paused;
  if (snapshot.closed) {
    return (
      <section className="player-controls" aria-labelledby="closed-title">
        <h3 id="closed-title">Table closed</h3>
        <p className="status-line">The host closed this table. No more hands can be dealt.</p>
      </section>
    );
  }
  if (paused) return null;
  return <PlayerControls snapshot={snapshot} send={send} disabled={disabled} />;
}
