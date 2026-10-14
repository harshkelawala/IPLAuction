import type { AuctionMode } from '@ipl/rules';
import type { AuctionSet, Category, Player } from './types';

const CATEGORY_ORDER: Category[] = ['BA', 'AL', 'WK', 'FA', 'SP'];

const CATEGORY_LABEL: Record<Category, string> = {
  BA: 'batters',
  AL: 'all-rounders',
  WK: 'wicketkeepers',
  FA: 'fast bowlers',
  SP: 'spinners',
};

export const MARQUEE_COUNT = 12;
export const MARQUEE_SET_SIZE = 6;
export const CAPPED_SET_SIZE = 8;
export const UNCAPPED_SET_SIZE = 10;

export type PoolPreset = 'quick' | 'standard' | 'full';

export const POOL_SIZES: Record<PoolPreset, number> = {
  quick: 150,
  standard: 250,
  full: Number.POSITIVE_INFINITY,
};

/** Share of a limited pool that may be overseas, close to real IPL squads (8 of 25 at most). */
export const MAX_OVERSEAS_SHARE = 0.36;

/**
 * Keep the most valuable N players (ties broken by rating, then name for stability),
 * with at most 36% overseas so every team can find the 7 Indians a legal XI needs.
 */
export function selectPool(players: Player[], preset: PoolPreset): Player[] {
  const size = POOL_SIZES[preset];
  const sorted = [...players].sort(byValue);
  if (sorted.length <= size) return sorted;
  const overseasCap = Math.floor(size * MAX_OVERSEAS_SHARE);
  const overseas = sorted.filter((p) => p.isOverseas).slice(0, overseasCap);
  const indians = sorted.filter((p) => !p.isOverseas).slice(0, size - overseas.length);
  return [...overseas, ...indians].sort(byValue);
}

function byValue(a: Player, b: Player): number {
  return b.fairValue - a.fairValue || b.rating - a.rating || a.name.localeCompare(b.name);
}

function byRating(a: Player, b: Player): number {
  return b.rating - a.rating || b.fairValue - a.fairValue || a.name.localeCompare(b.name);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Build auction sets in the order they come up:
 * marquee (mega only), then a rotation of capped and uncapped role sets
 * (BA1, AL1, WK1, FA1, SP1, UBA1, … BA2, …) so every role appears early.
 * Order *within* a set is decided at game time with `shuffleSet`.
 */
export function buildSets(players: Player[], mode: AuctionMode): AuctionSet[] {
  const sets: AuctionSet[] = [];
  let remaining = [...players];

  if (mode === 'mega') {
    const marquee = [...remaining].sort(byValue).slice(0, MARQUEE_COUNT);
    const marqueeIds = new Set(marquee.map((p) => p.id));
    chunk(marquee, MARQUEE_SET_SIZE).forEach((group, i) => {
      sets.push({ code: `M${i + 1}`, label: `Marquee ${i + 1}`, playerIds: group.map((p) => p.id) });
    });
    remaining = remaining.filter((p) => !marqueeIds.has(p.id));
  }

  const queues = new Map<string, { label: string; groups: Player[][] }>();
  for (const capped of [true, false]) {
    for (const cat of CATEGORY_ORDER) {
      const group = remaining.filter((p) => p.isCapped === capped && p.category === cat).sort(byRating);
      const prefix = capped ? '' : 'U';
      const label = `${capped ? 'Capped' : 'Uncapped'} ${CATEGORY_LABEL[cat]}`;
      queues.set(`${prefix}${cat}`, {
        label,
        groups: chunk(group, capped ? CAPPED_SET_SIZE : UNCAPPED_SET_SIZE),
      });
    }
  }

  const rounds = Math.max(0, ...[...queues.values()].map((q) => q.groups.length));
  for (let r = 0; r < rounds; r++) {
    for (const [code, q] of queues) {
      const group = q.groups[r];
      if (!group) continue;
      sets.push({ code: `${code}${r + 1}`, label: `${q.label} ${r + 1}`, playerIds: group.map((p) => p.id) });
    }
  }
  return sets;
}

/** Deterministic PRNG so a game can be replayed from its seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates shuffle of a set's players with a seeded RNG. */
export function shuffleSet(ids: readonly string[], rng: () => number): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i] as string;
    out[i] = out[j] as string;
    out[j] = a;
  }
  return out;
}
