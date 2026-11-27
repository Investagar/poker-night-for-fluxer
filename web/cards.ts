import { parseCard } from '../server/game/cards.ts';
import { describe, evaluate } from '../server/game/evaluate.ts';
import type { CardName } from '../server/protocol.ts';

export const SUIT_CHAR: Record<string, string> = { c: '♣', d: '♦', h: '♥', s: '♠' };

const RANK_WORD: Record<string, string> = {
  A: 'ace',
  K: 'king',
  Q: 'queen',
  J: 'jack',
  T: 'ten',
  '9': 'nine',
  '8': 'eight',
  '7': 'seven',
  '6': 'six',
  '5': 'five',
  '4': 'four',
  '3': 'three',
  '2': 'two',
};

const SUIT_WORD: Record<string, string> = { c: 'clubs', d: 'diamonds', h: 'hearts', s: 'spades' };

/** Semantic label for assistive technology, e.g. `As` → 'Ace of spades'. */
export function describeCard(card: CardName): string {
  const rank = RANK_WORD[card.slice(0, -1)] ?? card.slice(0, -1);
  const suit = SUIT_WORD[card.slice(-1)] ?? card.slice(-1);
  return `${rank} of ${suit}`;
}

/** Preview from the viewer's two hole cards and the public board; never count draws. */
export function describeVisibleHand(hole: readonly CardName[], board: readonly CardName[]): string {
  const cards = hole.map(parseCard);
  for (const card of board) cards.push(parseCard(card));
  return describe(evaluate(cards));
}
