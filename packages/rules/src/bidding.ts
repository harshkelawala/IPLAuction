import type {
  AuctionSettings,
  BidCheck,
  IncrementSlab,
  Lakh,
  LotPlayer,
  TeamId,
  TeamState,
} from './types';

/** The step that applies on top of the current bid. */
export function incrementFor(current: Lakh, slabs: IncrementSlab[]): Lakh {
  for (const slab of slabs) {
    if (current < slab.below) return slab.step;
  }
  const last = slabs.at(-1);
  if (!last) throw new Error('No increment slabs configured');
  return last.step;
}

/** The only amount a team may bid next: the base price if nobody has bid, else current + step. */
export function nextBid(current: Lakh | null, basePrice: Lakh, slabs: IncrementSlab[]): Lakh {
  if (current === null) return basePrice;
  return current + incrementFor(current, slabs);
}

/**
 * Money a team must keep back so it can still reach the minimum squad
 * at the cheapest base price, assuming it wins the current player.
 */
export function purseReserve(team: TeamState, settings: AuctionSettings): Lakh {
  const slotsStillNeeded = Math.max(0, settings.minSquad - (team.squadCount + 1));
  return slotsStillNeeded * settings.minBasePrice;
}

/** The most this team can bid on the current player without breaking the reserve rule. */
export function maxAffordableBid(team: TeamState, settings: AuctionSettings): Lakh {
  return team.purse - purseReserve(team, settings);
}

export interface BidContext {
  /** Highest accepted bid so far for this player, or null if none. */
  currentBid: Lakh | null;
  /** Team holding the highest bid, or null if none. */
  leadingTeam: TeamId | null;
}

/**
 * Whether `team` may place a bid of `amount` on `player` right now.
 * The server calls this for every bid; clients call it to grey out the Bid button.
 */
export function checkBid(
  team: TeamState,
  player: LotPlayer,
  amount: Lakh,
  ctx: BidContext,
  settings: AuctionSettings,
): BidCheck {
  if (ctx.leadingTeam === team.teamId) {
    return { ok: false, reason: 'OWN_HIGH_BID', message: 'You already hold the highest bid' };
  }
  if (team.squadCount >= settings.maxSquad) {
    return { ok: false, reason: 'SQUAD_FULL', message: `Squad is full (${settings.maxSquad} players)` };
  }
  if (player.isOverseas && team.overseasCount >= settings.maxOverseas) {
    return {
      ok: false,
      reason: 'OVERSEAS_FULL',
      message: `Overseas slots full (${settings.maxOverseas})`,
    };
  }
  const expected = nextBid(ctx.currentBid, player.basePrice, settings.increments);
  if (amount !== expected) {
    return { ok: false, reason: 'WRONG_AMOUNT', message: 'Bid must be the next increment' };
  }
  if (amount > maxAffordableBid(team, settings)) {
    return {
      ok: false,
      reason: 'INSUFFICIENT_PURSE',
      message: 'Not enough purse left after reserving money for your minimum squad',
    };
  }
  return { ok: true };
}

/** What a sale does to the money: the purse pays the full bid; the player's salary may be capped. */
export function settleSale(
  player: LotPlayer,
  winningBid: Lakh,
  settings: AuctionSettings,
): { purseCharge: Lakh; playerSalary: Lakh } {
  const cap = settings.overseasSalaryCap;
  const playerSalary = player.isOverseas && cap !== null ? Math.min(winningBid, cap) : winningBid;
  return { purseCharge: winningBid, playerSalary };
}

/** Apply a sale to a team's state. Returns a new object. */
export function applySale(team: TeamState, player: LotPlayer, winningBid: Lakh): TeamState {
  return {
    ...team,
    purse: team.purse - winningBid,
    squadCount: team.squadCount + 1,
    overseasCount: team.overseasCount + (player.isOverseas ? 1 : 0),
  };
}
