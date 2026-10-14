import type { Player } from '@ipl/data';
import type { AuctionSettings } from '@ipl/rules';
import { MAX_OVERSEAS_IN_XI, XI_SIZE } from '@ipl/rules';

/**
 * Team strength, judged on the best legal XI (11 players, at most 4 overseas,
 * a wicketkeeper, 5 bowling options, preferring 2 pace and 1 spin).
 *
 *   batting  = weighted average of the 6 best batting options: the top order counts most
 *              (weights 1.3, 1.25, 1.15, 1.0, 0.85, 0.75)
 *   bowling  = weighted average of the 5 best bowling options: the two strike bowlers count most
 *              (weights 1.3, 1.2, 1.0, 0.85, 0.75)
 *   bench    = average of the best 3 players outside the XI; an empty bench slot counts as a
 *              60-rated replacement player
 *   balance  = attack mix and batting variety, in points:
 *              fewer than 2 pace options −3 each, no spin option −4,
 *              3+ pace and 2+ spin options +1.5, a left-hander in the top 6 +1
 *   overall  = 0.475 batting + 0.475 bowling + 0.05 bench + balance − penalties
 * Penalties: no wicketkeeper −6, fewer than 5 bowling options −4 each,
 * squad below the minimum −3 per missing player. An XI place nobody fills counts as 30.
 */

export interface TeamStrength {
  overall: number;
  batting: number;
  bowling: number;
  bench: number;
  /** Points added or taken away for the attack mix and batting variety. */
  balance: number;
  /** Pace and spin bowling options in the best XI. */
  pace: number;
  spin: number;
  /** Best legal XI, batters first. */
  xi: string[];
  /** Problems: "No spinner in the XI". */
  issues: string[];
  /** Things the XI does well: "Balanced attack: 3 pace, 2 spin". */
  notes: string[];
}

const EMPTY_XI_PLACE = 30;
const REPLACEMENT = 60;
const BAT_WEIGHTS = [1.3, 1.25, 1.15, 1.0, 0.85, 0.75];
const BOWL_WEIGHTS = [1.3, 1.2, 1.0, 0.85, 0.75];
const BENCH_SIZE = 3;

const PACE = new Set(['RF', 'RFM', 'RM', 'LF', 'LFM', 'LM']);
const SPIN = new Set(['OB', 'LB', 'SLA', 'LWS', 'UNO']);

const isBattingOption = (p: Player) => p.role === 'BAT' || p.role === 'WK' || p.role === 'AR';
const isBowlingOption = (p: Player) => p.role === 'BOWL' || p.role === 'AR';
const isPace = (p: Player) => isBowlingOption(p) && p.bowlingStyle !== null && PACE.has(p.bowlingStyle);
const isSpin = (p: Player) => isBowlingOption(p) && p.bowlingStyle !== null && SPIN.has(p.bowlingStyle);

/** Weighted average of the best ratings; missing places count as `empty`. */
function weightedTop(values: number[], weights: number[], empty: number): number {
  const top = [...values].sort((a, b) => b - a).slice(0, weights.length);
  while (top.length < weights.length) top.push(empty);
  const total = weights.reduce((a, b) => a + b, 0);
  return top.reduce((sum, v, i) => sum + v * (weights[i] as number), 0) / total;
}

/**
 * Greedy best XI: the keeper, then the best 2 pace and best spin options, the rest of the
 * 5 bowling options by rating, then the best batters, then anyone. Overseas capped at 4.
 */
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
  const fill = (pred: (p: Player) => boolean, target: number, count: () => number) => {
    for (const p of byRating) {
      if (count() >= target) break;
      if (pred(p)) take(p);
    }
  };
  fill((p) => p.role === 'WK', 1, () => xi.filter((p) => p.role === 'WK').length);
  fill(isPace, 2, () => xi.filter(isPace).length);
  fill(isSpin, 1, () => xi.filter(isSpin).length);
  fill(isBowlingOption, 5, () => xi.filter(isBowlingOption).length);
  fill(isBattingOption, 6, () => xi.filter(isBattingOption).length);
  fill(() => true, XI_SIZE, () => xi.length);
  return xi;
}

