import type { Lakh, Role, TeamId } from '@ipl/rules';

/** Bowling style codes used in the raw CSV. */
export type BowlingStyle =
  | 'RF' // right-arm fast
  | 'RFM' // right-arm fast-medium / medium-fast
  | 'RM' // right-arm medium
  | 'LF'
  | 'LFM'
  | 'LM'
  | 'OB' // off break
  | 'LB' // leg break
  | 'SLA' // slow left-arm orthodox
  | 'LWS' // left-arm wrist spin
  | 'UNO'; // unorthodox

/** Auction category, used to build sets. */
export type Category = 'BA' | 'AL' | 'WK' | 'FA' | 'SP';

export type RatingSource = 'score' | 'cricsheet' | 'override' | 'price' | 'newcomer';

/** Specialist jobs the data shows a player is used for. */
export type PlayerTag = 'opener' | 'finisher' | 'powerplay' | 'death';

/** The central Player Score (scripts/ratings/player_score.py), on its own 0–100 match-score scale. */
export interface ScoreInfo {
  score: number;
  form: number;
  class: number;
  importance: number;
  batting: number;
  bowling: number;
  /** 0–1: how much cricket the score rests on (12 full matches = 1). */
  confidence: number;
  /** Change in score over the last 5 matches. */
  trend: number;
  matches: number;
  /** Matches per competition code (ipl, t20s, sma, bbl, …). */
  competitions: Record<string, number>;
  lastMatch: string | null;
  /** Score after each of the last 15 matches, oldest first. */
  timeline: number[];
  /** Match performance (0–100) in each of the last 15 matches; null = didn't bat or bowl. */
  recent: { date: string; comp: string; against: string; match: number | null }[];
}

export interface Player {
  id: string;
  name: string;
  country: string;
  isOverseas: boolean;
  isCapped: boolean;
  role: Role;
  battingHand: 'L' | 'R';
  bowlingStyle: BowlingStyle | null;
  category: Category;
  /** 0–100 game rating, taken from the Player Score: drives fair value and base price. */
  rating: number;
  /** Batting and bowling on the same scale, for picking and judging the best XI. */
  battingRating: number;
  bowlingRating: number;
  ratingSource: RatingSource;
  tags: PlayerTag[];
  /** Null when the player has no recorded T20 match since 2021. */
  score: ScoreInfo | null;
  /** What an average team should pay, in lakhs. */
  fairValue: Lakh;
  /** Where bidding opens, in lakhs. */
  basePrice: Lakh;
  /** Real-world franchise and contract this season (reference only). */
  lastTeam: TeamId;
  contractPrice: Lakh;
  acquired: 'retained' | 'auction' | 'trade' | 'replacement';
  /** Withdrawn from the real season (injury, national duty); still auctionable in the game. */
  withdrawn: boolean;
}

export interface AuctionSet {
  /** e.g. M1, BA1, UFA2 */
  code: string;
  label: string;
  playerIds: string[];
}
