import { describe, expect, it } from 'vitest';
import {
  MEGA_DEFAULTS,
  MINI_DEFAULTS,
  applySale,
  checkBid,
  crore,
  formatLakh,
  incrementFor,
  maxAffordableBid,
  nextBid,
  purseReserve,
  settleSale,
  type LotPlayer,
  type TeamState,
} from '../src/index';

const s = MEGA_DEFAULTS;
const indianBat: LotPlayer = { id: 'p1', role: 'BAT', isOverseas: false, basePrice: crore(2) };
const overseasBowl: LotPlayer = { id: 'p2', role: 'BOWL', isOverseas: true, basePrice: crore(1.5) };
const freshTeam = (over: Partial<TeamState> = {}): TeamState => ({
  teamId: 'CSK',
  purse: s.purse,
  squadCount: 0,
  overseasCount: 0,
  ...over,
});

describe('money', () => {
  it('converts and formats', () => {
    expect(crore(1)).toBe(100);
    expect(crore(14.5)).toBe(1450);
    expect(formatLakh(75)).toBe('₹75 L');
    expect(formatLakh(100)).toBe('₹1 cr');
    expect(formatLakh(1450)).toBe('₹14.5 cr');
    expect(formatLakh(225)).toBe('₹2.25 cr');
  });
});

describe('increments', () => {
  it('uses the slab for the current bid', () => {
    expect(incrementFor(30, s.increments)).toBe(5);
    expect(incrementFor(95, s.increments)).toBe(5);
    expect(incrementFor(100, s.increments)).toBe(10);
    expect(incrementFor(190, s.increments)).toBe(10);
    expect(incrementFor(200, s.increments)).toBe(20);
    expect(incrementFor(480, s.increments)).toBe(20);
    expect(incrementFor(500, s.increments)).toBe(25);
    expect(incrementFor(2000, s.increments)).toBe(25);
  });

  it('opens at base price, then steps', () => {
    expect(nextBid(null, 200, s.increments)).toBe(200);
    expect(nextBid(200, 200, s.increments)).toBe(220);
    expect(nextBid(95, 30, s.increments)).toBe(100);
    expect(nextBid(500, 200, s.increments)).toBe(525);
  });
});

describe('purse reserve', () => {
  it('keeps money for the remaining minimum slots', () => {
    // Empty team: winning this player leaves 17 slots to fill at ₹30 L.
    expect(purseReserve(freshTeam(), s)).toBe(17 * 30);
    expect(maxAffordableBid(freshTeam(), s)).toBe(12500 - 510);
  });

  it('needs no reserve once the minimum is reachable', () => {
    expect(purseReserve(freshTeam({ squadCount: 17 }), s)).toBe(0);
    expect(purseReserve(freshTeam({ squadCount: 22 }), s)).toBe(0);
  });
});

describe('checkBid', () => {
  const open = { currentBid: null, leadingTeam: null };

  it('accepts a valid opening bid', () => {
    expect(checkBid(freshTeam(), indianBat, 200, open, s)).toEqual({ ok: true });
  });

  it('rejects raising your own bid', () => {
    const r = checkBid(freshTeam(), indianBat, 220, { currentBid: 200, leadingTeam: 'CSK' }, s);
    expect(r).toMatchObject({ ok: false, reason: 'OWN_HIGH_BID' });
  });

  it('rejects a full squad', () => {
    const r = checkBid(freshTeam({ squadCount: 25 }), indianBat, 200, open, s);
    expect(r).toMatchObject({ ok: false, reason: 'SQUAD_FULL' });
  });

  it('rejects an overseas player when overseas slots are full', () => {
    const team = freshTeam({ squadCount: 10, overseasCount: 8 });
    expect(checkBid(team, overseasBowl, 150, open, s)).toMatchObject({ reason: 'OVERSEAS_FULL' });
    // Indian players are still fine.
    expect(checkBid(team, indianBat, 200, open, s)).toEqual({ ok: true });
  });

  it('rejects any amount other than the next increment', () => {
    const ctx = { currentBid: 200, leadingTeam: 'MI' as const };
    expect(checkBid(freshTeam(), indianBat, 210, ctx, s)).toMatchObject({ reason: 'WRONG_AMOUNT' });
    expect(checkBid(freshTeam(), indianBat, 220, ctx, s)).toEqual({ ok: true });
  });

  it('rejects a bid that breaks the reserve rule', () => {
    // 10 players, ₹5 cr left: must keep 7 × ₹30 L = ₹2.1 cr, so max bid is ₹2.9 cr.
    const team = freshTeam({ squadCount: 10, purse: 500 });
    expect(maxAffordableBid(team, s)).toBe(290);
    expect(checkBid(team, indianBat, 280, { currentBid: 260, leadingTeam: 'MI' }, s)).toEqual({ ok: true });
    expect(checkBid(team, indianBat, 300, { currentBid: 280, leadingTeam: 'MI' }, s)).toMatchObject({
      reason: 'INSUFFICIENT_PURSE',
    });
  });
});

describe('playing XI rule', () => {
  const open = { currentBid: null, leadingTeam: null };

  it('needs 7 Indians, so an XI never has more than 4 overseas', () => {
    expect(s.minIndians).toBe(7);
  });

  it('blocks an overseas buy that leaves too few slots for Indians', () => {
    // 14-player squads with a loose overseas cap, so only the XI rule can bite.
    const quick = { ...s, minSquad: 11, maxSquad: 14, maxOverseas: 8 };
    // 12 players (6 Indian, 6 overseas): one more overseas leaves 1 slot for the 1 Indian still needed.
    expect(checkBid(freshTeam({ squadCount: 12, overseasCount: 6 }), overseasBowl, 150, open, quick)).toEqual({ ok: true });
    // 13 players (6 Indian, 7 overseas): another overseas leaves no slot for the 7th Indian.
    expect(checkBid(freshTeam({ squadCount: 13, overseasCount: 7 }), overseasBowl, 150, open, quick)).toMatchObject({
      reason: 'XI_RULE',
    });
    // The same team can still buy an Indian.
    expect(checkBid(freshTeam({ squadCount: 13, overseasCount: 7 }), indianBat, 200, open, quick)).toEqual({ ok: true });
  });

  it('keeps purse back for the Indians still needed', () => {
    const quick = { ...s, minSquad: 11, maxSquad: 14, maxOverseas: 8 };
    // 6 players, all overseas: buying another overseas leaves 7 Indians to sign (more than the 4 slots to the minimum).
    const team = freshTeam({ squadCount: 6, overseasCount: 6, purse: 1_000 });
    expect(maxAffordableBid(team, quick, overseasBowl)).toBe(1_000 - 7 * 30);
    expect(maxAffordableBid(team, quick, indianBat)).toBe(1_000 - 6 * 30);
  });
});

describe('sales', () => {
  it('charges the full bid but caps overseas pay in mini mode', () => {
    expect(settleSale(overseasBowl, 2520, MINI_DEFAULTS)).toEqual({ purseCharge: 2520, playerSalary: 1800 });
    expect(settleSale(indianBat, 2520, MINI_DEFAULTS)).toEqual({ purseCharge: 2520, playerSalary: 2520 });
    expect(settleSale(overseasBowl, 2520, MEGA_DEFAULTS)).toEqual({ purseCharge: 2520, playerSalary: 2520 });
  });

  it('updates purse and counts', () => {
    const after = applySale(freshTeam(), overseasBowl, 450);
    expect(after).toMatchObject({ purse: 12050, squadCount: 1, overseasCount: 1 });
  });
});