export function teamStrength(squad: Player[], settings: Pick<AuctionSettings, 'minSquad'>): TeamStrength {
  const xi = bestXI(squad);
  const battingOptions = xi.filter(isBattingOption);
  const bowlingOptions = xi.filter(isBowlingOption);
  const batting = weightedTop(battingOptions.map((p) => p.rating), BAT_WEIGHTS, EMPTY_XI_PLACE);
  const bowling = weightedTop(bowlingOptions.map((p) => p.rating), BOWL_WEIGHTS, EMPTY_XI_PLACE);
  const bench = weightedTop(
    squad.filter((p) => !xi.includes(p)).map((p) => p.rating),
    new Array<number>(BENCH_SIZE).fill(1),
    REPLACEMENT,
  );

  const issues: string[] = [];
  const notes: string[] = [];
  let penalty = 0;
  let balance = 0;
  const hasPlayers = squad.length > 0;

  if (hasPlayers && !xi.some((p) => p.role === 'WK')) {
    issues.push('No wicketkeeper');
    penalty += 6;
  }
  if (hasPlayers && bowlingOptions.length < 5) {
    issues.push(`Only ${bowlingOptions.length} bowling option${bowlingOptions.length === 1 ? '' : 's'}`);
    penalty += 4 * (5 - bowlingOptions.length);
  }

  // Attack mix: T20 sides want at least two quicks and a spinner.
  const pace = xi.filter(isPace).length;
  const spin = xi.filter(isSpin).length;
  if (hasPlayers && pace < 2) {
    issues.push(pace === 0 ? 'No pace bowler in the XI' : 'Only 1 pace bowler in the XI');
    balance -= 3 * (2 - pace);
  }
  if (hasPlayers && spin === 0) {
    issues.push('No spinner in the XI');
    balance -= 4;
  }
  if (pace >= 3 && spin >= 2) {
    notes.push(`Balanced attack: ${pace} pace, ${spin} spin`);
    balance += 1.5;
  }

  // Batting variety: a left-hander in the top six upsets bowlers' lines.
  const topSix = [...battingOptions].sort((a, b) => b.rating - a.rating).slice(0, 6);
  if (topSix.some((p) => p.battingHand === 'L')) {
    notes.push('Left-hander in the top six');
    balance += 1;
  }

  if (xi.length < XI_SIZE && hasPlayers) issues.push(`Can't field an XI yet (${xi.length} of 11)`);
  const short = settings.minSquad - squad.length;
  if (short > 0) penalty += 3 * short;

  const overall = Math.max(0, 0.475 * batting + 0.475 * bowling + 0.05 * bench + balance - penalty);
  const order = (p: Player) => (p.role === 'BAT' ? 0 : p.role === 'WK' ? 1 : p.role === 'AR' ? 2 : 3);
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    overall: round(overall),
    batting: round(batting),
    bowling: round(bowling),
    bench: round(bench),
    balance: round(balance),
    pace,
    spin,
    xi: [...xi].sort((a, b) => order(a) - order(b) || b.rating - a.rating).map((p) => p.id),
    issues,
    notes,
  };
}

/**
 * Value for money: strength above a replacement-level side (60) per ₹10 crore spent.
 * Returns null before any money is spent.
 */
export function valueForMoney(overall: number, spentLakh: number): number | null {
  if (spentLakh <= 0) return null;
  return Math.round(((overall - REPLACEMENT) / (spentLakh / 1000)) * 10) / 10;
}

/**
 * Letter grade for a strength score. Calibrated on 800 simulated squads, where the
 * middle half scored about 87 to 92 and the median about 90: roughly the top 15% get A+,
 * the middle of the field B+, the bottom 10% D.
 */
export function grade(overall: number): string {
  if (overall >= 93) return 'A+';
  if (overall >= 91.5) return 'A';
  if (overall >= 89.5) return 'B+';
  if (overall >= 87.5) return 'B';
  if (overall >= 85.5) return 'C';
  return 'D';
}
