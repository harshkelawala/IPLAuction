import { randomUUID } from 'node:crypto';
import type { Player } from '@ipl/data';
import { buildSets, mulberry32 } from '@ipl/data';
import type { AiOptions, AuctionEvent, TeamController } from '@ipl/engine';
import { Auction, aiBidDelay, aiWantsToBid, assignPersonalities, grade, poolSetup, teamStrength, valueForMoney } from '@ipl/engine';
import type { LogEntry, PublicPlayer, RoomSnapshot, ServerToClient, SetView, SoloSettings, Welcome } from '@ipl/protocol';
import type { AuctionSettings, BidCheck, Lakh, TeamId } from '@ipl/rules';
import { MEGA_DEFAULTS, TEAM_IDS } from '@ipl/rules';

type LogEntryInput = LogEntry extends infer E ? (E extends LogEntry ? Omit<E, "id"> : never) : never;

/** How long an unstarred player stays on screen before auto-skip settles him (ms). */
const AUTO_SKIP_MS = 700;

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
  private readonly sets: SetView[];
  private closeTimer: NodeJS.Timeout | null = null;
  private aiTimer: NodeJS.Timeout | null = null;
  private autoSkipTimer: NodeJS.Timeout | null = null;
  private watchlist = new Set<string>();
  private autoSkip = false;
  private paused = false;
  /** Why the auction is paused: you pressed Pause, or nobody is watching. */
  private pausedBy: 'user' | 'away' | null = null;
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
    this.sets = buildSets(pool, 'mega');
    this.auction = new Auction({
      players: pool,
      sets: this.sets,
      settings: this.settings,
      controllers,
      seed,
      acceleratedTimerMs: Math.round(t.accelerated * this.scale),
    });
    this.publicPlayers = pool.map(toPublic);
  }

  welcome(): Welcome {
    return {
      roomId: this.id,
      players: this.publicPlayers,
      sets: this.sets.map((x) => ({ code: x.code, label: x.label, playerIds: [...x.playerIds] })),
    };
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

  /**
   * The human sits this player out: the AI teams settle the bidding instantly
   * (no reaction delays), the hammer falls, and the next player comes up.
   */
  skip(): { ok: true } | { ok: false; message: string } {
    this.lastActivity = this.now();
    const lot = this.auction.currentLot;
    if (!lot) return { ok: false, message: 'No player is up' };
    if (this.paused) return { ok: false, message: 'Resume the auction first' };
    if (lot.leader === this.human) return { ok: false, message: 'You hold the highest bid. Wait for the hammer or a rival raise.' };
    this.clearTimers();
    this.handle(this.settleWithoutYou(this.now()));
    return { ok: true };
  }

  /**
   * End the auction now: the AI teams settle every remaining player instantly (you keep
   * the squad you have; if you hold the highest bid on the current player, he's yours).
   */
  finishNow(): void {
    this.lastActivity = this.now();
    this.clearTimers();
    this.paused = false;
    this.pausedBy = null;
    this.pausedRemainingMs = null;
    const now = this.now();
    // Record results quietly, then send one update instead of one per player.
    for (let i = 0; i < 2_000 && !this.isDone; i++) {
      for (const e of this.settleWithoutYou(now)) this.record(e);
    }
    this.broadcast();
  }

  /** AI teams bid on the current player with no delays, then the hammer falls. */
  private settleWithoutYou(now: number): AuctionEvent[] {
    const lot = this.auction.currentLot;
    if (!lot) return [];
    for (let i = 0; i < 10_000; i++) {
      const keen = TEAM_IDS.filter((id) => id !== this.human && aiWantsToBid(this.auction, id, this.ai));
      if (keen.length === 0) break;
      const team = keen[Math.floor(this.rng() * keen.length)] as TeamId;
      const amount = this.auction.nextBidAmount();
      if (amount === null || !this.auction.placeBid(team, amount, now).check.ok) break;
    }
    this.auction.setDeadline(now);
    return this.auction.tick(now);
  }

  /** Add an auction event to the results log without announcing it. */
  private record(e: AuctionEvent): void {
    if (e.type === 'sold') this.pushLog({ kind: 'sold', playerId: e.playerId, teamId: e.teamId, price: e.price });
    if (e.type === 'unsold') this.pushLog({ kind: 'unsold', playerId: e.playerId });
    if (e.type === 'phase' && e.phase !== 'main') this.pushLog({ kind: 'phase', phase: e.phase });
  }

  /** Replace the watchlist and auto-skip setting, then re-plan the current player. */
  setWatch(playerIds: string[], autoSkip: boolean): void {
    this.lastActivity = this.now();
    this.watchlist = new Set(playerIds.filter((id) => this.auction.players.has(id)));
    this.autoSkip = autoSkip;
    this.broadcast();
    this.schedule();
  }

  pause(by: 'user' | 'away' = 'user'): void {
    const lot = this.auction.currentLot;
    if (this.paused || !lot) return;
    this.paused = true;
    this.pausedBy = by;
    this.pausedRemainingMs = Math.max(0, lot.endsAt - this.now());
    this.clearTimers();
    this.broadcast();
  }

  /** Resume only if the auction paused itself because you left (not if you pressed Pause). */
  resumeIfAway(): void {
    if (this.pausedBy === 'away') this.resume();
  }

  resume(): void {
    if (!this.paused) return;
    this.lastActivity = this.now();
    this.paused = false;
    this.pausedBy = null;
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
        minIndians: this.settings.minIndians,
        difficulty: this.solo.difficulty,
        speed: this.solo.speed,
        pool: this.solo.pool,
        bidTimerMs: this.settings.bidTimerMs,
      },
      teams: this.teamViews(),
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
      upcoming: a.upcoming.map((q) => q.playerId),
      watchlist: [...this.watchlist],
      autoSkip: this.autoSkip,
    };
  }

  private teamViews(): RoomSnapshot['teams'] {
    const a = this.auction;
    const rows = TEAM_IDS.map((id) => {
      const t = a.team(id);
      const strength = teamStrength(
        t.squad.map((s) => a.player(s.playerId)),
        this.settings,
      );
      return { id, t, strength };
    });
    const ranked = [...rows].sort((x, y) => y.strength.overall - x.strength.overall);
    return rows.map(({ id, t, strength }) => ({
      id,
      controller: t.controller.kind,
      isYou: id === this.human,
      purse: t.purse,
      squad: t.squad.map((s) => ({ playerId: s.playerId, price: s.price })),
      overseasCount: t.overseasCount,
      strength: {
        overall: strength.overall,
        batting: strength.batting,
        bowling: strength.bowling,
        grade: grade(strength.overall),
        rank: ranked.findIndex((r) => r.id === id) + 1,
        balance: strength.balance,
        pace: strength.pace,
        spin: strength.spin,
        xi: strength.xi,
        issues: strength.issues,
        notes: strength.notes,
        value: valueForMoney(strength.overall, this.settings.purse - t.purse),
      },
    }));
  }

  // ------------------------------------------------------------------ internals

  private handle(events: AuctionEvent[]): void {
    for (const e of events) {
      switch (e.type) {
        case 'bid':
          this.emit('auction:bid', { roomId: this.id, playerId: e.playerId, teamId: e.teamId, amount: e.amount });
          break;
        case 'sold':
          this.pushLog({ kind: 'sold', playerId: e.playerId, teamId: e.teamId, price: e.price });
          this.emit('auction:sold', { roomId: this.id, playerId: e.playerId, teamId: e.teamId, price: e.price });
          break;
        case 'unsold':
          this.pushLog({ kind: 'unsold', playerId: e.playerId });
          this.emit('auction:unsold', { roomId: this.id, playerId: e.playerId });
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
    if (this.autoSkipTimer) clearTimeout(this.autoSkipTimer);
    this.closeTimer = null;
    this.aiTimer = null;
    this.autoSkipTimer = null;
  }

  /** Arm the hammer for the current lot and, if any AI wants the player, its next bid. */
  private schedule(): void {
    this.clearTimers();
    const lot = this.auction.currentLot;
    if (this.paused || !lot || this.isDone) return;
    const now = this.now();

    this.closeTimer = setTimeout(() => this.handle(this.auction.tick(this.now())), Math.max(0, lot.endsAt - now));

    // Auto-skip: give the player a moment on screen, then settle him without you.
    if (this.autoSkip && !this.watchlist.has(lot.playerId) && lot.leader !== this.human) {
      const playerId = lot.playerId;
      this.autoSkipTimer = setTimeout(() => {
        if (this.auction.currentLot?.playerId === playerId && !this.paused) this.skip();
      }, Math.round(AUTO_SKIP_MS * this.scale));
      return;
    }

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
