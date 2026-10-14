import type { AuctionSettings, IncrementSlab, Role } from './types';
import { crore } from './money';

/**
 * Bid steps: +₹5 L below ₹1 cr, +₹10 L to ₹2 cr, +₹20 L to ₹5 cr, +₹25 L above.
 * A game choice close to how the televised auction moves.
 */
export const DEFAULT_INCREMENTS: IncrementSlab[] = [
  { below: crore(1), step: 5 },
  { below: crore(2), step: 10 },
  { below: crore(5), step: 20 },
  { below: Number.POSITIVE_INFINITY, step: 25 },
];

/** A playing XI: 11 players, at most 4 of them overseas. */
export const XI_SIZE = 11;
export const MAX_OVERSEAS_IN_XI = 4;

const SHARED = {
  minSquad: 18,
  maxSquad: 25,
  maxOverseas: 8,
  minIndians: XI_SIZE - MAX_OVERSEAS_IN_XI,
  minBasePrice: 30,
  increments: DEFAULT_INCREMENTS,
  openingTimerMs: 15_000,
  bidTimerMs: 10_000,
} as const;

/** Mega auction: every team starts empty with the full purse. */
export const MEGA_DEFAULTS: AuctionSettings = {
  ...SHARED,
  increments: [...DEFAULT_INCREMENTS],
  mode: 'mega',
  purse: crore(125),
  overseasSalaryCap: null,
};

/** Mini auction: teams keep retentions; overseas pay capped at ₹18 cr. */
export const MINI_DEFAULTS: AuctionSettings = {
  ...SHARED,
  increments: [...DEFAULT_INCREMENTS],
  mode: 'mini',
  purse: crore(125),
  overseasSalaryCap: crore(18),
};

/**
 * Squad rules by player-pool size. A shorter auction has fewer players to go round
 * (Quick: 150 players for 10 teams), so squads shrink to match. The Quick pool is the
 * 150 most valuable players, so it keeps the full purse.
 */
export const POOL_RULES = {
  quick: { minSquad: 11, maxSquad: 14, maxOverseas: 6, purse: crore(125) },
  standard: { minSquad: 18, maxSquad: 25, maxOverseas: 8, purse: crore(125) },
  full: { minSquad: 18, maxSquad: 25, maxOverseas: 8, purse: crore(125) },
} as const;

export const PURSE_PRESETS = {
  tight: crore(100),
  standard: crore(125),
  rich: crore(150),
} as const;

/** How many of each role a balanced squad aims for, in a 25-player squad (22 of 25 slots). */
export const SQUAD_TARGET: Record<Role, number> = { BAT: 6, WK: 2, AR: 6, BOWL: 8 };

/** Role targets scaled to the squad size in play (e.g. 14-player squads in a Quick auction). */
export function squadTargets(maxSquad: number): Record<Role, number> {
  const k = maxSquad / 25;
  return {
    BAT: Math.max(1, Math.round(SQUAD_TARGET.BAT * k)),
    WK: Math.max(1, Math.round(SQUAD_TARGET.WK * k)),
    AR: Math.max(1, Math.round(SQUAD_TARGET.AR * k)),
    BOWL: Math.max(2, Math.round(SQUAD_TARGET.BOWL * k)),
  };
}
