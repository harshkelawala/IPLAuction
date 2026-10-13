import type { Lakh, TeamId } from '@ipl/rules';

export type Personality = 'aggressive' | 'balanced' | 'moneyball' | 'loyalist';
export type Difficulty = 'easy' | 'normal' | 'hard';

export interface TeamController {
  kind: 'human' | 'ai';
  /** AI only. */
  personality?: Personality;
}

export interface SquadEntry {
  playerId: string;
  /** What the purse was charged. */
  price: Lakh;
}

export interface TeamRuntime {
  teamId: TeamId;
  controller: TeamController;
  purse: Lakh;
  squad: SquadEntry[];
  overseasCount: number;
}

export type Phase = 'lobby' | 'main' | 'accelerated' | 'done';

export interface Lot {
  playerId: string;
  setCode: string;
  currentBid: Lakh | null;
  leader: TeamId | null;
  /** Server time (ms) when the hammer falls unless someone bids. */
  endsAt: number;
  bidCount: number;
}

export interface Sale {
  playerId: string;
  teamId: TeamId;
  price: Lakh;
  /** Price after the overseas salary cap, if any. */
  salary: Lakh;
  phase: Exclude<Phase, 'lobby' | 'done'>;
}

export type AuctionEvent =
  | { type: 'player_up'; playerId: string; setCode: string; basePrice: Lakh; endsAt: number }
  | { type: 'bid'; playerId: string; teamId: TeamId; amount: Lakh; endsAt: number }
  | { type: 'sold'; playerId: string; teamId: TeamId; price: Lakh }
  | { type: 'unsold'; playerId: string }
  | { type: 'phase'; phase: Phase }
  | { type: 'ended'; reason: 'pool_empty' | 'all_full' };
