import { useEffect, useId, useState, type ReactNode, type RefObject } from 'react';
import type { CardName, SeatView, Snapshot } from '../server/protocol.ts';
import { describeCard, describeVisibleHand, SUIT_CHAR } from './cards.ts';

export function Avatar({ name, src }: { name: string; src: string | null }) {
  return (
    <span className="avatar" aria-hidden="true">
      {src ? <img src={src} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.hidden = true; }} /> : null}
      <span>{Array.from(name)[0]?.toUpperCase() ?? '?'}</span>
    </span>
  );
}

/** One playing card: glyph suit + rank on the face, semantic rank/suit for assistive tech. */
export function Card({ card }: { card: CardName }) {
  const rank = card.slice(0, -1);
  const suitKey = card.slice(-1);
  const suit = SUIT_CHAR[suitKey] ?? suitKey;
  const red = suitKey === 'd' || suitKey === 'h';
  return (
    <li className={`card${red ? ' red' : ''}`}>
      <span aria-hidden="true" className="card-face"><b>{rank === 'T' ? '10' : rank}</b><i>{suit}</i></span>
      <span className="visually-hidden">{describeCard(card)}</span>
    </li>
  );
}

function turnSecondsLeft(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/** Countdown to the server-clock turn deadline. */
function TurnTimer({ deadline, clockOffset }: { deadline: number; clockOffset: RefObject<number> }) {
  const [now, setNow] = useState(() => Date.now() + clockOffset.current);
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now() + clockOffset.current), 250);
    return () => clearInterval(interval);
  }, [deadline, clockOffset]);
  const seconds = turnSecondsLeft(deadline, now);
  return <span className="turn-timer" role="timer" aria-label={`${seconds} seconds to act`}>{seconds}s</span>;
}

function Seat({ seat, number, position, hostId, dealer, hand }: {
  seat: SeatView | null;
  number: number;
  position: number;
  hostId: string;
  dealer: number | null;
  hand: Snapshot['hand'];
}) {
  if (!seat) {
    return <li className="seat empty" data-position={position}>
      <span aria-hidden="true">·</span><span className="visually-hidden">Seat {number}, open</span>
    </li>;
  }
  const isDealer = dealer === number;
  const acting = hand?.toAct === number;
  const blind = hand?.smallBlind === number ? 'SB' : hand?.bigBlind === number ? 'BB' : null;
  const state = !seat.connected ? 'Offline' : seat.away ? 'Away' : seat.hand?.folded ? 'Folded' : seat.hand?.allIn ? 'All-in' : null;
  const bet = seat.hand?.bet ?? 0;
  const master = seat.userId === hostId;
  return (
    <li className={`seat${position === 0 ? ' you' : ''}${acting ? ' to-act' : ''}`} data-position={position}>
      <span className="visually-hidden">Seat {number}{master ? ', table master' : ''}</span>
      {master && <abbr className="master-badge" title="Table master">TM</abbr>}
      <div className="seat-player">
        <Avatar name={seat.name} src={seat.avatar} />
        <div className="seat-info">
          <span className="seat-name" title={seat.name}>{seat.name}</span>
          <strong className="seat-stack">{seat.stack.toLocaleString()}<span className="visually-hidden"> chips</span></strong>
          {position === 0 && <span className="visually-hidden">You</span>}
        </div>
      </div>
      {(isDealer || blind) && <div className="seat-badges">
        {isDealer && <abbr title="Dealer">D</abbr>}
        {blind && <abbr title={blind === 'SB' ? 'Small blind' : 'Big blind'}>{blind}</abbr>}
      </div>}
      {(state || bet > 0) && <div className="seat-meta">
        {state && <span>{state}</span>}
        {bet > 0 && <span>Bet {bet.toLocaleString()}</span>}
      </div>}
    </li>
  );
}

