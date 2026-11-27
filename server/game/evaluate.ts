import type { Card } from './cards.ts';

export const CATEGORIES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house',
  'Four of a kind', 'Straight flush'] as const;

const RANK_NAMES = ['Twos', 'Threes', 'Fours', 'Fives', 'Sixes', 'Sevens', 'Eights', 'Nines', 'Tens', 'Jacks', 'Queens', 'Kings', 'Aces'];
const HIGH_NAMES = ['Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Jack', 'Queen', 'King', 'Ace'];

function pack(category: number, ranks: number[]): number {
  let score = category;
  for (let i = 0; i < 5; i += 1) score = score * 16 + (ranks[i] ?? 0);
  return score;
}

/** Highest rank of a five-rank run in the bitmask, the wheel (A-2-3-4-5) counting as five-high; -1 if none. */
function straightHigh(mask: number): number {
  for (let high = 12; high >= 4; high -= 1) {
    const run = 0b11111 << (high - 4);
    if ((mask & run) === run) return high;
  }
  return (mask & 0b1000000001111) === 0b1000000001111 ? 3 : -1;
}

function topRanks(mask: number, count: number, exclude: number[] = []): number[] {
  const ranks: number[] = [];
  for (let rank = 12; rank >= 0 && ranks.length < count; rank -= 1) {
    if (mask & (1 << rank) && !exclude.includes(rank)) ranks.push(rank);
  }
  return ranks;
}

/**
 * Scores the best five out of 5–7 cards, or the two known cards preflop. Compare scores only from hands with
 * the same number of cards. The leading hex digit is the category index, followed by five tie-break ranks.
 */
export function evaluate(cards: readonly Card[]): number {
  if (cards.length === 2) {
    const first = cards[0] >> 2;
    const second = cards[1] >> 2;
    return first === second ? pack(1, [first]) : pack(0, [Math.max(first, second), Math.min(first, second)]);
  }

  const counts = new Array<number>(13).fill(0);
  const suits = [0, 0, 0, 0];
  const suitCounts = [0, 0, 0, 0];
  let mask = 0;
  for (const card of cards) {
    const rank = card >> 2;
    counts[rank] += 1;
    suits[card & 3] |= 1 << rank;
    suitCounts[card & 3] += 1;
    mask |= 1 << rank;
  }
  // With at most seven cards a flush rules out quads and full houses, so it can be decided first.
  for (let suit = 0; suit < 4; suit += 1) {
    if (suitCounts[suit] >= 5) {
      const high = straightHigh(suits[suit]);
      return high >= 0 ? pack(8, [high]) : pack(5, topRanks(suits[suit], 5));
    }
  }
  const quads: number[] = [];
  const trips: number[] = [];
  const pairs: number[] = [];
  for (let rank = 12; rank >= 0; rank -= 1) {
    if (counts[rank] === 4) quads.push(rank);
    else if (counts[rank] === 3) trips.push(rank);
    else if (counts[rank] === 2) pairs.push(rank);
  }
  if (quads.length) return pack(7, [quads[0], ...topRanks(mask, 1, [quads[0]])]);
  if (trips.length && (trips.length > 1 || pairs.length)) return pack(6, [trips[0], Math.max(trips[1] ?? -1, pairs[0] ?? -1)]);
  const high = straightHigh(mask);
  if (high >= 0) return pack(4, [high]);
  if (trips.length) return pack(3, [trips[0], ...topRanks(mask, 2, [trips[0]])]);
  if (pairs.length > 1) return pack(2, [pairs[0], pairs[1], ...topRanks(mask, 1, [pairs[0], pairs[1]])]);
  if (pairs.length) return pack(1, [pairs[0], ...topRanks(mask, 3, [pairs[0]])]);
  return pack(0, topRanks(mask, 5));
}

export function category(score: number): number {
  return Math.floor(score / 16 ** 5);
}

export function describe(score: number): string {
  const ranks = Array.from({ length: 5 }, (_, i) => Math.floor(score / 16 ** (4 - i)) % 16);
  const name = CATEGORIES[category(score)];
  switch (category(score)) {
    case 8: return ranks[0] === 12 ? 'Royal flush' : `${name}, ${HIGH_NAMES[ranks[0]]} high`;
    case 7: return `Four ${RANK_NAMES[ranks[0]]}`;
    case 6: return `${name}, ${RANK_NAMES[ranks[0]]} full of ${RANK_NAMES[ranks[1]]}`;
    case 5:
    case 4: return `${name}, ${HIGH_NAMES[ranks[0]]} high`;
    case 3: return `Three ${RANK_NAMES[ranks[0]]}`;
    case 2: return `${name}, ${RANK_NAMES[ranks[0]]} and ${RANK_NAMES[ranks[1]]}`;
    case 1: return `Pair of ${RANK_NAMES[ranks[0]]}`;
    default: return `${HIGH_NAMES[ranks[0]]} high`;
  }
}
