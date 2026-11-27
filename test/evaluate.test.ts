import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseCard } from '../server/game/cards.ts';
import { category, describe, evaluate } from '../server/game/evaluate.ts';
import { describeVisibleHand } from '../web/cards.ts';

const hand = (text: string) => text.split(' ').map(parseCard);

test('all 2,598,960 five-card hands fall into the known category counts and 7,462 distinct ranks', () => {
  const counts = new Array<number>(9).fill(0);
  const distinct = new Set<number>();
  const cards = [0, 0, 0, 0, 0];
  let total = 0;
  for (let a = 0; a < 48; a += 1) {
    cards[0] = a;
    for (let b = a + 1; b < 49; b += 1) {
      cards[1] = b;
      for (let c = b + 1; c < 50; c += 1) {
        cards[2] = c;
        for (let d = c + 1; d < 51; d += 1) {
          cards[3] = d;
          for (let e = d + 1; e < 52; e += 1) {
            cards[4] = e;
            const score = evaluate(cards);
            counts[category(score)] += 1;
            distinct.add(score);
            total += 1;
          }
        }
      }
    }
  }
  assert.equal(total, 2_598_960);
  assert.deepEqual(counts, [1_302_540, 1_098_240, 123_552, 54_912, 10_200, 5_108, 3_744, 624, 40]);
  assert.equal(distinct.size, 7_462);
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('seven-card scores equal the best of all 21 five-card subsets on 200,000 seeded deals', () => {
  const random = mulberry32(20261126);
  const subsets: number[][] = [];
  for (let skipA = 0; skipA < 7; skipA += 1) {
    for (let skipB = skipA + 1; skipB < 7; skipB += 1) subsets.push([0, 1, 2, 3, 4, 5, 6].filter((i) => i !== skipA && i !== skipB));
  }
  assert.equal(subsets.length, 21);
  const deck = Array.from({ length: 52 }, (_, i) => i);
  for (let deal = 0; deal < 200_000; deal += 1) {
    for (let i = 0; i < 7; i += 1) {
      const j = i + Math.floor(random() * (52 - i));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    const seven = deck.slice(0, 7);
    let best = -1;
    for (const subset of subsets) best = Math.max(best, evaluate(subset.map((i) => seven[i])));
    assert.equal(evaluate(seven), best, seven.join(','));
  }
});

test('targeted seven-card shapes pick the right five cards', () => {
  const cases: [string, string][] = [
    ['As Ks Qs Js Ts 2c 3d', 'Royal flush'],
    ['Ah 2h 3h 4h 5h Kd Kc', 'Straight flush, Five high'],
    ['9c 9d 9h 9s Ac Kd 2h', 'Four Nines'],
    ['Kc Kd Kh Qs Qd Qc 2h', 'Full house, Kings full of Queens'],
    ['7c 7d 7h 2s 2d 3c 3h', 'Full house, Sevens full of Threes'],
    ['2h 5h 9h Jh Kh Ah 3c', 'Flush, Ace high'],
    ['Ad 2c 3h 4s 5d Kc Qh', 'Straight, Five high'],
    ['Tc Jd Qh Ks Ad 2c 3h', 'Straight, Ace high'],
    ['8c 8d 8h As Kd 2c 3h', 'Three Eights'],
    ['Ac Ad Kc Kd Qc Qd 2h', 'Two pair, Aces and Kings'],
    ['5c 5d Ah Ks 9d 3c 2h', 'Pair of Fives'],
    ['Ac Qd 9h 7s 5d 3c 2h', 'Ace high'],
  ];
  for (const [cards, label] of cases) assert.equal(describe(evaluate(hand(cards))), label, cards);
  // Three pairs: the third pair's rank can be the kicker.
  assert.ok(evaluate(hand('Ac Ad Kc Kd Qc Qd 2h')) > evaluate(hand('Ac Ad Kc Kd Jc Jd 2h')));
  // Kickers decide equal pairs; identical best fives tie.
  assert.ok(evaluate(hand('Ac Ad Kh 7s 5d')) > evaluate(hand('Ah As Qh Js Td')));
  assert.equal(evaluate(hand('Ac Ad Kh Qs Jd 3c 2h')), evaluate(hand('Ah As Kd Qc Jh 4c 2d')));
  // The wheel loses to a six-high straight.
  assert.ok(evaluate(hand('2c 3d 4h 5s 6d')) > evaluate(hand('Ac 2d 3h 4s 5d')));
});

test('the live hand label counts made hands, not draws, and can play the board', () => {
  const hole = ['As', '2d'];
  const flop = ['3h', '4s', 'Kd'];
  assert.equal(describeVisibleHand(['7c', '7s'], []), 'Pair of Sevens');
  assert.equal(describeVisibleHand(hole, []), 'Ace high');
  assert.equal(describeVisibleHand(hole, flop), 'Ace high', 'four cards toward a straight are still a draw');
  assert.equal(describeVisibleHand(hole, [...flop, '5c']), 'Straight, Five high');
  assert.equal(describeVisibleHand(hole, [...flop, '5c', '6h']), 'Straight, Six high');
  assert.equal(describeVisibleHand(['3c', '4d'], ['Ah', 'Kh', 'Qh', 'Jh', '9h']), 'Flush, Ace high');
});
