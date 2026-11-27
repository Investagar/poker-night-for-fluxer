import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_CHIP_DENOMINATIONS, type EntryStatus, type TableSummary, type User } from '../server/protocol.ts';
import { api, ApiError } from './api.ts';
import { useTableSocket } from './socket.ts';
import { ChipLegend, DealControls, GameControls, HostControls } from './GameControls.tsx';
import { Avatar, TableView } from './Table.tsx';
import { BotPost } from './BotPost.tsx';
import { History, HistoryIndex } from './History.tsx';

type Route =
  | { name: 'home' }
  | { name: 'table'; tableId: string; manage: boolean }
  | { name: 'join'; tableId: string; manage: false }
  | { name: 'history' }
  | { name: 'history-table'; tableId: string };

type AuthState = 'loading' | 'signed-in' | 'signed-out' | 'not-member';

const PENDING_INVITE = 'pokerbot-invite';
/** Remembers a bot-managed table link across the sign-in redirect (fragment only, never leaves this tab). */
const PENDING_MASTER = 'pokerbot-manage';
const TABLE_ID = /^[\w-]{22}$/;

function parseRoute(pathname: string): Route {
  const [, kind, id] = pathname.split('/');
  if ((kind === 'tables' || kind === 'join') && id && TABLE_ID.test(id)) {
    if (kind === 'tables') return { name: 'table', tableId: id, manage: pathname.endsWith('/manage') };
    return { name: 'join', tableId: id, manage: false };
  }
  if (kind === 'history') return id && TABLE_ID.test(id) ? { name: 'history-table', tableId: id } : { name: 'history' };
  return { name: 'home' };
}

const AUTH_NOTICES: Record<string, string> = {
  expired: 'That sign-in attempt expired. Please try again.',
  cancelled: 'Sign-in was cancelled.',
  bot: 'Bot and system accounts cannot join a table.',
  busy: 'Sign-in is busy right now. Try again in a minute.',
  'fluxer-unavailable': 'Fluxer is unavailable right now. Try again shortly.',
  'signin-failed': 'Fluxer could not complete sign-in. Please try again.',
};

const inviteKey = (tableId: string) => `pokerbot-invite-link:${tableId}`;

/** Remembers the host's current invite link on this device; the server keeps only its hash. */
function saveInvite(tableId: string, token: string): string {
  const url = `${location.origin}/join/${tableId}#${token}`;
  localStorage.setItem(inviteKey(tableId), url);
  return url;
}

function readPending(): { tableId: string; token: string } | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(PENDING_INVITE) ?? 'null');
    return value && TABLE_ID.test(value.tableId) && typeof value.token === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** The bot's own-table manage link survives the OAuth redirect inside this tab; it names only this table. */
