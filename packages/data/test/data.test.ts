import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CURVE,
  basePriceFromRating,
  buildPlayers,
  buildSets,
  categoryFor,
  fairValue,
  mulberry32,
  parseCsv,
  ratingFromPrice,
  selectPool,
  shuffleSet,
  slugify,
  type Player,
} from '../src/index';

const rawCsv = readFileSync(join(import.meta.dirname, '..', 'raw', 'squads-2026.csv'), 'utf8');
const players = buildPlayers(parseCsv(rawCsv));

const neutral = { role: 'BAT' as const, isOverseas: true, bowlingStyle: null };

describe('valuation curve', () => {
  // Design doc table, before modifiers: 60 ≈ ₹0.9 cr, 75 ≈ ₹2.8 cr, 85 ≈ ₹5.8 cr, 95 ≈ ₹12.4 cr, 100 ≈ ₹18 cr
  const raw = (rating: number) => CURVE.A * Math.exp(CURVE.K * (rating - CURVE.pivot));
  it.each([
    [60, 0.9],
    [75, 2.8],
    [85, 5.8],
    [95, 12.4],
    [100, 18],
  ])('rating %i is about ₹%f cr', (rating, crore) => {
    expect(raw(rating)).toBeCloseTo(crore, 0);
  });

  it('applies the Indian premium and scarcity', () => {
    const overseas = fairValue({ rating: 85, ...neutral }, 30);
    const indian = fairValue({ rating: 85, ...neutral, isOverseas: false }, 30);
    const indianPacer = fairValue({ rating: 85, role: 'BOWL', isOverseas: false, bowlingStyle: 'RFM' }, 30);
    expect(indian).toBeGreaterThan(overseas);
    expect(indianPacer).toBeGreaterThan(indian);
  });

  it('never values a player below base price', () => {
    expect(fairValue({ rating: 30, ...neutral }, 200)).toBe(200);
  });

  it('inverts: a price-derived rating reproduces roughly that price', () => {
    for (const price of [100, 500, 1000, 1500]) {
      const rating = ratingFromPrice(price, neutral);
      const back = fairValue({ rating, ...neutral }, 30);
      expect(Math.abs(back - price) / price).toBeLessThan(0.08);
    }
  });
});

describe('base price', () => {
  it('follows the rating tiers', () => {
    expect(basePriceFromRating(90, true)).toBe(200);
    expect(basePriceFromRating(80, true)).toBe(150);
    expect(basePriceFromRating(70, true)).toBe(100);
    expect(basePriceFromRating(60, true)).toBe(75);
    expect(basePriceFromRating(50, true)).toBe(50);
    expect(basePriceFromRating(40, true)).toBe(30);
  });
  it('starts uncapped players at ₹30 L unless they are exceptional', () => {
    expect(basePriceFromRating(70, false)).toBe(30);
    expect(basePriceFromRating(80, false)).toBe(150);
  });
});

describe('players from the 2026 squads', () => {
  it('loads every row with a unique id', () => {
    expect(players).toHaveLength(272);
    expect(new Set(players.map((p) => p.id)).size).toBe(272);
  });

  it('marks nationality and categories', () => {
    const byId = (id: string) => players.find((p) => p.id === id) as Player;
    expect(byId('jasprit-bumrah')).toMatchObject({ isOverseas: false, category: 'FA' });
    expect(byId('rashid-khan')).toMatchObject({ isOverseas: true, category: 'SP' });
    expect(byId('rishabh-pant')).toMatchObject({ category: 'WK' });
    expect(byId('ms-dhoni')).toMatchObject({ isCapped: false });
  });

  it('keeps ratings and values in range', () => {
    for (const p of players) {
      expect(p.rating).toBeGreaterThanOrEqual(30);
      expect(p.rating).toBeLessThanOrEqual(99);
      expect(p.fairValue).toBeGreaterThanOrEqual(p.basePrice);
      expect([30, 50, 75, 100, 150, 200]).toContain(p.basePrice);
    }
  });

  it('prefers overrides, then Cricsheet, then price', () => {
    const rows = parseCsv(rawCsv).slice(0, 3);
    const ids = rows.map((r) => slugify(r.name ?? ''));
    const built = buildPlayers(rows, {
      overrides: new Map([[ids[0] as string, 77]]),
      cricsheet: new Map([
        [ids[0] as string, 50],
        [ids[1] as string, 66],
      ]),
    });
    expect(built.map((p) => [p.rating, p.ratingSource])).toEqual([
      [77, 'override'],
      [66, 'cricsheet'],
      [built[2]?.rating, 'price'],
    ]);
  });

  it('rejects bad rows', () => {
    const bad = parseCsv('team,name,country,role,bat,bowl,price_lakh,acquired,capped,status,notes\nXXX,A B,India,BAT,R,,30,auction,0,active,');
    expect(() => buildPlayers(bad)).toThrow(/invalid team/);
  });
});

describe('sets', () => {
  const sets = buildSets(players, 'mega');
  const allIds = sets.flatMap((s) => s.playerIds);

  it('includes every player exactly once', () => {
    expect(allIds).toHaveLength(players.length);
    expect(new Set(allIds).size).toBe(players.length);
  });

  it('opens with two marquee sets of the 12 most valuable players', () => {
    expect(sets.slice(0, 2).map((s) => [s.code, s.playerIds.length])).toEqual([
      ['M1', 6],
      ['M2', 6],
    ]);
    const top12 = selectPool(players, 'full').slice(0, 12).map((p) => p.id);
    expect(new Set(sets.slice(0, 2).flatMap((s) => s.playerIds))).toEqual(new Set(top12));
  });

  it('rotates roles so each comes up early', () => {
    expect(sets.slice(2, 7).map((s) => s.code)).toEqual(['BA1', 'AL1', 'WK1', 'FA1', 'SP1']);
  });

  it('respects set sizes and capped status', () => {
    const byId = new Map(players.map((p) => [p.id, p]));
    for (const s of sets) {
      if (s.code.startsWith('M')) continue;
      const uncapped = s.code.startsWith('U');
      expect(s.playerIds.length).toBeLessThanOrEqual(uncapped ? 10 : 8);
      for (const id of s.playerIds) expect(byId.get(id)?.isCapped).toBe(!uncapped);
    }
  });

  it('has no marquee in mini mode', () => {
    expect(buildSets(players, 'mini').some((s) => s.code.startsWith('M'))).toBe(false);
  });

  it('trims pools by value', () => {
    expect(selectPool(players, 'quick')).toHaveLength(150);
    expect(selectPool(players, 'full')).toHaveLength(272);
  });
});

describe('helpers', () => {
  it('slugs names', () => {
    expect(slugify('T. Natarajan')).toBe('t-natarajan');
    expect(slugify('Lhuan-dre Pretorius')).toBe('lhuan-dre-pretorius');
  });

  it('maps bowlers to pace or spin', () => {
    expect(categoryFor('BOWL', 'LFM')).toBe('FA');
    expect(categoryFor('BOWL', 'LWS')).toBe('SP');
    expect(categoryFor('BOWL', 'UNO')).toBe('SP');
  });

  it('shuffles deterministically by seed', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(shuffleSet(ids, mulberry32(42))).toEqual(shuffleSet(ids, mulberry32(42)));
    expect(shuffleSet(ids, mulberry32(42)).sort()).toEqual(ids);
  });
});
