import type { AuctionSet, Player } from '@ipl/data';
import { mulberry32, shuffleSet } from '@ipl/data';
import type { AuctionSettings, BidCheck, Lakh, LotPlayer, TeamId, TeamState } from '@ipl/rules';
import { TEAM_IDS, checkBid, nextBid, settleSale } from '@ipl/rules';
import type { AuctionEvent, Lot, Phase, Sale, TeamController, TeamRuntime } from './types';

/** Timer for both opening and bids in the accelerated round. */
export const ACCELERATED_TIMER_MS = 5_000;

export interface AuctionConfig {
  players: Player[];
  sets: AuctionSet[];
  settings: AuctionSettings;
  controllers: Record<TeamId, TeamController>;
  /** Seed for the order of players within each set. Same seed, same order. */
  seed: number;
  /** Timer for the accelerated round; defaults to ACCELERATED_TIMER_MS. */
  acceleratedTimerMs?: number;
}

interface QueueItem {
  playerId: string;
  setCode: string;
}

/**
 * The authoritative auction state machine.
 *
 * It has no clock of its own: every call takes `now` (ms), so the real server
 * drives it with wall-clock time and simulations can jump straight to the next event.
 * Every method returns the events it produced, ready to broadcast.
 */
export class Auction {
  readonly settings: AuctionSettings;
  readonly players: ReadonlyMap<string, Player>;
  readonly teams: Map<TeamId, TeamRuntime>;

  private phase: Phase = 'lobby';
  private queue: QueueItem[] = [];
  private lot: Lot | null = null;
  private readonly sales: Sale[] = [];
  private readonly unsold: string[] = [];
  private readonly offeredInAccelerated = new Set<string>();
  private readonly totalLots: number;
  private lotsDone = 0;

  constructor(private readonly config: AuctionConfig) {
    this.settings = config.settings;
    this.players = new Map(config.players.map((p) => [p.id, p]));
    this.teams = new Map(
      TEAM_IDS.map((id) => [
        id,
        { teamId: id, controller: config.controllers[id], purse: config.settings.purse, squad: [], overseasCount: 0 },
      ]),
    );
    const rng = mulberry32(config.seed);
    for (const set of config.sets) {
      for (const playerId of shuffleSet(set.playerIds, rng)) {
        if (!this.players.has(playerId)) throw new Error(`Set ${set.code} has unknown player ${playerId}`);
        this.queue.push({ playerId, setCode: set.code });
      }
    }
    this.totalLots = this.queue.length;
  }

  // ------------------------------------------------------------------ reads

  get currentPhase(): Phase {
    return this.phase;
  }

  get currentLot(): Readonly<Lot> | null {
    return this.lot;
  }

  get allSales(): readonly Sale[] {
    return this.sales;
  }

  get unsoldPlayers(): readonly string[] {
    return this.unsold;
  }

  /** Players not yet put up in the current phase. */
  get upcoming(): readonly QueueItem[] {
    return this.queue;
  }

  /** 0 at the start of the main round, 1 when its last lot closes. */
  get progress(): number {
    return this.phase === 'main' ? this.lotsDone / Math.max(1, this.totalLots) : 1;
  }

  player(id: string): Player {
    const p = this.players.get(id);
    if (!p) throw new Error(`Unknown player ${id}`);
    return p;
  }

  team(id: TeamId): TeamRuntime {
    const t = this.teams.get(id);
    if (!t) throw new Error(`Unknown team ${id}`);
    return t;
  }

  teamState(id: TeamId): TeamState {
    const t = this.team(id);
    return { teamId: id, purse: t.purse, squadCount: t.squad.length, overseasCount: t.overseasCount };
  }

  lotPlayer(id: string): LotPlayer {
    const p = this.player(id);
    return { id: p.id, role: p.role, isOverseas: p.isOverseas, basePrice: p.basePrice };
  }

  /** The amount the next bid on the current lot must be, or null if no lot is open. */
  nextBidAmount(): Lakh | null {
    if (!this.lot) return null;
    return nextBid(this.lot.currentBid, this.player(this.lot.playerId).basePrice, this.settings.increments);
  }

  /** Whether `teamId` could bid `amount` right now; what the UI uses to enable the Bid button. */
  canBid(teamId: TeamId, amount: Lakh | null = this.nextBidAmount()): BidCheck {
    if (!this.lot || amount === null) return { ok: false, reason: 'WRONG_AMOUNT', message: 'No player is up' };
    return checkBid(
      this.teamState(teamId),
      this.lotPlayer(this.lot.playerId),
      amount,
      { currentBid: this.lot.currentBid, leadingTeam: this.lot.leader },
      this.settings,
    );
  }

  // ------------------------------------------------------------------ writes

  start(now: number): AuctionEvent[] {
    if (this.phase !== 'lobby') throw new Error('Auction already started');
    this.phase = 'main';
    return [{ type: 'phase', phase: 'main' }, ...this.openNextLot(now)];
  }

