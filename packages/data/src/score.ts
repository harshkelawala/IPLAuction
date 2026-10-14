import type { PlayerTag, ScoreInfo } from './types';

/** Score a player with no recorded T20 match starts at (same as the Python NEWCOMER). */
export const NEWCOMER_SCORE = 45;

/** One player's entry in generated/player-score.json. */
export interface RawScore {
  cricsheet_name: string;
  score: number;
  form: number;
  class: number;
  importance: number;
  batting: { score: number };
  bowling: { score: number };
  confidence: number;
  trend: number;
  matches: Record<string, number>;
  last_match: string | null;
  tags: string[];
  timeline: [string, number][];
  history: { date: string; comp: string; against: string; match: number | null; score: number }[];
}

const TAGS: readonly PlayerTag[] = ['opener', 'finisher', 'powerplay', 'death'];

export function toScoreInfo(r: RawScore): ScoreInfo {
  return {
    score: r.score,
    form: r.form,
    class: r.class,
    importance: r.importance,
    batting: r.batting.score,
    bowling: r.bowling.score,
    confidence: r.confidence,
    trend: r.trend,
    matches: Object.values(r.matches).reduce((a, b) => a + b, 0),
    competitions: r.matches,
    lastMatch: r.last_match,
    timeline: r.timeline.slice(-15).map(([, s]) => s),
    recent: r.history.map(({ date, comp, against, match }) => ({ date, comp, against, match })),
  };
}

export function toTags(r: RawScore | undefined): PlayerTag[] {
  return (r?.tags ?? []).filter((t): t is PlayerTag => (TAGS as readonly string[]).includes(t));
}

/**
 * Map Player Scores onto game ratings by rank: the player at the 90th percentile of scores gets
 * the 90th-percentile game rating. `targets` is the rating spread the auction economy was tuned
 * on (contract prices run through the fair-value curve), so total spending stays realistic while
 * the order of players comes entirely from the score.
 */
export function quantileMap(scores: number[], targets: number[]): (score: number) => number {
  const xs = [...scores].sort((a, b) => a - b);
  const ys = [...targets].sort((a, b) => a - b);
  if (!xs.length || !ys.length) return (s) => s;
  const at = (q: number) => {
    const pos = Math.min(1, Math.max(0, q)) * (ys.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(ys.length - 1, lo + 1);
    return (ys[lo] as number) + ((ys[hi] as number) - (ys[lo] as number)) * (pos - lo);
  };
  return (score: number) => {
    // Fraction of players below this score, ties counted half (interpolated between neighbours).
    let below = 0;
    let equal = 0;
    for (const x of xs) {
      if (x < score) below++;
      else if (x === score) equal++;
    }
    if (xs.length === 1) return at(0.5);
    let q: number;
    if (equal > 0) q = (below + (equal - 1) / 2) / (xs.length - 1);
    else if (below === 0) q = 0;
    else if (below === xs.length) q = 1;
    else {
      const a = xs[below - 1] as number;
      const b = xs[below] as number;
      q = (below - 1 + (score - a) / (b - a)) / (xs.length - 1);
    }
    return at(q);
  };
}
