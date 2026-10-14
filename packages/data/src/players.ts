import type { Role, TeamId } from '@ipl/rules';
import { TEAM_IDS } from '@ipl/rules';
import type { BowlingStyle, Category, Player, RatingSource } from './types';
import { NEWCOMER_SCORE, quantileMap, toScoreInfo, toTags, type RawScore } from './score';
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
  /** The central Player Score (generated/player-score.json), keyed by player id. */
  scores?: Map<string, RawScore>;
  /** Older stats ratings (ratings-cricsheet.csv), used only when there is no Player Score file. */
  cricsheet?: Map<string, number>;
  overrides?: Map<string, number>;
}

/**
 * Turn raw squad rows into game players.
 * Rating priority: manual override > Player Score > older Cricsheet rating > contract price.
 * With a Player Score file, every player's rating comes from the score (a player with no
 * recorded match gets the newcomer score); contract prices only set the overall spread of
 * ratings, so the auction economy keeps the scale it was tuned on.
 */
export function buildPlayers(rows: Record<string, string>[], ratings: RatingInputs = {}): Player[] {
  const scores = ratings.scores;
  let toRating: ((s: number) => number) | undefined;
  let toBatting: ((s: number) => number) | undefined;
  let toBowling: ((s: number) => number) | undefined;
  if (scores && scores.size) {
    const priceRating = (r: Record<string, string>) =>
      ratingFromPrice(Number(r.price_lakh), {
        role: r.role as Role,
        isOverseas: (r.country ?? '') !== 'India',
        bowlingStyle: (r.bowl || null) as BowlingStyle | null,
      });
    const raw = (r: Record<string, string>) => scores.get(slugify(r.name ?? ''));
    const overall = (r: Record<string, string>) => raw(r)?.score ?? NEWCOMER_SCORE;
    toRating = quantileMap(rows.map(overall), rows.map(priceRating));
    // Batting is ranked among the players picked to bat, bowling among those picked to bowl,
    // so a team's batting and bowling sit on the same scale.
    const batters = rows.filter((r) => r.role !== 'BOWL');
    const bowlers = rows.filter((r) => r.role === 'BOWL' || r.role === 'AR');
    toBatting = quantileMap(batters.map((r) => raw(r)?.batting.score ?? overall(r)), batters.map(priceRating));
    toBowling = quantileMap(bowlers.map((r) => raw(r)?.bowling.score ?? overall(r)), bowlers.map(priceRating));
  }

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

    const override = ratings.overrides?.get(id);
    const stats = ratings.cricsheet?.get(id);
    const raw = scores?.get(id);
    const fromScore =
      toRating && toBatting && toBowling
        ? (() => {
            const s = raw?.score ?? NEWCOMER_SCORE;
            return {
              rating: clampRating(toRating(s)),
              batting: clampRating(toBatting(raw?.batting.score ?? s)),
              bowling: clampRating(toBowling(raw?.bowling.score ?? s)),
            };
          })()
        : undefined;

    let rating: number;
    let ratingSource: RatingSource;
    let battingRating: number | undefined = fromScore?.batting;
    let bowlingRating: number | undefined = fromScore?.bowling;
    if (override !== undefined) {
      rating = clampRating(override);
      ratingSource = 'override';
    } else if (fromScore) {
      rating = fromScore.rating;
      ratingSource = raw ? 'score' : 'newcomer';
    } else if (stats !== undefined) {
      rating = clampRating(stats);
      ratingSource = 'cricsheet';
    } else {
      rating = ratingFromPrice(contractPrice, shape);
      ratingSource = 'price';
    }

    // Keep a player's own discipline in line with his overall rating (an override moves both).
    if (battingRating === undefined || ratingSource === 'override') battingRating = role === 'BOWL' ? Math.min(rating, 45) : rating;
    if (bowlingRating === undefined || ratingSource === 'override') bowlingRating = role === 'BAT' || role === 'WK' ? Math.min(rating, 45) : rating;

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
      battingRating,
      bowlingRating,
      ratingSource,
      tags: toTags(raw),
      score: raw ? toScoreInfo(raw) : null,
      fairValue: fairValue({ rating, ...shape }, basePrice),
      basePrice,
      lastTeam,
      contractPrice,
      acquired,
      withdrawn: r.status === 'withdrawn',
    } satisfies Player;
  });
}
