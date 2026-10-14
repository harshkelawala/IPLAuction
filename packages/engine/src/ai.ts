import type { Player } from '@ipl/data';
import type { Lakh, Role, TeamId } from '@ipl/rules';
import { SQUAD_TARGET, maxAffordableBid, squadTargets } from '@ipl/rules';
import type { Auction } from './auction';
import type { Difficulty, Personality } from './types';

/**
 * AI bidding (design doc, "AI team bidding"):
 *   max price = fair value × need × budget pressure × personality × noise,
 *   capped by what the reserve rule lets the team spend.
 * An AI keeps bidding while the next bid is at or below its max price.
 */

export { SQUAD_TARGET, squadTargets };

const total = (t: Record<Role, number>) => t.BAT + t.WK + t.AR + t.BOWL;

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

export function needMultiplier(
  counts: Record<Role, number>,
  role: Role,
  targets: Record<Role, number> = SQUAD_TARGET,
): number {
  const have = counts[role];
  const want = targets[role];
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

  const affordable = Math.min(
    maxAffordableBid(auction.teamState(teamId), settings, auction.lotPlayer(playerId)),
    team.purse - realisticReserve(auction, teamId, playerId),
  );
  const base = auction.basePriceOf(playerId);
  if (affordable < base) return 0;

  // 1. Need: chase empty roles, back off from full ones.
  const targets = squadTargets(settings.maxSquad);
  let need = needMultiplier(roleCounts(auction, teamId), player.role, targets);
  if (opts.difficulty === 'easy') need = 1 + (need - 1) * 0.5;

  // 3. Personality and noise (computed first: they also stretch the budget cap).
  const personality = team.controller.personality ?? 'balanced';
  const style = personalityMultiplier(personality, player, teamId);
  const jitter = 1 + NOISE[opts.difficulty] * noise(opts.seed, teamId, playerId);

  // 2. Budget: no single buy may eat much more than its share of what's left.
  //    Stars may take up to 4 average slots' worth, but only for a team's first
  //    few marquee buys; after that every player must fit the depth budget.
  const slotsLeft = Math.max(1, total(targets) - squadCount);
  const perSlot = team.purse / slotsLeft;
  const bigBuys = team.squad.filter((s) => s.price >= MARQUEE_PRICE).length;
  const marqueeBuys = Math.max(1, Math.round((MAX_MARQUEE_BUYS * settings.maxSquad) / 25));
  const starCeiling = bigBuys >= marqueeBuys ? 1.5 : 4;
  const starFactor = Math.min(starCeiling, Math.max(1, 1 + (3.5 * (player.rating - 60)) / 35));
  // Nobody spends more than 22% of a starting purse on one player (₹27.5 cr of ₹125 cr).
  const budgetCap = Math.min(perSlot * starFactor * style * jitter, settings.purse * MAX_SHARE_OF_PURSE);

  let max = Math.min(player.fairValue * need * style * jitter, budgetCap);

  // 4. Not every team wants every player: below star level, a team may sit a player out
  //    (more likely if the role is already covered). This is what lets many players
  //    go for their base price, as in the real auction.
  // Indians still needed for a legal XI (at most 4 overseas in an XI).
  const indiansNeeded = Math.max(0, settings.minIndians - (squadCount - team.overseasCount));
  const openSlots = settings.maxSquad - squadCount;
  // Keep the last slots for Indians: never take an overseas player into them.
  if (player.isOverseas && indiansNeeded >= openSlots - 1) return 0;
  // How tight the Indian requirement is: 0 = plenty of room, 1 = every open slot must be an Indian.
  const indianPressure = indiansNeeded / Math.max(1, openSlots);
  const late = auction.progress > 0.6 || auction.currentPhase === 'accelerated';
  const shortOfSquad = settings.minSquad - squadCount > 0;
  const shortOfIndians = !player.isOverseas && indiansNeeded > 0 && (late || indianPressure >= 0.5);
  const urgent = (shortOfSquad && late) || shortOfIndians;
  if (!urgent && !isInterested(opts.seed, teamId, player, need)) return 0;

  // 5. Once Indians get tight, an Indian is worth more, but never past the budget cap.
  if (shortOfIndians) max = Math.min(max * (1 + 0.3 * indianPressure), budgetCap);

  // 6. A team short of its minimum squad late on (or short of Indians) takes anyone near base price.
  if (urgent) max = Math.max(max, base * (auction.currentPhase === 'accelerated' ? 2 : 1.5));

  return Math.floor(Math.min(max, affordable));
}

/**
 * Money to keep back for the rest of the minimum squad, priced at the base prices of the
 * cheapest players this team could still sign (Indian only once its overseas slots are full,
 * counting this player if he is overseas).
 * The rules' reserve assumes ₹30 L players always exist; late in a strong pool they may not.
 */
export function realisticReserve(auction: Auction, teamId: TeamId, playerId: string): Lakh {
  const team = auction.team(teamId);
  const settings = auction.settings;
  const current = auction.player(playerId);
  const indiansAfter = team.squad.length - team.overseasCount + (current.isOverseas ? 0 : 1);
  const indiansNeeded = Math.max(0, settings.minIndians - indiansAfter);
  const toMinimum = Math.max(0, settings.minSquad - (team.squad.length + 1));
  const slots = Math.max(toMinimum, indiansNeeded);
  if (slots <= 0) return 0;
  const overseasAfter = team.overseasCount + (current.isOverseas ? 1 : 0);
  const overseasOk = overseasAfter < settings.maxOverseas;
  const candidates = new Set<string>([...auction.upcoming.map((q) => q.playerId), ...auction.unsoldPlayers]);
  candidates.delete(playerId);
  const indian: Lakh[] = [];
  const any: Lakh[] = [];
  for (const id of candidates) {
    const p = auction.player(id);
    if (!p.isOverseas) indian.push(p.basePrice);
    if (!p.isOverseas || overseasOk) any.push(p.basePrice);
  }
  indian.sort((a, b) => a - b);
  any.sort((a, b) => a - b);
  // The Indians the XI needs come first, at the cheapest Indian prices; any other slots
  // to the minimum squad at the cheapest prices of all.
  let reserve = 0;
  // Rivals are hunting the same cheap Indians, so keep a 50% margin on that part.
  for (let i = 0; i < indiansNeeded; i++) reserve += Math.round((indian[i] ?? settings.minBasePrice) * 1.5);
  const used = new Map<Lakh, number>();
  for (let i = 0; i < indiansNeeded; i++) {
    const price = indian[i] ?? settings.minBasePrice;
    used.set(price, (used.get(price) ?? 0) + 1);
  }
  let others = slots - indiansNeeded;
  for (const price of any) {
    if (others <= 0) break;
    const u = used.get(price) ?? 0;
    if (u > 0) {
      used.set(price, u - 1);
      continue;
    }
    reserve += price;
    others--;
  }
  reserve += Math.max(0, others) * settings.minBasePrice;
  return reserve;
}

/** Largest share of a starting purse an AI will spend on one player. */
export const MAX_SHARE_OF_PURSE = 0.22;

/** A buy at or above this counts as a marquee buy. */
export const MARQUEE_PRICE = 1_200;
/** Marquee buys a team makes before it switches to building depth (in a 25-player squad). */
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
