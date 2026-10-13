import type { AuctionSettings, IncrementSlab } from './types.js';
import { crore } from './money.js';

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

const SHARED = {
  minSquad: 18,
  maxSquad: 25,
  maxOverseas: 8,
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
