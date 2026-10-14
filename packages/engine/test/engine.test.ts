import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSets, type AuctionSet, type Player } from '@ipl/data';
import { MEGA_DEFAULTS, TEAM_IDS, type TeamId } from '@ipl/rules';
import {
  ACCELERATED_TIMER_MS,
  Auction,
  aiMaxPrice,
  isInterested,
  needMultiplier,
  noise,
  personalityMultiplier,
  simulateAuction,
  type TeamController,
} from '../src/index';

const s = MEGA_DEFAULTS;
const allAi = Object.fromEntries(TEAM_IDS.map((id) => [id, { kind: 'ai', personality: 'balanced' }])) as Record<
  TeamId,
  TeamController
>;

function fakePlayer(id: string, over: Partial<Player> = {}): Player {
  return {
    id,
    name: id,
    country: 'India',
    isOverseas: false,
    isCapped: true,
    role: 'BAT',
    battingHand: 'R',
    bowlingStyle: null,
    category: 'BA',
    rating: 70,
    battingRating: 70,
    bowlingRating: 70,
    ratingSource: 'price',
    tags: [],
    score: null,
    fairValue: 300,
    basePrice: 100,
    lastTeam: 'CSK',
    contractPrice: 300,
    acquired: 'auction',
    withdrawn: false,
    ...over,
  };
}

function smallAuction(players: Player[], sets?: AuctionSet[]) {
  return new Auction({
    players,
    sets: sets ?? [{ code: 'BA1', label: 'Batters 1', playerIds: players.map((p) => p.id) }],
    settings: s,
    controllers: allAi,
    seed: 7,
  });
}

describe('Auction state machine', () => {
  it('puts the first player up when it starts', () => {
    const a = smallAuction([fakePlayer('a')]);
    const events = a.start(0);
    expect(events.map((e) => e.type)).toEqual(['phase', 'player_up']);
    expect(a.currentLot).toMatchObject({ playerId: 'a', currentBid: null, endsAt: s.openingTimerMs });
  });

  it('opens at base price, steps up, and resets the timer on each bid', () => {
    const a = smallAuction([fakePlayer('a')]);
    a.start(0);
    expect(a.nextBidAmount()).toBe(100);
    expect(a.placeBid('CSK', 100, 1_000).check.ok).toBe(true);
    expect(a.currentLot?.endsAt).toBe(1_000 + s.bidTimerMs);
    expect(a.nextBidAmount()).toBe(110);
    expect(a.placeBid('MI', 110, 2_000).check.ok).toBe(true);
    expect(a.currentLot).toMatchObject({ leader: 'MI', currentBid: 110, bidCount: 2 });
  });

  it('rejects own-bid raises, wrong amounts and late bids', () => {
    const a = smallAuction([fakePlayer('a')]);
    a.start(0);
    a.placeBid('CSK', 100, 1_000);
    expect(a.placeBid('CSK', 110, 1_500).check).toMatchObject({ ok: false, reason: 'OWN_HIGH_BID' });
    expect(a.placeBid('MI', 150, 1_500).check).toMatchObject({ ok: false, reason: 'WRONG_AMOUNT' });
    expect(a.placeBid('MI', 110, 1_000 + s.bidTimerMs).check.ok).toBe(false);
  });

  it('sells to the leader when the timer runs out', () => {
    const a = smallAuction([fakePlayer('a'), fakePlayer('b', { isOverseas: true, country: 'Australia' })]);
    a.start(0);
    const first = a.currentLot?.playerId as string;
    a.placeBid('RCB', a.nextBidAmount() as number, 100);
    expect(a.tick(5_000)).toEqual([]); // not yet
    const events = a.tick(100 + s.bidTimerMs);
    expect(events[0]).toEqual({ type: 'sold', playerId: first, teamId: 'RCB', price: 100 });
    expect(a.team('RCB')).toMatchObject({ purse: s.purse - 100, squad: [{ playerId: first, price: 100 }] });
    expect(events[1]?.type).toBe('player_up');
  });

  it('brings unsold players back once in a faster accelerated round, then ends', () => {
    const a = smallAuction([fakePlayer('a')]);
    a.start(0);
    const e1 = a.tick(s.openingTimerMs);
    expect(e1.map((e) => e.type)).toEqual(['unsold', 'phase', 'player_up']);
    expect(a.currentPhase).toBe('accelerated');
    expect(a.currentLot?.endsAt).toBe(s.openingTimerMs + ACCELERATED_TIMER_MS);
    const e2 = a.tick(s.openingTimerMs + ACCELERATED_TIMER_MS);
    expect(e2.map((e) => e.type)).toEqual(['unsold', 'phase', 'ended']);
    expect(a.currentPhase).toBe('done');
    expect(a.unsoldPlayers).toEqual(['a']);
  });

  it('removes a player from the unsold list when sold in the accelerated round', () => {
    const a = smallAuction([fakePlayer('a')]);
    a.start(0);
    a.tick(s.openingTimerMs);
    // Unsold players come back at the lowest base price.
    expect(a.nextBidAmount()).toBe(s.minBasePrice);
    a.placeBid('GT', s.minBasePrice, s.openingTimerMs + 1);
    a.tick(s.openingTimerMs + 1 + ACCELERATED_TIMER_MS);
    expect(a.allSales).toMatchObject([{ playerId: 'a', teamId: 'GT', phase: 'accelerated' }]);
    expect(a.unsoldPlayers).toEqual([]);
  });

  it('orders players within a set by seed, the same way every time', () => {
    const players = Array.from({ length: 8 }, (_, i) => fakePlayer(`p${i}`));
    const order = (seed: number) => {
      const a = new Auction({ players, sets: [{ code: 'BA1', label: '', playerIds: players.map((p) => p.id) }], settings: s, controllers: allAi, seed });
      return [a.currentLot, ...a.upcoming.map((q) => q.playerId)];
    };
    expect(order(1)).toEqual(order(1));
    expect(order(1)).not.toEqual(order(2));
  });
});

