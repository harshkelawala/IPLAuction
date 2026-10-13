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

export type RatingSource = 'cricsheet' | 'override' | 'price';

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
  /** 0–100 skill score. */
  rating: number;
  ratingSource: RatingSource;
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