  /** Validate and apply a bid. Throws nothing: an invalid bid returns the rejection. */
  placeBid(teamId: TeamId, amount: Lakh, now: number): { check: BidCheck; events: AuctionEvent[] } {
    const lot = this.lot;
    if (!lot || this.phase === 'done') {
      return { check: { ok: false, reason: 'WRONG_AMOUNT', message: 'No player is up' }, events: [] };
    }
    if (now >= lot.endsAt) {
      return { check: { ok: false, reason: 'WRONG_AMOUNT', message: 'Too late, the hammer has fallen' }, events: [] };
    }
    const check = this.canBid(teamId, amount);
    if (!check.ok) return { check, events: [] };
    lot.currentBid = amount;
    lot.leader = teamId;
    lot.bidCount += 1;
    lot.endsAt = now + this.bidTimer();
    return { check, events: [{ type: 'bid', playerId: lot.playerId, teamId, amount, endsAt: lot.endsAt }] };
  }

  /** Move the current lot's deadline, e.g. to resume after a pause. */
  setDeadline(endsAt: number): void {
    if (this.lot) this.lot.endsAt = endsAt;
  }

  /** Human-readable name of a set, e.g. "Capped batters 2". */
  setLabel(code: string): string {
    if (code === 'ACC') return 'Accelerated round';
    return this.config.sets.find((s) => s.code === code)?.label ?? code;
  }

  /** Lots closed so far in the main round, and how many it has. */
  get lotCounts(): { done: number; total: number } {
    return { done: this.lotsDone, total: this.totalLots };
  }

  /** Close the lot if its timer has run out, then put up the next player. */
  tick(now: number): AuctionEvent[] {
    if (!this.lot || now < this.lot.endsAt) return [];
    return [...this.closeLot(), ...this.openNextLot(now)];
  }

  // ------------------------------------------------------------------ internals

  private bidTimer(): number {
    return this.phase === 'accelerated' ? this.acceleratedTimer() : this.settings.bidTimerMs;
  }

  private openingTimer(): number {
    return this.phase === 'accelerated' ? this.acceleratedTimer() : this.settings.openingTimerMs;
  }

  private acceleratedTimer(): number {
    return this.config.acceleratedTimerMs ?? ACCELERATED_TIMER_MS;
  }

  private closeLot(): AuctionEvent[] {
    const lot = this.lot;
    if (!lot) return [];
    this.lot = null;
    if (this.phase === 'main') this.lotsDone += 1;
    if (lot.leader === null || lot.currentBid === null) {
      if (this.phase === 'main') this.unsold.push(lot.playerId);
      else {
        // Unsold twice: out of the auction.
        const i = this.unsold.indexOf(lot.playerId);
        if (i === -1) this.unsold.push(lot.playerId);
      }
      return [{ type: 'unsold', playerId: lot.playerId }];
    }
    const player = this.lotPlayer(lot.playerId);
    const team = this.team(lot.leader);
    const { purseCharge, playerSalary } = settleSale(player, lot.currentBid, this.settings);
    team.purse -= purseCharge;
    team.squad.push({ playerId: lot.playerId, price: purseCharge });
    if (player.isOverseas) team.overseasCount += 1;
    const i = this.unsold.indexOf(lot.playerId);
    if (i !== -1) this.unsold.splice(i, 1);
    this.sales.push({
      playerId: lot.playerId,
      teamId: lot.leader,
      price: purseCharge,
      salary: playerSalary,
      phase: this.phase === 'accelerated' ? 'accelerated' : 'main',
    });
    return [{ type: 'sold', playerId: lot.playerId, teamId: lot.leader, price: purseCharge }];
  }

  private allFull(): boolean {
    return [...this.teams.values()].every((t) => t.squad.length >= this.settings.maxSquad);
  }

  private openNextLot(now: number): AuctionEvent[] {
    const events: AuctionEvent[] = [];
    if (this.allFull()) return [...events, ...this.finish('all_full')];

    if (this.queue.length === 0 && this.phase === 'main') {
      // Accelerated round: unsold players come back once, most valuable first.
      const again = this.unsold
        .filter((id) => !this.offeredInAccelerated.has(id))
        .sort((a, b) => this.player(b).fairValue - this.player(a).fairValue);
      if (again.length === 0) return this.finish('pool_empty');
      this.phase = 'accelerated';
      events.push({ type: 'phase', phase: 'accelerated' });
      this.queue = again.map((playerId) => ({ playerId, setCode: 'ACC' }));
    }

    const item = this.queue.shift();
    if (!item) return [...events, ...this.finish('pool_empty')];
    if (this.phase === 'accelerated') this.offeredInAccelerated.add(item.playerId);

    this.lot = { playerId: item.playerId, setCode: item.setCode, currentBid: null, leader: null, endsAt: now + this.openingTimer(), bidCount: 0 };
    events.push({
      type: 'player_up',
      playerId: item.playerId,
      setCode: item.setCode,
      basePrice: this.player(item.playerId).basePrice,
      endsAt: this.lot.endsAt,
    });
    return events;
  }

  private finish(reason: 'pool_empty' | 'all_full'): AuctionEvent[] {
    this.phase = 'done';
    this.lot = null;
    this.queue = [];
    return [
      { type: 'phase', phase: 'done' },
      { type: 'ended', reason },
    ];
  }

  /** For tests and tools: the seed this auction was built with. */
  get seed(): number {
    return this.config.seed;
  }
}
