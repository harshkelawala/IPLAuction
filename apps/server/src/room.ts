import { randomUUID } from 'node:crypto';
import type { Player } from '@ipl/data';
import { buildSets, mulberry32 } from '@ipl/data';
import type { AiOptions, AuctionEvent, TeamController } from '@ipl/engine';
import { Auction, aiBidDelay, aiWantsToBid, assignPersonalities, poolSetup } from '@ipl/engine';
import type { LogEntry, PublicPlayer, RoomSnapshot, ServerToClient, SoloSettings, Welcome } from '@ipl/protocol';
import type { AuctionSettings, BidCheck, Lakh, TeamId } from '@ipl/rules';
import { MEGA_DEFAULTS, TEAM_IDS } from '@ipl/rules';

type LogEntryInput = LogEntry extends infer E ? (E extends LogEntry ? Omit<E, "id"> : never) : never;

const TIMERS = {
  normal: { opening: 15_000, bid: 10_000, accelerated: 6_000 },
  fast: { opening: 6_000, bid: 5_000, accelerated: 4_000 },
} as const;

/** AI reaction times (ms) while several AIs are still well inside their limits: a quick-fire war. */
const QUICK_FIRE = { normal: [350, 900], fast: [150, 400] } as const;

export interface RoomOptions {
  settings: SoloSettings;
  players: Player[];
  seed?: number;
  /** Multiply every timer and AI delay; tests use a small value. */
  timeScale?: number;
  emit: <E extends keyof ServerToClient>(event: E, ...args: Parameters<ServerToClient[E]>) => void;
  now?: () => number;
}

/** One auction room: the engine plus real timers and the AI teams. */
export class Room {
  readonly id = randomUUID().slice(0, 8);
  readonly token = randomUUID();
  readonly human: TeamId;
  readonly auction: Auction;
  readonly settings: AuctionSettings;
  readonly solo: SoloSettings;
  lastActivity: number;

  private readonly emit: RoomOptions['emit'];
  private readonly now: () => number;
  private readonly scale: number;
  private readonly rng: () => number;
  private readonly ai: AiOptions;
  private readonly publicPlayers: PublicPlayer[];
  private closeTimer: NodeJS.Timeout | null = null;
  private aiTimer: NodeJS.Timeout | null = null;
  private paused = false;
  private pausedRemainingMs: number | null = null;
  private log: LogEntry[] = [];
  private logId = 0;

  constructor(opts: RoomOptions) {
    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    this.solo = opts.settings;
    this.human = opts.settings.teamId;
    this.emit = opts.emit;
    this.now = opts.now ?? Date.now;
    this.scale = opts.timeScale ?? 1;
    this.rng = mulberry32(seed ^ 0x2545f491);
    this.ai = { difficulty: opts.settings.difficulty, seed };
    this.lastActivity = this.now();

    const t = TIMERS[opts.settings.speed];
    const { pool, settings } = poolSetup(opts.players, opts.settings.pool, {
      ...MEGA_DEFAULTS,
      openingTimerMs: Math.round(t.opening * this.scale),
      bidTimerMs: Math.round(t.bid * this.scale),
    });
    this.settings = settings;
    const personalities = assignPersonalities(TEAM_IDS, this.rng);
    const controllers = Object.fromEntries(
      TEAM_IDS.map((id) => [
        id,
        id === this.human ? { kind: 'human' } : { kind: 'ai', personality: personalities[id] },
      ]),
    ) as Record<TeamId, TeamController>;
    this.auction = new Auction({
      players: pool,
      sets: buildSets(pool, 'mega'),
      settings: this.settings,
      controllers,
      seed,
      acceleratedTimerMs: Math.round(t.accelerated * this.scale),
    });
    this.publicPlayers = pool.map(toPublic);
  }

  welcome(): Welcome {
    return { roomId: this.id, players: this.publicPlayers };
  }

  start(): void {
    this.handle(this.auction.start(this.now()));
  }

  get isDone(): boolean {
    return this.auction.currentPhase === 'done';
  }

  get isPaused(): boolean {
    return this.paused;
  }

  bid(teamId: TeamId, amount: Lakh): BidCheck {
    this.lastActivity = this.now();
    if (this.paused) return { ok: false, reason: 'WRONG_AMOUNT', message: 'The auction is paused' };
    const { check, events } = this.auction.placeBid(teamId, amount, this.now());
    if (check.ok) this.handle(events);
    return check;
  }

  pause(): void {
    const lot = this.auction.currentLot;
    if (this.paused || !lot) return;
    this.paused = true;
    this.pausedRemainingMs = Math.max(0, lot.endsAt - this.now());
    this.clearTimers();
    this.broadcast();
  }

  resume(): void {
    if (!this.paused) return;
    this.lastActivity = this.now();
    this.paused = false;
    // Never resume into a hammer-fall: give at least the bid timer's worth of time.
    const left = Math.max(this.pausedRemainingMs ?? 0, this.settings.bidTimerMs / 2);
    this.auction.setDeadline(this.now() + left);
    this.pausedRemainingMs = null;
    this.broadcast();
    this.schedule();
  }

