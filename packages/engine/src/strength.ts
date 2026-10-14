import type { Player } from '@ipl/data';
import type { AuctionSettings } from '@ipl/rules';
import { MAX_OVERSEAS_IN_XI, XI_SIZE } from '@ipl/rules';

/**
 * Team strength: pick the best legal XI (11 players, at most 4 overseas, a wicketkeeper,
 * at least 5 bowling options), then score its batting and bowling from player ratings.
 *
 *   batting  = average rating of the 6 best batting options in the XI (BAT, WK, AR)
 *   bowling  = average rating of the 5 best bowling options in the XI (BOWL, AR)
 *   bench    = average rating of the best 4 players left out
 *   overall  = 0.45 batting + 0.45 bowling + 0.10 bench − penalties
 * Missing XI places count as a 30-rated player. Penalties: no wicketkeeper −6,
 * fewer than 5 bowling options −4 each, squad below the minimum −3 per missing player.
 */

export interface TeamStrength {
  overall: number;
  batting: number;
  bowling: number;
  bench: number;
  /** Best legal XI, batting options first. */
  xi: string[];
  /** Plain-language problems: "No wicketkeeper", "Only 4 bowling options". */
  issues: string[];
}

const EMPTY_SLOT = 30;
const BATTERS = 6;
const BOWLERS = 5;

const isBattingOption = (p: Player) => p.role === 'BAT' || p.role === 'WK' || p.role === 'AR';
const isBowlingOption = (p: Player) => p.role === 'BOWL' || p.role === 'AR';

function avgTop(values: number[], n: number): number {
  const top = [...values].sort((a, b) => b - a).slice(0, n);
  while (top.length < n) top.push(EMPTY_SLOT);
  return top.reduce((a, b) => a + b, 0) / n;
}

/** Greedy best XI: keeper first, then 5 bowling options, then the best batters, overseas capped at 4. */
export function bestXI(squad: Player[]): Player[] {
  const byRating = [...squad].sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  const xi: Player[] = [];
  let overseas = 0;
  const take = (p: Player): boolean => {
    if (xi.length >= XI_SIZE || xi.includes(p)) return false;
    if (p.isOverseas && overseas >= MAX_OVERSEAS_IN_XI) return false;
    xi.push(p);
    if (p.isOverseas) overseas++;
    return true;
  };
  const keeper = byRating.find((p) => p.role === 'WK' && (!p.isOverseas || overseas < MAX_OVERSEAS_IN_XI));
  if (keeper) take(keeper);
  let bowlers = xi.filter(isBowlingOption).length;
  for (const p of byRating) {
    if (bowlers >= BOWLERS) break;
    if (isBowlingOption(p) && take(p)) bowlers++;
  }
  let batters = xi.filter(isBattingOption).length;
  for (const p of byRating) {
    if (batters >= BATTERS) break;
    if (isBattingOption(p) && take(p)) batters++;
  }
  for (const p of byRating) {
    if (xi.length >= XI_SIZE) break;
    take(p);
  }
  return xi;
}

export function teamStrength(squad: Player[], settings: Pick<AuctionSettings, 'minSquad'>): TeamStrength {
  const xi = bestXI(squad);
  const batting = avgTop(xi.filter(isBattingOption).map((p) => p.rating), BATTERS);
  const bowling = avgTop(xi.filter(isBowlingOption).map((p) => p.rating), BOWLERS);
  const benchPlayers = squad.filter((p) => !xi.includes(p));
  const bench = avgTop(benchPlayers.map((p) => p.rating), 4);

  const issues: string[] = [];
  let penalty = 0;
  if (squad.length > 0 && !xi.some((p) => p.role === 'WK')) {
    issues.push('No wicketkeeper');
    penalty += 6;
  }
  const bowlingOptions = xi.filter(isBowlingOption).length;
  if (squad.length > 0 && bowlingOptions < BOWLERS) {
    issues.push(`Only ${bowlingOptions} bowling option${bowlingOptions === 1 ? '' : 's'}`);
    penalty += 4 * (BOWLERS - bowlingOptions);
  }
  if (xi.length < XI_SIZE && squad.length > 0) issues.push(`Can't field an XI yet (${xi.length} of 11)`);
  const short = settings.minSquad - squad.length;
  if (short > 0) penalty += 3 * short;

  const overall = Math.max(0, 0.45 * batting + 0.45 * bowling + 0.1 * bench - penalty);
  const order = (p: Player) => (p.role === 'WK' ? 1 : p.role === 'BAT' ? 0 : p.role === 'AR' ? 2 : 3);
  return {
    overall: Math.round(overall * 10) / 10,
    batting: Math.round(batting * 10) / 10,
    bowling: Math.round(bowling * 10) / 10,
    bench: Math.round(bench * 10) / 10,
    xi: [...xi].sort((a, b) => order(a) - order(b) || b.rating - a.rating).map((p) => p.id),
    issues,
  };
}

/**
 * Letter grade for a strength score. Calibrated on simulated auctions, where squads
 * score about 78 to 95 with a median near 85.
 */
export function grade(overall: number): string {
  if (overall >= 90) return 'A+';
  if (overall >= 87) return 'A';
  if (overall >= 84) return 'B+';
  if (overall >= 81) return 'B';
  if (overall >= 78) return 'C';
  return 'D';
}
