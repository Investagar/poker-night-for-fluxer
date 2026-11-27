import { randomInt } from 'node:crypto';
import type { Card } from './cards.ts';

/** Fisher–Yates over a fresh deck with an injectable integer source (crypto by default). */
export function shuffledDeck(nextInt: (maxExclusive: number) => number = randomInt): Card[] {
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = nextInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
