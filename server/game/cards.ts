/** A card is 0..51: rank = card >> 2 (0 = deuce .. 12 = ace), suit = card & 3. */
export type Card = number;

const RANKS = '23456789TJQKA';
const SUITS = 'cdhs';

export function cardName(card: Card): string {
  return RANKS[card >> 2] + SUITS[card & 3];
}

export function parseCard(name: string): Card {
  const rank = RANKS.indexOf(name[0]);
  const suit = SUITS.indexOf(name[1]);
  if (name.length !== 2 || rank < 0 || suit < 0) throw new Error(`invalid card ${name}`);
  return (rank << 2) | suit;
}