function readPendingMaster(): string | null {
  try {
    const value = sessionStorage.getItem(PENDING_MASTER);
    return value && TABLE_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));
  const [user, setUser] = useState<User | null>(null);
  const [auth, setAuth] = useState<AuthState>('loading');
  const [notice, setNotice] = useState('');
  /** Bot-managed table link pending sign-in; consumed once the host table loads. */
  const [manageIntent, setManageIntent] = useState<string | null>(() => {
    const initial = parseRoute(location.pathname);
    if (initial.name === 'table' && initial.manage) return initial.tableId;
    return readPendingMaster();
  });
  const main = useRef<HTMLElement>(null);
  const previousRoute = useRef(route);

  const navigate = useCallback((path: string) => {
    history.pushState(null, '', path);
    setRoute(parseRoute(path));
  }, []);

  useEffect(() => {
    if (previousRoute.current === route) return;
    previousRoute.current = route;
    main.current?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [route]);

  useEffect(() => {
    // The invite token lives only in the fragment; keep it in this tab and take it out of the address bar.
    const initial = parseRoute(location.pathname);
    const token = location.hash.slice(1);
    if (initial.name === 'join' && token) {
      sessionStorage.setItem(PENDING_INVITE, JSON.stringify({ tableId: initial.tableId, token }));
      history.replaceState(null, '', `/join/${initial.tableId}`);
    }
    // Keep a bot-managed table link across the sign-in redirect, then clean the address bar.
    if (initial.name === 'table' && initial.manage) {
      sessionStorage.setItem(PENDING_MASTER, initial.tableId);
      history.replaceState(null, '', `/tables/${initial.tableId}`);
    }
    const params = new URLSearchParams(location.search);
    const state = params.get('auth');
    if (state === 'not-member') setAuth('not-member');
    else if (state) setNotice(AUTH_NOTICES[state] ?? AUTH_NOTICES['signin-failed']);
    if (state) history.replaceState(null, '', location.pathname);

    const onPop = () => setRoute(parseRoute(location.pathname));
    addEventListener('popstate', onPop);
    if (state !== 'not-member') {
      api<{ user: User }>('/api/session')
        .then(({ user: me }) => {
          setUser(me);
          setAuth('signed-in');
          const pending = readPending();
          if (pending && parseRoute(location.pathname).name !== 'join') {
            navigate(`/join/${pending.tableId}`);
          } else if (readPendingMaster() && parseRoute(location.pathname).name !== 'table') {
            navigate(`/tables/${readPendingMaster()}/manage`);
          }
        })
        .catch((e) => {
          setAuth(e instanceof ApiError && e.code === 'not-member' ? 'not-member' : 'signed-out');
          if (e instanceof ApiError && e.status !== 401 && e.status !== 403) setNotice(e.message);
        });
    }
    return () => removeEventListener('popstate', onPop);
  }, [navigate]);

  const lostSession = useCallback((state: 'signed-out' | 'not-member') => {
    setUser(null);
    setAuth(state);
  }, []);

  const signOut = async () => {
    try {
      await api('/auth/logout', {});
      setUser(null);
      setAuth('signed-out');
      navigate('/');
    } catch (e) {
      setNotice((e as Error).message);
    }
  };

  const signedIn = auth === 'signed-in' && user !== null;
  const atTable = signedIn && route.name === 'table';
  const title = (
    <h1><a href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>
      <span className="brand-mark" aria-hidden="true">♠</span> Poker Night
    </a></h1>
  );
  return (
    <div className={`app-shell${signedIn ? ' signed-in' : ''}${atTable ? ' table-screen' : ''}`}>
      <header className="app-header">
        {signedIn ? (
          <>
            <div className="masthead">
              {title}
              <div className="account">
                <Avatar name={user.name} src={user.avatar} />
                <span className="account-name">{user.name}</span>
                <button type="button" className="link-button" onClick={signOut}>Sign out</button>
              </div>
            </div>
            {!atTable && (
              <nav className="app-nav" aria-label="Poker Night">
                <a href="/" aria-current={route.name === 'home' ? 'page' : undefined}
                  onClick={(e) => { e.preventDefault(); navigate('/'); }}>Your tables</a>
                <a href="/history" aria-current={route.name === 'history' ? 'page' : undefined}
                  onClick={(e) => { e.preventDefault(); navigate('/history'); }}>Table history</a>
              </nav>
            )}
          </>
        ) : (
          <>
            <p className="eyebrow">The card room <span> / </span> Fluxer</p>
            {title}
            <p className="intro">A private table for Texas Hold’em with friends.</p>
          </>
        )}
      </header>
      <main ref={main} tabIndex={-1}>
        {notice && <p className="notice" role="alert">{notice} <button type="button" className="link-button" onClick={() => setNotice('')}>Dismiss</button></p>}
        {auth === 'loading' ? <p className="status-line" role="status">Checking your sign-in…</p>
          : auth === 'not-member' ? <NotMember />
          : !signedIn ? <SignedOut joining={route.name === 'join' || readPending() !== null} />
          : route.name === 'join' ? <Join key={route.tableId} tableId={route.tableId} navigate={navigate} onSignedOut={lostSession} />
          : route.name === 'history' ? <HistoryIndex navigate={navigate} />
          : route.name === 'history-table' ? <History key={route.tableId} tableId={route.tableId} navigate={navigate} />
          : route.name === 'table' ? <Table key={route.tableId} tableId={route.tableId} user={user} navigate={navigate} onSignedOut={lostSession}
            autoOpenMaster={manageIntent === route.tableId} />
          : <Home navigate={navigate} />}
      </main>
    </div>
  );
}

