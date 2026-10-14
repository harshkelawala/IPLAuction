/**
 * Messages between the game server and the browser.
 * Kept free of server code so the web app can import it.
 *
 * The server never sends ratings, fair values or the combined Player Score: humans judge worth
 * themselves. It does send each player's form and record, as a real auction room would know them.
 */
import type { BidCheck, Lakh, Role, TeamId } from '@ipl/rules';

export type Difficulty = 'easy' | 'normal' | 'hard';
export type Speed = 'normal' | 'fast';
export type PoolPreset = 'quick' | 'standard' | 'full';
export type Phase = 'lobby' | 'main' | 'accelerated' | 'done';

export interface PublicPlayer {
  id: string;
  name: string;
  country: string;
  isOverseas: boolean;
  isCapped: boolean;
  role: Role;
  battingHand: 'L' | 'R';
  bowlingStyle: string | null;
  category: 'BA' | 'AL' | 'WK' | 'FA' | 'SP';
  basePrice: Lakh;
  /** Real 2026 franchise, for flavour ("CSK 2026"). */
  lastTeam: TeamId;
  /** Specialist jobs the data shows he does: opener, finisher, powerplay, death. */
  tags: string[];
  /** Form and record from every T20 match since 2021; null if he has none on record. */
  stats: PlayerStats | null;
}

/** 50 = an average IPL performance; one standard deviation of a single match is 15. */
export interface PlayerStats {
  /** Last few matches. */
  form: number;
  /** Whole record since 2021. */
  class: number;
  /** Best recent season and big-match record: the proven match-winner part. */
  importance: number;
  batting: number;
  bowling: number;
  /** 0–1: how much cricket this rests on (12 full matches = 1). */
  confidence: number;
  /** Form change over the last 5 matches. */
  trend: number;
  matches: number;
  competitions: Record<string, number>;
  lastMatch: string | null;
  /** Form-and-class level after each of the last 15 matches, oldest first. */
  timeline: number[];
  recent: { date: string; comp: string; against: string; match: number | null }[];
}

export interface SoloSettings {
  teamId: TeamId;
  difficulty: Difficulty;
  speed: Speed;
  pool: PoolPreset;
}

export interface StrengthView {
  /** 0–100, best legal XI: 47.5% batting, 47.5% bowling, 5% bench, plus balance points. */
  overall: number;
  batting: number;
  bowling: number;
  grade: string;
  /** 1 = strongest squad right now. */
  rank: number;
  /** Points for the attack mix and batting variety. */
  balance: number;
  /** Pace and spin bowling options in the best XI. */
  pace: number;
  spin: number;
  /** Best legal XI (at most 4 overseas). */
  xi: string[];
  issues: string[];
  /** Strengths, e.g. "Balanced attack: 3 pace, 2 spin". */
  notes: string[];
  /** Strength above a replacement-level side per ₹10 cr spent; null before any spend. */
  value: number | null;
}

export interface TeamView {
  id: TeamId;
  controller: 'human' | 'ai';
  isYou: boolean;
  purse: Lakh;
  squad: { playerId: string; price: Lakh }[];
  overseasCount: number;
  strength: StrengthView;
}

export interface LotView {
  playerId: string;
  setCode: string;
  setLabel: string;
  currentBid: Lakh | null;
  leader: TeamId | null;
  /** Server clock (ms). Compare with `serverNow` to get time left. */
  endsAt: number;
  nextBid: Lakh;
  bidCount: number;
  /** Whether you may bid the next amount, and why not. */
  yourBid: BidCheck;
}

export type LogEntry =
  | { id: number; kind: 'sold'; playerId: string; teamId: TeamId; price: Lakh }
  | { id: number; kind: 'unsold'; playerId: string }
  | { id: number; kind: 'phase'; phase: Phase };

export interface RoomSnapshot {
  roomId: string;
  phase: Phase;
  paused: boolean;
  /** Time left on the lot when paused (ms). */
  pausedRemainingMs: number | null;
  serverNow: number;
  you: TeamId | null;
  settings: {
    purse: Lakh;
    minSquad: number;
    maxSquad: number;
    maxOverseas: number;
    /** Indians a squad needs to field an XI with at most 4 overseas. */
    minIndians: number;
    difficulty: Difficulty;
    speed: Speed;
    pool: PoolPreset;
    bidTimerMs: number;
  };
  teams: TeamView[];
  lot: LotView | null;
  /** Newest first, at most 40. */
  log: LogEntry[];
  progress: { done: number; total: number };
  unsold: string[];
  /** Players still to come in this round, in the order they will come up. */
  upcoming: string[];
  /** Players you starred. */
  watchlist: string[];
  /** Skip every player you haven't starred. */
  autoSkip: boolean;
}

export interface SetView {
  code: string;
  label: string;
  playerIds: string[];
}

export interface Welcome {
  roomId: string;
  players: PublicPlayer[];
  /** Every auction set in the order they come up. */
  sets: SetView[];
}

export type Ack<T> = (res: { ok: true; data: T } | { ok: false; error: string }) => void;

export interface ClientToServer {
  'solo:create': (settings: SoloSettings, ack: Ack<{ roomId: string; token: string }>) => void;
  'room:join': (req: { roomId: string; token: string }, ack: Ack<Welcome>) => void;
  /** Is this auction still on the server, and how far along? Does not join or resume it. */
  'room:peek': (
    req: { roomId: string; token: string },
    ack: Ack<{ phase: Phase; done: number; total: number; teamId: TeamId } | null>,
  ) => void;
  /** Leave the auction on screen; it pauses until you come back. */
  'room:leave': (ack: Ack<null>) => void;
  'bid:place': (req: { amount: Lakh }, ack: Ack<BidCheck>) => void;
  /** Sit out the current player: AI teams settle it instantly and the next player comes up. */
  'lot:skip': (ack: Ack<null>) => void;
  /** Replace your watchlist and auto-skip setting. */
  'watch:set': (req: { playerIds: string[]; autoSkip: boolean }, ack: Ack<null>) => void;
  'room:pause': (ack: Ack<null>) => void;
  'room:resume': (ack: Ack<null>) => void;
  /**
   * End the auction. 'finish': AI teams settle every remaining player now and the results
   * are shown. 'quit': the auction is deleted without results.
   */
  'room:end': (req: { mode: 'finish' | 'quit' }, ack: Ack<null>) => void;
}

export type BidEvent = { roomId: string; playerId: string; teamId: TeamId; amount: Lakh };
export type SoldEvent = { roomId: string; playerId: string; teamId: TeamId; price: Lakh };

export interface ServerToClient {
  'room:state': (snapshot: RoomSnapshot) => void;
  'auction:bid': (e: BidEvent) => void;
  'auction:sold': (e: SoldEvent) => void;
  'auction:unsold': (e: { roomId: string; playerId: string }) => void;
}
