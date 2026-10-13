import type { AuctionSet, Player } from '@ipl/data';
import { mulberry32 } from '@ipl/data';
import type { AuctionSettings, TeamId } from '@ipl/rules';
import { TEAM_IDS } from '@ipl/rules';
import { aiBidDelay, aiWantsToBid, assignPersonalities, type AiOptions } from './ai';
import { Auction } from './auction';
import type { Difficulty, TeamController } from './types';

export interface SimulationOptions {
  players: Player[];
  sets: AuctionSet[];
  settings: AuctionSettings;
  seed: number;
  difficulty?: Difficulty;
}

/**
 * Run a whole auction with 10 AI teams on a virtual clock.
 * Each step, every AI that wants the player picks a reaction delay; the fastest bids.
 * When nobody wants to bid, the clock jumps to the hammer.
 */
export function simulateAuction(opts: SimulationOptions): Auction {
  const rng = mulberry32(opts.seed ^ 0x9e3779b9);
  const personalities = assignPersonalities(TEAM_IDS, rng);
  const controllers = Object.fromEntries(
    TEAM_IDS.map((id) => [id, { kind: 'ai', personality: personalities[id] } satisfies TeamController]),
  ) as Record<TeamId, TeamController>;
  const ai: AiOptions = { difficulty: opts.difficulty ?? 'normal', seed: opts.seed };

  const auction = new Auction({ players: opts.players, sets: opts.sets, settings: opts.settings, controllers, seed: opts.seed });
  let now = 0;
  auction.start(now);

  let guard = 0;
  while (auction.currentPhase !== 'done') {
    if (++guard > 1_000_000) throw new Error('Simulation did not finish');
    const lot = auction.currentLot;
    if (!lot) break;
    const keen = TEAM_IDS.filter((id) => aiWantsToBid(auction, id, ai));
    if (keen.length === 0) {
      now = lot.endsAt;
      auction.tick(now);
      continue;
    }
    const msLeft = lot.endsAt - now;
    let best: TeamId = keen[0] as TeamId;
    let bestDelay = Number.POSITIVE_INFINITY;
    for (const id of keen) {
      const d = Math.min(aiBidDelay(rng, msLeft), msLeft - 1);
      if (d < bestDelay) {
        bestDelay = d;
        best = id;
      }
    }
    now += Math.max(0, bestDelay);
    const amount = auction.nextBidAmount();
    if (amount === null) break;
    const { check } = auction.placeBid(best, amount, now);
    if (!check.ok) throw new Error(`AI bid rejected: ${check.reason}`);
  }
  return auction;
}
