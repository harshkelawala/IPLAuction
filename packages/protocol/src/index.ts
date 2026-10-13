/**
 * Messages between the game server and the browser.
 * Kept free of server code so the web app can import it.
 *
 * The server never sends ratings or fair values: humans judge worth themselves.
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
}

export interface SoloSettings {
  teamId: TeamId;
  difficulty: Difficulty;
  speed: Speed;
  pool: PoolPreset;
}

export interface TeamView {
  id: TeamId;
  controller: 'human' | 'ai';
  isYou: boolean;
  purse: Lakh;
  squad: { playerId: string; price: Lakh }[];
  overseasCount: number;
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
  'bid:place': (req: { amount: Lakh }, ack: Ack<BidCheck>) => void;
  /** Sit out the current player: AI teams settle it instantly and the next player comes up. */
  'lot:skip': (ack: Ack<null>) => void;
  'room:pause': (ack: Ack<null>) => void;
  'room:resume': (ack: Ack<null>) => void;
}

export type BidEvent = { playerId: string; teamId: TeamId; amount: Lakh };
export type SoldEvent = { playerId: string; teamId: TeamId; price: Lakh };

export interface ServerToClient {
  'room:state': (snapshot: RoomSnapshot) => void;
  'auction:bid': (e: BidEvent) => void;
  'auction:sold': (e: SoldEvent) => void;
  'auction:unsold': (e: { playerId: string }) => void;
}