  dispose(): void {
    this.clearTimers();
  }

  snapshot(): RoomSnapshot {
    const a = this.auction;
    const lot = a.currentLot;
    const nextBid = a.nextBidAmount();
    return {
      roomId: this.id,
      phase: a.currentPhase,
      paused: this.paused,
      pausedRemainingMs: this.pausedRemainingMs,
      serverNow: this.now(),
      you: this.human,
      settings: {
        purse: this.settings.purse,
        minSquad: this.settings.minSquad,
        maxSquad: this.settings.maxSquad,
        maxOverseas: this.settings.maxOverseas,
        difficulty: this.solo.difficulty,
        speed: this.solo.speed,
        pool: this.solo.pool,
        bidTimerMs: this.settings.bidTimerMs,
      },
      teams: TEAM_IDS.map((id) => {
        const t = a.team(id);
        return {
          id,
          controller: t.controller.kind,
          isYou: id === this.human,
          purse: t.purse,
          squad: t.squad.map((s) => ({ playerId: s.playerId, price: s.price })),
          overseasCount: t.overseasCount,
        };
      }),
      lot:
        lot && nextBid !== null
          ? {
              playerId: lot.playerId,
              setCode: lot.setCode,
              setLabel: a.setLabel(lot.setCode),
              currentBid: lot.currentBid,
              leader: lot.leader,
              endsAt: lot.endsAt,
              nextBid,
              bidCount: lot.bidCount,
              yourBid: a.canBid(this.human, nextBid),
            }
          : null,
      log: this.log,
      progress: a.lotCounts,
      unsold: [...a.unsoldPlayers],
    };
  }

  // ------------------------------------------------------------------ internals

  private handle(events: AuctionEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'bid':
          this.emit('auction:bid', { playerId: e.playerId, teamId: e.teamId, amount: e.amount });
          break;
        case 'sold':
          this.pushLog({ kind: 'sold', playerId: e.playerId, teamId: e.teamId, price: e.price });
          this.emit('auction:sold', { playerId: e.playerId, teamId: e.teamId, price: e.price });
          break;
        case 'unsold':
          this.pushLog({ kind: 'unsold', playerId: e.playerId });
          this.emit('auction:unsold', { playerId: e.playerId });
          break;
        case 'phase':
          if (e.phase !== 'main') this.pushLog({ kind: 'phase', phase: e.phase });
          break;
        default:
          break;
      }
    }
    this.broadcast();
    this.schedule();
  }

  private pushLog(entry: LogEntryInput): void {
    this.log = [{ ...entry, id: ++this.logId } as LogEntry, ...this.log].slice(0, 40);
  }

  private broadcast(): void {
    this.emit('room:state', this.snapshot());
  }

  private clearTimers(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    if (this.aiTimer) clearTimeout(this.aiTimer);
    this.closeTimer = null;
    this.aiTimer = null;
  }

  /** Arm the hammer for the current lot and, if any AI wants the player, its next bid. */
  private schedule(): void {
    this.clearTimers();
    const lot = this.auction.currentLot;
    if (this.paused || !lot || this.isDone) return;
    const now = this.now();

    this.closeTimer = setTimeout(() => this.handle(this.auction.tick(this.now())), Math.max(0, lot.endsAt - now));

    const keen = TEAM_IDS.filter((id) => id !== this.human && aiWantsToBid(this.auction, id, this.ai));
    if (keen.length === 0) return;
    const msLeft = lot.endsAt - now;
    const team = keen[Math.floor(this.rng() * keen.length)] as TeamId;
    let delay: number;
    if (keen.length >= 2) {
      const [lo, hi] = QUICK_FIRE[this.solo.speed];
      delay = (lo + this.rng() * (hi - lo)) * this.scale;
    } else {
      delay = aiBidDelay(this.rng, msLeft / this.scale) * this.scale * (this.solo.speed === 'fast' ? 0.5 : 1);
    }
    delay = Math.min(Math.round(delay), Math.max(0, msLeft - Math.round(150 * this.scale)));
    const playerId = lot.playerId;
    const bidCount = lot.bidCount;
    this.aiTimer = setTimeout(() => {
      const current = this.auction.currentLot;
      // The world may have moved on (a human bid, the hammer fell): then just re-plan.
      if (!current || current.playerId !== playerId || current.bidCount !== bidCount || this.paused) return this.schedule();
      const amount = this.auction.nextBidAmount();
      if (amount === null || !aiWantsToBid(this.auction, team, this.ai)) return this.schedule();
      const { check, events } = this.auction.placeBid(team, amount, this.now());
      if (check.ok) this.handle(events);
      else this.schedule();
    }, delay);
  }
}

export function toPublic(p: Player): PublicPlayer {
  return {
    id: p.id,
    name: p.name,
    country: p.country,
    isOverseas: p.isOverseas,
    isCapped: p.isCapped,
    role: p.role,
    battingHand: p.battingHand,
    bowlingStyle: p.bowlingStyle,
    category: p.category,
    basePrice: p.basePrice,
    lastTeam: p.lastTeam,
  };
}
