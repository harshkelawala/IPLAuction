import type { Lakh, Role } from '@ipl/rules';
import type { BowlingStyle } from './types.js';

/**
 * Fair value curve (see design doc, "Fair value"):
 *   value_cr = max(base, A · e^(K · (rating − 40))) × m_nationality × m_role
 * A and K should be re-fitted each season against real auction prices.
 */
export const CURVE = { A: 0.2, K: 0.075, pivot: 40 } as const;

export const MODIFIERS = {
  indian: 1.3,
  overseas: 0.9,
  scarcity: 1.15,
} as const;

const PACE: ReadonlySet<BowlingStyle> = new Set(['RF', 'RFM', 'RM', 'LF', 'LFM', 'LM']);

export function isPace(style: BowlingStyle | null): boolean {
  return style !== null && PACE.has(style);
}

/** Wicketkeepers and Indian fast bowlers are scarce, so teams pay a premium. */
export function scarcityMultiplier(role: Role, isOverseas: boolean, style: BowlingStyle | null): number {
  if (role === 'WK') return MODIFIERS.scarcity;
  if (!isOverseas && role === 'BOWL' && isPace(style)) return MODIFIERS.scarcity;
  return 1;
}

export interface ValueInput {
  rating: number;
  role: Role;
  isOverseas: boolean;
  bowlingStyle: BowlingStyle | null;
}

export function totalMultiplier(p: Omit<ValueInput, 'rating'>): number {
  const nation = p.isOverseas ? MODIFIERS.overseas : MODIFIERS.indian;
  return nation * scarcityMultiplier(p.role, p.isOverseas, p.bowlingStyle);
}

/** Fair value in lakhs, rounded to the nearest 5 lakh, never below the base price. */
export function fairValue(p: ValueInput, basePrice: Lakh): Lakh {
  const crore = CURVE.A * Math.exp(CURVE.K * (p.rating - CURVE.pivot)) * totalMultiplier(p);
  const lakh = Math.round((crore * 100) / 5) * 5;
  return Math.max(basePrice, lakh);
}

/**
 * Provisional rating: invert the fair-value curve on a player's real contract price.
 * Used until the Cricsheet stats pipeline has produced a stats-based rating.
 */
export function ratingFromPrice(price: Lakh, p: Omit<ValueInput, 'rating'>): number {
  const crore = price / 100;
  const raw = CURVE.pivot + Math.log(crore / (CURVE.A * totalMultiplier(p))) / CURVE.K;
  return clampRating(raw);
}

export function clampRating(r: number): number {
  return Math.round(Math.min(99, Math.max(30, r)));
}

/** Base price from rating (design doc table), used when no official base price exists. */
export function basePriceFromRating(rating: number, isCapped: boolean): Lakh {
  if (!isCapped && rating < 75) return 30;
  if (rating >= 85) return 200;
  if (rating >= 75) return 150;
  if (rating >= 65) return 100;
  if (rating >= 55) return 75;
  if (rating >= 45) return 50;
  return 30;
}
