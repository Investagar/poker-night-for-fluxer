/** Wire types shared by the server and the browser. Pure declarations only: the web build imports this file. */

export const PROTOCOL_VERSION = 4;
export const MAX_MINOR = 100_000_000_000;
export const MAX_CHIPS = 1_000_000_000;
export const MAX_CORRECTION_REASON = 120;

export const CHIP_COLORS = ['white', 'red', 'blue', 'green', 'black'] as const;
export type ChipColor = typeof CHIP_COLORS[number];
export type ChipDenominations = Record<ChipColor, number>;
export const DEFAULT_CHIP_DENOMINATIONS: ChipDenominations = { white: 1, red: 5, blue: 10, green: 25, black: 100 };

export interface User {
  id: string;
  name: string;
  avatar: string | null;
}

/** Cards on the wire are rank + suit, e.g. `As`, `Td`, `2c`. */
export type CardName = string;

export type Action = 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allin';
export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export interface Settings {
  smallBlind: number;
  bigBlind: number;
  turnSeconds: number;
  /** Default chips for the table master's issuance form. */
  startingChips: number;
  /** Default recorded buy-in for that form, in integer minor units of `currency`. */
  buyInMinor: number;
  currency: string;
  /** Amount of chip units per color; absent in legacy settings. White is always one unit. */
  denominations?: ChipDenominations;
}

/** A player's public part in the current hand. Hole cards are never included here. */
export interface SeatHand {
  bet: number;
  total: number;
  folded: boolean;
  allIn: boolean;
}

export interface SeatView {
  seat: number;
  userId: string;
  name: string;
  avatar: string | null;
  connected: boolean;
  stack: number;
  away: boolean;
  hand: SeatHand | null;
}

export interface HandView {
  id: number;
  street: Street;
  board: CardName[];
  dealer: number;
  smallBlind: number;
  bigBlind: number;
  pot: number;
  currentBet: number;
  toAct: number | null;
  turn: number;
  /** Server-clock epoch milliseconds; null while paused. */
  deadline: number | null;
}

export interface Options {
  fold: boolean;
  check: boolean;
  call: number;
  /** Bet (nothing bet yet this street) or raise, as a total street bet between min and max. */
  raise: { kind: 'bet' | 'raise'; min: number; max: number } | null;
}

export interface LastHand {
  id: number;
  board: CardName[];
  showdown: boolean;
  pots: { amount: number; eligible: number[]; winners: { seat: number; amount: number }[] }[];
  /** Only hands still live at showdown. Folded hands are never revealed. */
  shown: { seat: number; cards: CardName[]; label: string }[];
  net: { seat: number; amount: number }[];
}

export interface EntryRequest {
  id: number;
  user: User;
  remaining: number;
}

export interface EntryStatus {
  status: 'none' | 'waiting' | 'declined' | 'seated';
  remaining?: number;
  requestId?: number;
}

export interface Snapshot {
  v: typeof PROTOCOL_VERSION;
  type: 'snapshot';
  tableId: string;
  version: number;
  serverNow: number;
  hostId: string;
  closed: boolean;
  currencyLocked: boolean;
  botPosts: boolean;
  settings: Settings;
  game: { running: boolean; paused: boolean; handNo: number; dealer: number | null; nextHandAt: number | null };
  seats: (SeatView | null)[];
  /** Only the table master gets the pending entry queue. */
  entryRequests: EntryRequest[];
  hand: HandView | null;
  /** Private to the recipient. */
  you: { seat: number; cards: CardName[]; options: Options | null; boughtIn: boolean };
  last: HandHistory | null;
}

export interface TableSummary {
  id: string;
  hostName: string;
  host: boolean;
  players: number;
}

export type LedgerKind = 'buy-in' | 'rebuy' | 'cash-out';

export interface LedgerEntry {
  id: number;
  kind: LedgerKind;
  userId: string;
  name: string;
  actorId: string;
  actorName: string;
  commandId: string;
  amountMinor: number;
  currency: string;
  chips: number;
  createdAt: number;
  /** A revision references the original entry, even after multiple corrections. */
  correction: { entryId: number; reason: string; voided: boolean } | null;
  superseded: boolean;
  chipCorrectionAvailable: boolean;
}

export interface HandHistory extends LastHand {
  endedAt: number;
  players: { seat: number; userId: string; name: string }[];
}

export interface HistoryTable {
  id: string;
  hostName: string;
  closed: boolean;
}

export interface LedgerView {
  tableId: string;
  host: boolean;
  hostName: string;
  closed: boolean;
  botPosts: boolean;
  entries: LedgerEntry[];
  totals: { userId: string; name: string; currency: string; inMinor: number; outMinor: number; netMinor: number }[];
  hands: HandHistory[];
  next: number | null;
  nextHand: number | null;
}

export type NotificationRequest =
  | { id: string; type: 'invite'; token: string }
  | { id: string; type: 'settlement' };

export interface NotificationResult {
  status: 'pending' | 'sent' | 'unconfirmed';
  messageId: string | null;
}

export type Command =
  | { type: 'act'; handId: number; turn: number; action: Action; amount?: number }
  | { type: 'settings'; settings: Settings }
  | { type: 'start'; dealer?: number }
  | { type: 'stop' }
  | { type: 'resume' }
  | { type: 'buyin'; userId: string; amountMinor: number; currency: string; chips: number; requestId?: number }
  | { type: 'cashout'; userId: string; amountMinor: number; currency: string; chips: number }
  | { type: 'correct-ledger'; entryId: number; amountMinor: number; chips: number; reason: string }
  | { type: 'decline-entry'; requestId: number }
  | { type: 'back' }
  | { type: 'leave' }
  | { type: 'close' };

export interface CommandMessage {
  v: typeof PROTOCOL_VERSION;
  type: 'command';
  /** Client-chosen unique ID, 8–64 characters of `[A-Za-z0-9_-]`. Retrying with the same ID returns the first result. */
  id: string;
  command: Command;
}

export type Ack =
  | { v: typeof PROTOCOL_VERSION; type: 'ack'; id: string; ok: true; version: number }
  | { v: typeof PROTOCOL_VERSION; type: 'ack'; id: string; ok: false; code: string; error: string };

export type ServerMessage =
  | Snapshot
  | Ack
  | { v: typeof PROTOCOL_VERSION; type: 'tick'; serverNow: number }
  | { v: typeof PROTOCOL_VERSION; type: 'error'; code: string; error: string };