describe('AI', () => {
  it('chases missing roles and backs off full ones', () => {
    const empty = { BAT: 0, WK: 0, AR: 0, BOWL: 0 };
    expect(needMultiplier(empty, 'WK')).toBe(1.4);
    expect(needMultiplier(empty, 'BAT')).toBe(1.25);
    expect(needMultiplier({ ...empty, BAT: 6 }, 'BAT')).toBe(0.6);
    expect(needMultiplier({ ...empty, BAT: 9 }, 'BAT')).toBe(0.3);
  });

  it('applies personalities', () => {
    const star = fakePlayer('x', { rating: 90, lastTeam: 'MI' });
    expect(personalityMultiplier('aggressive', star, 'CSK')).toBe(1.2);
    expect(personalityMultiplier('moneyball', star, 'CSK')).toBe(0.85);
    expect(personalityMultiplier('moneyball', fakePlayer('u', { isCapped: false }), 'CSK')).toBe(1.15);
    expect(personalityMultiplier('loyalist', star, 'MI')).toBe(1.25);
    expect(personalityMultiplier('balanced', star, 'MI')).toBe(1);
  });

  it('has deterministic noise in [-1, 1]', () => {
    expect(noise(1, 'CSK', 'a')).toBe(noise(1, 'CSK', 'a'));
    for (let i = 0; i < 200; i++) {
      const n = noise(i, 'MI', `p${i}`);
      expect(n).toBeGreaterThanOrEqual(-1);
      expect(n).toBeLessThanOrEqual(1);
    }
  });

  it('is always interested in stars', () => {
    for (const id of TEAM_IDS) expect(isInterested(3, id, fakePlayer('star', { rating: 85 }), 0.3)).toBe(true);
  });

  it('never values a player above what the team can afford', () => {
    const star = fakePlayer('star', { rating: 99, fairValue: 5_000, basePrice: 200 });
    const a = smallAuction([star]);
    a.start(0);
    a.team('CSK').purse = 1_000;
    expect(aiMaxPrice(a, 'CSK', 'star', { difficulty: 'normal', seed: 1 })).toBeLessThanOrEqual(1_000 - 17 * 30);
  });

  it('will not bid for an overseas player when overseas slots are full', () => {
    const o = fakePlayer('o', { isOverseas: true, country: 'England', rating: 95, fairValue: 2_000 });
    const a = smallAuction([o]);
    a.start(0);
    a.team('DC').overseasCount = 8;
    expect(aiMaxPrice(a, 'DC', 'o', { difficulty: 'normal', seed: 1 })).toBe(0);
  });
});

describe('10-AI simulation on the real 2026 pool', () => {
  const players = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', '..', 'data', 'generated', 'players-2026.json'), 'utf8'),
  ) as Player[];
  const sets = buildSets(players, 'mega');

  it.each([1, 2, 3])('seed %i ends with legal, realistic squads', (seed) => {
    const a = simulateAuction({ players, sets, settings: s, seed });
    expect(a.currentPhase).toBe('done');
    const ids = a.allSales.map((x) => x.playerId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const t of a.teams.values()) {
      expect(t.squad.length).toBeGreaterThanOrEqual(s.minSquad);
      expect(t.squad.length).toBeLessThanOrEqual(s.maxSquad);
      expect(t.overseasCount).toBeLessThanOrEqual(s.maxOverseas);
      expect(t.purse).toBeGreaterThanOrEqual(0);
      expect(t.squad.reduce((sum, e) => sum + e.price, 0) + t.purse).toBe(s.purse);
    }
    const top = Math.max(...a.allSales.map((x) => x.price));
    expect(top).toBeGreaterThanOrEqual(1_500); // ₹15 cr
    expect(top).toBeLessThanOrEqual(3_500); // ₹35 cr
  });

  it('replays identically from the same seed', () => {
    const a = simulateAuction({ players, sets, settings: s, seed: 9 }).allSales;
    const b = simulateAuction({ players, sets, settings: s, seed: 9 }).allSales;
    expect(a).toEqual(b);
  });
});