function SignedOut({ joining }: { joining: boolean }) {
  return (
    <section className="panel" aria-labelledby="signin-title">
      <h2 id="signin-title">{joining ? 'Sign in to take your seat' : 'Sign in to play'}</h2>
      <p>Poker Night is open to members of the community. Sign in with your Fluxer account to {joining ? 'join this table' : 'host or join a table'}.</p>
      <a className="button primary" href="/auth/login">Sign in with Fluxer</a>
    </section>
  );
}

function NotMember() {
  return (
    <section className="panel" aria-labelledby="member-title">
      <h2 id="member-title">Join the community first</h2>
      <p>Your Fluxer account is not a member of this table’s community. Ask the host for a community invite, join it in Fluxer, then sign in again.</p>
      <a className="button" href="/auth/login">Sign in again</a>
    </section>
  );
}

function Home({ navigate }: { navigate: (path: string) => void }) {
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ tables: TableSummary[] }>('/api/tables').then((r) => setTables(r.tables)).catch((e) => setLoadError(e.message));
  }, []);

  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const { tableId, invite } = await api<{ tableId: string; invite: string }>('/api/tables', {});
      saveInvite(tableId, invite);
      navigate(`/tables/${tableId}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <section className="panel" aria-labelledby="tables-title">
      <h2 id="tables-title">Your tables</h2>
      {error && <p className="notice" role="alert">{error}</p>}
      {loadError ? <p className="notice" role="alert">{loadError}</p>
        : tables === null ? <p className="status-line" role="status">Loading tables…</p>
        : tables.length === 0 ? <p>You are not seated at any open table. Create one, or open an invite link from the host.</p>
        : (
          <ul className="table-list">
            {tables.map((t) => (
              <li key={t.id}>
                <a href={`/tables/${t.id}`} onClick={(e) => { e.preventDefault(); navigate(`/tables/${t.id}`); }}>
                  {t.host ? 'Your table' : `${t.hostName}’s table`}
                </a>
                <span>
                  {t.players} of 10 seated · <a href={`/history/${t.id}`} onClick={(e) => { e.preventDefault(); navigate(`/history/${t.id}`); }}>Ledger and hand history</a>
                </span>
              </li>
            ))}
          </ul>
        )}
      <button type="button" className="button primary" onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create a table'}</button>
    </section>
  );
}

const JOIN_ERRORS: Record<string, string> = {
  'invite-invalid': 'This invite link is invalid or has been replaced. Ask the host for the current link.',
  'table-full': 'This table is full. All 10 seats are taken.',
  'entry-queue-full': 'Too many players are waiting for this table. Try again later.',
};

function Join({ tableId, navigate, onSignedOut }: {
  tableId: string;
  navigate: (path: string) => void;
  onSignedOut: (reason: 'signed-out' | 'not-member') => void;
}) {
  const [token, setToken] = useState(() => {
    const pending = readPending();
    return pending?.tableId === tableId ? pending.token : null;
  });
  const [status, setStatus] = useState<EntryStatus | null>(token ? { status: 'none' } : null);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const phase = status?.status;
  const statusPath = `/api/tables/${tableId}/entry-request`;
  const tablePath = `/tables/${tableId}`;

  useEffect(() => {
    if (phase !== undefined && phase !== 'waiting') return;
    let active = true;
    let timer: number | undefined;
    const check = async () => {
      try {
        const next = await api<EntryStatus>(statusPath);
        if (!active) return;
        if (next.status === 'seated') return navigate(tablePath);
        setError('');
        setStatus(next);
        if (phase === 'waiting' && next.status === 'waiting') timer = window.setTimeout(check, 2000);
      } catch (e) {
        if (!active) return;
        if (e instanceof ApiError && e.status === 401) return onSignedOut('signed-out');
        setError('Could not reach the table server. Retrying…');
        timer = window.setTimeout(check, 2000);
      }
    };
    if (phase === 'waiting') timer = window.setTimeout(check, 2000);
    else void check(); // A bare link can resume a request or enter an already approved seat.
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [phase, statusPath, tablePath, navigate, onSignedOut]);

  const request = async () => {
    if (!token || sending) return;
    setError('');
    setSending(true);
    try {
      const next = await api<EntryStatus>(`/api/tables/${tableId}/join`, { token });
      sessionStorage.removeItem(PENDING_INVITE);
      setToken(null);
      if (next.status === 'seated') navigate(tablePath);
      else setStatus(next);
    } catch (e) {
      const err = e as ApiError;
      if (err.status === 401) return onSignedOut('signed-out');
      if (err.code === 'not-member') return onSignedOut('not-member');
      setError(err.status === 0 || err.status === 429 || err.status >= 500
        ? 'The table server could not be reached. Try again.'
        : JOIN_ERRORS[err.code] ?? err.message);
    } finally {
      setSending(false);
    }
  };

  const problem = error || (phase === 'none' && !token ? JOIN_ERRORS['invite-invalid'] : '');
  const canRequest = phase === 'none' && token !== null;

  return (
    <section className="panel" aria-labelledby="join-title" aria-live="polite">
      <h2 id="join-title">{problem && phase === 'none' ? 'Could not join this table' : 'Take your seat'}</h2>
      {problem && <p role="alert">{problem}</p>}
      {phase === undefined && !error && <p className="status-line" role="status">Checking your entry request…</p>}
      {canRequest && (
        <>
          {!error && <p>The Table master approves buy-ins between hands. You will see the table once you are seated.</p>}
          <button type="button" className="button primary" disabled={sending} onClick={() => void request()}>
            {sending ? 'Sending request…' : error ? 'Try again' : 'Buy in'}
          </button>
        </>
      )}
      {status?.status === 'waiting' && (
        <>
          <p className="status-line" role="status">Buy-in request sent. Waiting for the Table master to approve it between hands.</p>
          {typeof status.remaining === 'number' && status.remaining > 0 &&
            <p className="hint">{status.remaining} of the current players still need to finish this dealer rotation before your entry.</p>}
        </>
      )}
      {status?.status === 'declined' && (
        <>
          <p role="status">The Table master declined this buy-in request. You can ask again with a fresh invite link.</p>
          <a className="button" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>Back to your tables</a>
        </>
      )}
      {problem && phase === 'none' && <a className="button" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>Back to your tables</a>}
    </section>
  );
}

const STATUS: Record<string, string> = { connecting: 'Connecting…', live: 'Live', reconnecting: 'Reconnecting…' };

function Table({ tableId, user, navigate, onSignedOut, autoOpenMaster }: {
  tableId: string;
  user: User;
  navigate: (path: string) => void;
  onSignedOut: (state: 'signed-out' | 'not-member') => void;
  /** A bot-managed link: the table master dialog opens for the host once the snapshot arrives. */
  autoOpenMaster: boolean;
}) {
  const { snapshot, connection, error, clockOffset, busy, send } = useTableSocket(tableId);
  useEffect(() => {
    if (connection === 'signed-out' || connection === 'not-member') onSignedOut(connection);
  }, [connection, onSignedOut]);
  // Consume the bot-managed intent once the signed-in host sees the snapshot (non-hosts never receive controls).
  useEffect(() => {
    if (autoOpenMaster && snapshot) sessionStorage.removeItem(PENDING_MASTER);
  }, [autoOpenMaster, snapshot]);

  if (connection === 'left' || (snapshot && snapshot.you.seat === 0)) {
    return (
      <section className="panel">
        <h2>You left the table</h2>
        <p className="hint">If you recorded a settlement here, you can still view your ledger and the completed hands.</p>
        <a className="button" href={`/history/${tableId}`} onClick={(e) => { e.preventDefault(); navigate(`/history/${tableId}`); }}>Ledger and hand history</a>
        <a className="button" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>Back to your tables</a>
      </section>
    );
  }
  if (connection === 'not-found') {
    return (
      <section className="panel">
        <h2>Table not found</h2>
        <p>This table does not exist, or you do not have a seat. Ask the host for an invite link.</p>
        <a className="button" href="/history" onClick={(e) => { e.preventDefault(); navigate('/history'); }}>Ledger and hand history</a>
        <a className="button" href="/" onClick={(e) => { e.preventDefault(); navigate('/'); }}>Back to your tables</a>
      </section>
    );
  }
  if (!snapshot) return <p className="status-line" role="status">Connecting to the table…</p>;
  const host = snapshot.hostId === user.id && !snapshot.closed;
  const disabled = connection !== 'live' || busy;
  const denominations = { ...DEFAULT_CHIP_DENOMINATIONS, ...snapshot.settings.denominations };
  return (
    <>
      {connection === 'reconnecting' && <p className="notice" role="status">Connection lost. Reconnecting… Your seat is kept.</p>}
      {error && <p className="notice" role="alert">{error}</p>}
      <TableView snapshot={snapshot} status={STATUS[connection] ?? ''} clockOffset={clockOffset} tools={(
        <>
          {host && (
            <>
              <TableDialog label="Invite" title="Invite players">
                <HostInvite tableId={tableId} botPosts={snapshot.botPosts} />
              </TableDialog>
              <TableDialog label="Table master" title="Table master" autoOpen={autoOpenMaster}>
                {connection === 'reconnecting' && <p className="notice" role="status">Connection lost. Reconnecting…</p>}
                {error && <p className="notice" role="alert">{error}</p>}
                <HostControls snapshot={snapshot} disabled={disabled} send={send} />
              </TableDialog>
            </>
          )}
          <a className="tool-button" href={`/history/${tableId}`} aria-label="Ledger and hand history"
            onClick={(e) => { e.preventDefault(); navigate(`/history/${tableId}`); }}>History</a>
        </>
      )}>
        <GameControls snapshot={snapshot} disabled={disabled} send={send} />
        {host && <DealControls snapshot={snapshot} disabled={disabled} send={send} />}
      </TableView>
      <ChipLegend snapshot={snapshot} editable={denominations} />
    </>
  );
}

function TableDialog({ label, title, children, autoOpen }: { label: string; title: string; children: ReactNode; autoOpen?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (autoOpen && !dialog.current?.open) dialog.current?.showModal();
  }, [autoOpen]);
  return (
    <>
      <button type="button" className="tool-button" aria-haspopup="dialog" onClick={() => dialog.current?.showModal()}>{label}</button>
      <dialog ref={dialog} className="table-dialog" aria-labelledby={titleId}>
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="tool-button" onClick={() => dialog.current?.close()}>Done</button>
        </div>
        {children}
      </dialog>
    </>
  );
}

function HostInvite({ tableId, botPosts }: { tableId: string; botPosts: boolean }) {
  const [link, setLink] = useState(() => localStorage.getItem(inviteKey(tableId)) ?? '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const token = link.split('#')[1];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setMessage('Invite link copied.');
    } catch {
      setMessage('Copy failed. Select the link and copy it manually.');
    }
  };
  const rotate = async () => {
    setBusy(true);
    try {
      const { invite } = await api<{ invite: string }>(`/api/tables/${tableId}/invite`, {});
      setLink(saveInvite(tableId, invite));
      setMessage('New invite link created. The old link no longer admits new players.');
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="invite-content">
      {link ? (
        <div className="field-row">
          <label className="visually-hidden" htmlFor="invite-link">Invite link</label>
          <input id="invite-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="button primary" onClick={copy}>Copy link</button>
        </div>
      ) : <p>Invite links are shown only once, on the device that created them. Replace the link to get a new one.</p>}
      <p className="hint">Anyone in the community with this link can take a free seat. Replacing it keeps everyone already seated.</p>
      <button type="button" className="button" onClick={rotate} disabled={busy}>Replace invite link</button>
      <p className="status-line" role="status">{message}</p>
      {botPosts && token && <BotPost key={token} tableId={tableId} type="invite" token={token} />}
    </div>
  );
}