export function HandResult({ last }: { last: NonNullable<Snapshot['last']> }) {
  const titleId = useId();
  const playerName = (seat: number) => last.players.find((player) => player.seat === seat)?.name ?? `Seat ${seat}`;
  return (
    <section className="panel result" aria-labelledby={titleId}>
      <h2 id={titleId}>Hand {last.id} result</h2>
      <p className="hint">{last.showdown ? 'Showdown' : 'Won without showdown'}</p>
      {last.board.length > 0 && (
        <ul className="board result-board" aria-label="Board">
          {last.board.map((card) => <Card key={card} card={card} />)}
        </ul>
      )}
      {last.shown.length > 0 && (
        <dl className="shown-hands">
          {last.shown.map((s) => (
            <div key={s.seat} className="shown-hand">
              <dt>{playerName(s.seat)}</dt>
              <dd>
                <ul className="board shown-cards" aria-label={`Cards shown by ${playerName(s.seat)}`}>
                  {s.cards.map((card) => <Card key={card} card={card} />)}
                </ul>
                <span className="hand-label">{s.label}</span>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <table className="pots-table">
        <caption className="visually-hidden">Result pots and winners</caption>
        <thead><tr><th scope="col">Pot</th><th scope="col">Winner</th><th scope="col">Amount</th></tr></thead>
        <tbody>
          {last.pots.map((pot, index) => pot.winners.map((winner, winnerIndex) => (
            <tr key={`${index}-${winner.seat}`}>
              {winnerIndex === 0 && <th scope="row" rowSpan={pot.winners.length}>{index === 0 ? 'Main pot' : `Side pot ${index}`}</th>}
              <td>{playerName(winner.seat)}</td>
              <td>{winner.amount}</td>
            </tr>
          )))}
        </tbody>
      </table>
      <table className="net-table">
        <caption className="visually-hidden">Net chip change per seat for this hand</caption>
        <thead><tr><th scope="col">Seat</th><th scope="col">Net</th></tr></thead>
        <tbody>
          {last.net.map((n) => (
            <tr key={n.seat}><th scope="row">{playerName(n.seat)}</th><td>{n.amount >= 0 ? `+${n.amount}` : n.amount}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Space occupied seats evenly while keeping their clockwise order from the viewer's seat. */
function seatPositions(seats: Snapshot['seats'], viewerSeat: number, count: number): number[] {
  const positions: number[] = [];
  const used = new Set<number>();
  let rank = 0;
  for (let offset = 0; offset < seats.length; offset += 1) {
    const index = (viewerSeat - 1 + offset) % seats.length;
    if (!seats[index]) continue;
    const position = Math.round(rank * seats.length / count);
    positions[index] = position;
    used.add(position);
    rank += 1;
  }
  let open = 0;
  for (let index = 0; index < seats.length; index += 1) {
    if (seats[index]) continue;
    while (used.has(open)) open += 1;
    positions[index] = open++;
  }
  return positions;
}

export function TableView({ snapshot, status, clockOffset, tools, children }: {
  snapshot: Snapshot;
  status: string;
  clockOffset: RefObject<number>;
  tools: ReactNode;
  children: ReactNode;
}) {
  const { seats, hand, game, you, last } = snapshot;
  const count = seats.filter(Boolean).length;
  const positions = seatPositions(seats, you.seat, count);
  const acting = hand?.toAct == null ? null : seats[hand.toAct - 1];
  const myTurn = Boolean(you.options) && !game.paused;
  const handLabel = hand && you.cards.length === 2 && !seats[you.seat - 1]?.hand?.folded
    ? describeVisibleHand(you.cards, hand.board)
    : null;
  const statusLabel = snapshot.closed ? 'No more hands' : game.nextHandAt !== null ? 'Next hand soon' :
    game.running ? 'Waiting for players' : game.handNo ? 'Dealing stopped' : 'Waiting to deal';
  const mainWinners = last?.pots[0]?.winners;
  const mainWinner = mainWinners?.length === 1 ? last?.players.find((p) => p.seat === mainWinners[0].seat) : undefined;
  const outcome = snapshot.closed || !last ? null : mainWinner ? `${mainWinner.name} won the main pot` :
    mainWinners && mainWinners.length > 1 ? 'Main pot split' : `Hand ${last.id} complete`;
  const street = hand && hand.street[0].toUpperCase() + hand.street.slice(1);
  return (
    <>
      <section className="table-stage" aria-labelledby="table-label">
        <div className="table-toolbar">
          <div className="table-identity">
            <h2 id="table-label">Private table</h2>
            <p>{count}/{seats.length} seated <span aria-hidden="true">·</span> {snapshot.settings.smallBlind}/{snapshot.settings.bigBlind} blinds</p>
          </div>
          <div className="table-tools" role="group" aria-label="Table tools">
            {seats.some((s) => s?.userId === snapshot.hostId) && (
              <span className="master-attribution"><span className="master-badge" aria-hidden="true">TM</span> Table master</span>
            )}
            <span className={`connection-state${status === 'Live' ? ' connected' : ''}`}><span>{status}</span></span>
            {tools}
          </div>
        </div>
        <div className="table-arena">
          <div className="table-board">
            {hand ? (
              <>
                <p className="board-street">{street} <span aria-hidden="true">·</span> Hand {hand.id}</p>
                <p className="board-pot"><span>Pot</span> <strong>{hand.pot.toLocaleString()}</strong><span className="visually-hidden"> chips</span></p>
                <ul className="board community" role="list" aria-label="Board">
                  {hand.board.map((card) => <Card key={card} card={card} />)}
                  {Array.from({ length: 5 - hand.board.length }, (_, i) => <li key={`slot-${i}`} className="card-slot" aria-hidden="true" />)}
                </ul>
              </>
            ) : (
              <div className="board-idle">
                <p className="board-street">Texas Hold’em</p>
                <strong>{outcome ?? statusLabel}</strong>
                {outcome && <span>{statusLabel}</span>}
              </div>
            )}
          </div>
          <ol className="seats" role="list" aria-label="Seats">
            {seats.map((seat, index) => (
              <Seat key={index} seat={seat} number={index + 1} position={positions[index]}
                hostId={snapshot.hostId} dealer={hand?.dealer ?? game.dealer} hand={hand} />
            ))}
          </ol>
        </div>
        <div className={`table-dock${myTurn ? ' is-your-turn' : ''}`}>
          {hand && (
            <div className="hand-dock">
              {you.cards.length > 0 && (
                <ul className="board hole-cards" role="list" aria-label="Your cards">
                  {you.cards.map((card) => <Card key={card} card={card} />)}
                </ul>
              )}
              <div className="turn-state">
                <strong role="status">{game.paused ? 'Hand paused' : myTurn ? 'Your turn' : acting ? `${acting.name} to act` : 'Waiting for the next action'}</strong>
                {handLabel && <div className="made-hand" role="status" aria-label="Your hand">{handLabel}</div>}
                {game.paused && <span>Waiting for the host to resume.</span>}
              </div>
              {hand.deadline !== null && !game.paused && (
                <TurnTimer key={`${hand.id}:${hand.turn}:${hand.deadline}`} deadline={hand.deadline} clockOffset={clockOffset} />
              )}
            </div>
          )}
          {children}
        </div>
      </section>
      {last && (
        <details className="hand-recap">
          <summary>Hand {last.id} details</summary>
          <HandResult last={last} />
        </details>
      )}
    </>
  );
}
