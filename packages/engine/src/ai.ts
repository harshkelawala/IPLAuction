import type { Player } from '@ipl/data';
import type { Lakh, Role, TeamId } from '@ipl/rules';
import { maxAffordableBid } from '@ipl/rules';
import type { Auction } from './auction.js';
import type { Difficulty, Personality } from './types.js';

/**
 * AI bidding (design doc, "AI team bidding"):
 *   max price = fair value × need × budget pressure × personality × noise,
 *   capped by what the reserve rule lets the team spend.
 * An AI keeps bidding while the next bid is at or below its max price.
 */

/** How many of each role an AI aims for (22 of the 25 slots). */
export const SQUAD_TARGET: Record<Role, number> = { BAT: 6, WK: 2, AR: 6, BOWL: 8 };
const TARGET_TOTAL = Object.values(SQUAD_TARGET).reduce((a, b) => a + b, 0);

export interface AiOptions {
  difficulty: Difficulty;
  /** Seed for per-player noise, so the same game replays the same way. */
  seed: number;
}

const NOISE: Record<Difficulty, number> = { easy: 0.2, normal: 0.1, hard: 0.05 };

/** Deterministic noise in [-1, 1] for a (seed, team, player) triple. */
export function noise(seed: number, teamId: string, playerId: string): number {
  let h = 2166136261 ^ seed;
  for (const ch of `${teamId}|${playerId}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

export function needMultiplier(counts: Record<Role, number>, role: Role): number {
  const have = counts[role];
  const want = SQUAD_TARGET[role];
  if (have === 0 && role === 'WK') return 1.4;
  if (have < want) return 1 + 0.25 * ((want - have) / want);
  if (have < want + 2) return 0.6;
  return 0.3;
}

export function personalityMultiplier(personality: Personality, player: Player, teamId: TeamId): number {
  switch (personality) {
    case 'aggressive':
      return player.rating >= 85 ? 1.2 : 1.0;
    case 'moneyball':
      if (!player.isCapped) return 1.15;
      return player.rating >= 85 ? 0.85 : 1.0;
    case 'loyalist':
      return player.lastTeam === teamId ? 1.25 : 1.0;
    case 'balanced':
      return 1.0;
  }
}

function roleCounts(auction: Auction, teamId: TeamId): Record<Role, number> {
  const counts: Record<Role, number> = { BAT: 0, WK: 0, AR: 0, BOWL: 0 };
  for (const s of auction.team(teamId).squad) counts[auction.player(s.playerId).role] += 1;
  return counts;
}

/**
 * The most this AI team would pay for this player right now.
 * Recomputed on every decision: the team's squad and purse change during the auction.
 */
export function aiMaxPrice(auction: Auction, teamId: TeamId, playerId: string, opts: AiOptions): Lakh {
  const team = auction.team(teamId);
  const player = auction.player(playerId);
  const settings = auction.settings;
  const squadCount = team.squad.length;
  if (squadCount >= settings.maxSquad) return 0;
  if (player.isOverseas && team.overseasCount >= settings.maxOverseas) return 0;

  const affordable = maxAffordableBid(auction.teamState(teamId), settings);
  if (affordable < player.basePrice) return 0;

  // 1. Need: chase empty roles, back off from full ones.
  let need = needMultiplier(roleCounts(auction, teamId), player.role);
  if (opts.difficulty === 'easy') need = 1 + (need - 1) * 0.5;

  // 3. Personality and noise (computed first: they also stretch the budget cap).
  const personality = team.controller.personality ?? 'balanced';
  const style = personalityMultiplier(personality, player, teamId);
  const jitter = 1 + NOISE[opts.difficulty] * noise(opts.seed, teamId, playerId);

  // 2. Budget: no single buy may eat much more than its share of what's left.
  //    Stars may take up to 4 average slots' worth, but only for a team's first
  //    few marquee buys; after that every player must fit the depth budget.
  const slotsLeft = Math.max(1, TARGET_TOTAL - squadCount);
  const perSlot = team.purse / slotsLeft;
  const bigBuys = team.squad.filter((s) => s.price >= MARQUEE_PRICE).length;
  const starCeiling = bigBuys >= MAX_MARQUEE_BUYS ? 1.5 : 4;
  const starFactor = Math.min(starCeiling, Math.max(1, 1 + (3.5 * (player.rating - 60)) / 35));
  const budgetCap = perSlot * starFactor * style * jitter;

  let max = Math.min(player.fairValue * need * style * jitter, budgetCap);

  // 4. Not every team wants every player: below star level, a team may sit a player out
  //    (more likely if the role is already covered). This is what lets many players
  //    go for their base price, as in the real auction.
  const short = settings.minSquad - squadCount;
  const urgent = short > 0 && (auction.progress > 0.7 || auction.currentPhase === 'accelerated');
  if (!urgent && !isInterested(opts.seed, teamId, player, need)) return 0;

  // 5. Late in the auction, a team short of the minimum squad takes anyone near base price.
  if (short > 0 && auction.progress > 0.7) max = Math.max(max, player.basePrice * 1.5);
  if (short > 0 && auction.currentPhase === 'accelerated') max = Math.max(max, player.basePrice * 2);

  return Math.floor(Math.min(max, affordable));
}

/** A buy at or above this counts as a marquee buy. */
export const MARQUEE_PRICE = 1_200;
/** Marquee buys a team makes before it switches to building depth. */
export const MAX_MARQUEE_BUYS = 3;

/**
 * Whether a team is in the running for this player at all.
 * Stars (rating 80+) always interest everyone; a rating-40 player interests about 1 team in 5.
 */
export function isInterested(seed: number, teamId: TeamId, player: Player, need: number): boolean {
  if (player.rating >= 80) return true;
  const base = 0.2 + (0.7 * (player.rating - 40)) / 40;
  const p = Math.min(1, Math.max(0.1, base * (need > 1 ? 1.3 : need < 1 ? 0.5 : 1)));
  const u = (noise(seed ^ 0x5f3759df, teamId, player.id) + 1) / 2;
  return u < p;
}

/** Whether this AI team wants to place the next bid on the current lot. */
export function aiWantsToBid(auction: Auction, teamId: TeamId, opts: AiOptions): boolean {
  const lot = auction.currentLot;
  if (!lot || lot.leader === teamId) return false;
  const amount = auction.nextBidAmount();
  if (amount === null || !auction.canBid(teamId, amount).ok) return false;
  return amount <= aiMaxPrice(auction, teamId, lot.playerId, opts);
}

/**
 * How long an AI waits before bidding, so humans see a believable rhythm.
 * Usually 0.6–3 s; about 1 in 10 bids come near the end of the timer.
 */
export function aiBidDelay(rng: () => number, msLeft: number): number {
  if (rng() < 0.1 && msLeft > 2_500) return Math.round(msLeft - 1_000 - rng() * 1_000);
  return Math.round(600 + rng() * 2_400);
}

/** Default personalities: two aggressive, four balanced, two moneyball, two loyalist. */
export function assignPersonalities(teamIds: readonly TeamId[], rng: () => number): Record<TeamId, Personality> {
  const pool: Personality[] = ['aggressive', 'aggressive', 'balanced', 'balanced', 'balanced', 'balanced', 'moneyball', 'moneyball', 'loyalist', 'loyalist'];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j] as Personality, pool[i] as Personality];
  }
  return Object.fromEntries(teamIds.map((id, i) => [id, pool[i % pool.length]])) as Record<TeamId, Personality>;
}
