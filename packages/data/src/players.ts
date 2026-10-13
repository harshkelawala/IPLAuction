import type { Role, TeamId } from '@ipl/rules';
import { TEAM_IDS } from '@ipl/rules';
import type { BowlingStyle, Category, Player, RatingSource } from './types';
import { basePriceFromRating, clampRating, fairValue, isPace, ratingFromPrice } from './valuation';

const ROLES: readonly Role[] = ['BAT', 'BOWL', 'AR', 'WK'];
const STYLES: readonly BowlingStyle[] = ['RF', 'RFM', 'RM', 'LF', 'LFM', 'LM', 'OB', 'LB', 'SLA', 'LWS', 'UNO'];
const ACQUIRED = ['retained', 'auction', 'trade', 'replacement'] as const;

export function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function categoryFor(role: Role, style: BowlingStyle | null): Category {
  switch (role) {
    case 'BAT':
      return 'BA';
    case 'AR':
      return 'AL';
    case 'WK':
      return 'WK';
    case 'BOWL':
      return isPace(style) ? 'FA' : 'SP';
  }
}

function oneOf<T extends string>(value: string, allowed: readonly T[], field: string, name: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name}: invalid ${field} "${value}" (expected ${allowed.join(', ')})`);
  }
  return value as T;
}

/** Optional ratings from other sources, keyed by player id. */
export interface RatingInputs {
  cricsheet?: Map<string, number>;
  overrides?: Map<string, number>;
}

/**
 * Turn raw squad rows into game players.
 * Rating priority: manual override > Cricsheet stats > provisional (inverted from contract price).
 */
export function buildPlayers(rows: Record<string, string>[], ratings: RatingInputs = {}): Player[] {
  return rows.map((r) => {
    const name = r.name ?? '';
    if (!name) throw new Error('Row without a name');
    const id = slugify(name);
    const role = oneOf(r.role ?? '', ROLES, 'role', name);
    const bowlingStyle = r.bowl ? oneOf(r.bowl, STYLES, 'bowl', name) : null;
    const lastTeam = oneOf(r.team ?? '', TEAM_IDS as readonly TeamId[], 'team', name);
    const acquired = oneOf(r.acquired ?? '', ACQUIRED, 'acquired', name);
    const contractPrice = Number(r.price_lakh);
    if (!Number.isFinite(contractPrice) || contractPrice <= 0) throw new Error(`${name}: bad price_lakh`);
    const country = r.country ?? '';
    const isOverseas = country !== 'India';
    const isCapped = r.capped === '1';
    const shape = { role, isOverseas, bowlingStyle };

    let rating: number;
    let ratingSource: RatingSource;
    const override = ratings.overrides?.get(id);
    const stats = ratings.cricsheet?.get(id);
    if (override !== undefined) {
      rating = clampRating(override);
      ratingSource = 'override';
    } else if (stats !== undefined) {
      rating = clampRating(stats);
      ratingSource = 'cricsheet';
    } else {
      rating = ratingFromPrice(contractPrice, shape);
      ratingSource = 'price';
    }

    const basePrice = basePriceFromRating(rating, isCapped);
    return {
      id,
      name,
      country,
      isOverseas,
      isCapped,
      role,
      battingHand: r.bat === 'L' ? 'L' : 'R',
      bowlingStyle,
      category: categoryFor(role, bowlingStyle),
      rating,
      ratingSource,
      fairValue: fairValue({ rating, ...shape }, basePrice),
      basePrice,
      lastTeam,
      contractPrice,
      acquired,
      withdrawn: r.status === 'withdrawn',
    } satisfies Player;
  });
}
