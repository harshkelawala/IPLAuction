/** All money in the game is an integer number of lakhs. ₹1 crore = 100 lakh. */
export type Lakh = number;

export type Role = 'BAT' | 'BOWL' | 'AR' | 'WK';

export type TeamId =
  | 'CSK'
  | 'MI'
  | 'RCB'
  | 'KKR'
  | 'SRH'
  | 'RR'
  | 'DC'
  | 'PBKS'
  | 'LSG'
  | 'GT';

export type AuctionMode = 'mega' | 'mini';

/** The minimum a rule check needs to know about the player under the hammer. */
export interface LotPlayer {
  id: string;
  role: Role;
  isOverseas: boolean;
  basePrice: Lakh;
}

/** The minimum a rule check needs to know about a bidding team. */
export interface TeamState {
  teamId: TeamId;
  purse: Lakh;
  squadCount: number;
  overseasCount: number;
}

export interface IncrementSlab {
  /** This step applies while the current bid is below `below` (exclusive). */
  below: Lakh;
  step: Lakh;
}

export interface AuctionSettings {
  mode: AuctionMode;
  purse: Lakh;
  minSquad: number;
  maxSquad: number;
  maxOverseas: number;
  /** Cheapest possible base price; used to reserve money for unfilled minimum slots. */
  minBasePrice: Lakh;
  /**
   * Overseas players' salary cap. The team's purse is still charged the full bid
   * (as in the real IPL, where the excess goes to the BCCI); only the player's pay is capped.
   * null = no cap.
   */
  overseasSalaryCap: Lakh | null;
  increments: IncrementSlab[];
  /** Timer when a player comes up, in ms. */
  openingTimerMs: number;
  /** Timer after each accepted bid, in ms. */
  bidTimerMs: number;
}

export type BidRejection =
  | 'OWN_HIGH_BID'
  | 'SQUAD_FULL'
  | 'OVERSEAS_FULL'
  | 'INSUFFICIENT_PURSE'
  | 'WRONG_AMOUNT';

export type BidCheck = { ok: true } | { ok: false; reason: BidRejection; message: string };
