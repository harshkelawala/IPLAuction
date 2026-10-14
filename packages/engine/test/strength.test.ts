import { describe, expect, it } from 'vitest';
import type { Player } from '@ipl/data';
import { bestXI, grade, teamStrength, valueForMoney } from '../src/index';

let n = 0;
function p(role: Player['role'], rating: number, overseas = false): Player {
  n++;
  return {
    id: `p${n}`, name: `Player ${n}`, country: overseas ? 'Australia' : 'India', isOverseas: overseas, isCapped: true,
    role, battingHand: 'R', bowlingStyle: role === 'BOWL' || role === 'AR' ? 'RFM' : null,
    category: 'BA', rating, battingRating: rating, bowlingRating: rating, ratingSource: 'price', tags: [], score: null, fairValue: 100, basePrice: 30, lastTeam: 'CSK',
    contractPrice: 100, acquired: 'auction', withdrawn: false,
  };
}

const balanced = () => [
  p('WK', 80), p('BAT', 85), p('BAT', 82), p('BAT', 78), p('AR', 84), p('AR', 76),
  p('BOWL', 88), p('BOWL', 83), p('BOWL', 79), p('BOWL', 74), p('BAT', 70), p('BOWL', 65),
];

describe('best XI', () => {
  it('picks 11 with a keeper and at least 5 bowling options', () => {
    const xi = bestXI(balanced());
    expect(xi).toHaveLength(11);
    expect(xi.some((x) => x.role === 'WK')).toBe(true);
    expect(xi.filter((x) => x.role === 'BOWL' || x.role === 'AR').length).toBeGreaterThanOrEqual(5);
  });

  it('never picks more than 4 overseas', () => {
    const squad = [...Array.from({ length: 8 }, () => p('BAT', 95, true)), ...Array.from({ length: 7 }, () => p('BOWL', 60))];
    expect(bestXI(squad).filter((x) => x.isOverseas)).toHaveLength(4);
  });
});

describe('attack mix and value', () => {
  const withStyle = (pl: Player, style: Player['bowlingStyle']) => ({ ...pl, bowlingStyle: style });

  it('wants 2 pace and a spinner, and rewards a balanced attack', () => {
    const allPace = balanced().map((x) => (x.role === 'BOWL' || x.role === 'AR' ? withStyle(x, 'RFM') : x));
    const s1 = teamStrength(allPace, { minSquad: 11 });
    expect(s1.spin).toBe(0);
    expect(s1.issues).toContain('No spinner in the XI');

    const mixed = balanced().map((x, i) =>
      x.role === 'BOWL' || x.role === 'AR' ? withStyle(x, i % 2 === 0 ? 'LB' : 'RF') : x,
    );
    const s2 = teamStrength(mixed, { minSquad: 11 });
    expect(s2.pace).toBeGreaterThanOrEqual(2);
    expect(s2.spin).toBeGreaterThanOrEqual(1);
    expect(s2.issues).not.toContain('No spinner in the XI');
    expect(s2.overall).toBeGreaterThan(s1.overall);
  });

  it('counts an empty bench as replacement level, not a disaster', () => {
    const eleven = balanced().slice(0, 11);
    expect(teamStrength(eleven, { minSquad: 11 }).bench).toBe(60);
  });

  it('scores value as strength above replacement per 10 crore', () => {
    expect(valueForMoney(90, 10_000)).toBe(3);
    expect(valueForMoney(90, 0)).toBeNull();
  });
});

describe('team strength', () => {
  it('scores a better squad higher', () => {
    const strong = teamStrength(balanced(), { minSquad: 11 });
    const weak = teamStrength(balanced().map((x) => ({ ...x, rating: x.rating - 15, battingRating: x.rating - 15, bowlingRating: x.rating - 15 })), { minSquad: 11 });
    expect(strong.overall).toBeGreaterThan(weak.overall);
    // The fixture's bowlers are all pace, so the only issue is the missing spinner.
    expect(strong.issues).toEqual(['No spinner in the XI']);
  });

  it('flags a missing keeper and too few bowlers', () => {
    const squad = Array.from({ length: 11 }, () => p('BAT', 80));
    const s = teamStrength(squad, { minSquad: 11 });
    expect(s.issues).toContain('No wicketkeeper');
    expect(s.issues.join()).toContain('bowling option');
    expect(s.overall).toBeLessThan(teamStrength(balanced(), { minSquad: 11 }).overall);
  });

  it('handles an empty squad', () => {
    const s = teamStrength([], { minSquad: 11 });
    expect(s.xi).toEqual([]);
    expect(s.overall).toBeGreaterThanOrEqual(0);
  });

  it('grades on the calibrated scale', () => {
    expect([grade(92), grade(91), grade(89), grade(87), grade(86), grade(80)]).toEqual(['A+', 'A', 'B+', 'B', 'C', 'D']);
  });
});
