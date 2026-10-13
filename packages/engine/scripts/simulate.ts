/**
 * Headless 10-AI auctions: do the prices look like a real IPL auction?
 *
 *   npm run simulate                 # 20 seeds, mega mode, full pool
 *   npm run simulate -- --runs 50 --difficulty hard
 *
 * Prints price distribution, spending, squad health and how sim prices
 * line up with the players' real 2026 contracts.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPlayers, buildSets, parseCsv } from '@ipl/data';
import { MEGA_DEFAULTS, formatLakh } from '@ipl/rules';
import { simulateAuction } from '../src/simulate.js';
import type { Difficulty } from '../src/types.js';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
};
const runs = Number(arg('runs', '20'));
const difficulty = arg('difficulty', 'normal') as Difficulty;

const csv = readFileSync(join(import.meta.dirname, '..', '..', 'data', 'raw', 'squads-2026.csv'), 'utf8');
const players = buildPlayers(parseCsv(csv));
const sets = buildSets(players, 'mega');
const byId = new Map(players.map((p) => [p.id, p]));

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] as number) : 0;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/** Spearman rank correlation. */
function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => {
    const order = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(xs.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]?.[0] === order[i]?.[0]) j++;
      for (let k = i; k <= j; k++) r[(order[k] as readonly [number, number])[1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < ra.length; i++) {
    const x = (ra[i] as number) - ma;
    const y = (rb[i] as number) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db);
}

const stats = {
  sold: [] as number[],
  unsold: [] as number[],
  topPrice: [] as number[],
  top10Avg: [] as number[],
  medianPrice: [] as number[],
  p25Price: [] as number[],
  atMin: [] as number[],
  atBase: [] as number[],
  spendShare: [] as number[],
  minSquad: [] as number[],
  maxSquad: [] as number[],
  under18: [] as number[],
  maxOverseas: [] as number[],
  minPurse: [] as number[],
  corrReal: [] as number[],
};
const priceSum = new Map<string, { total: number; n: number }>();

const started = Date.now();
for (let seed = 1; seed <= runs; seed++) {
  const a = simulateAuction({ players, sets, settings: MEGA_DEFAULTS, seed, difficulty });
  const sales = a.allSales;
  const prices = sales.map((s) => s.price).sort((x, y) => y - x);
  const teams = [...a.teams.values()];
  stats.sold.push(sales.length);
  stats.unsold.push(players.length - sales.length);
  stats.topPrice.push(prices[0] ?? 0);
  stats.top10Avg.push(mean(prices.slice(0, 10)));
  stats.medianPrice.push(median(prices));
  stats.p25Price.push(prices[Math.floor(prices.length * 0.75)] ?? 0);
  stats.atMin.push(sales.filter((s) => s.price <= MEGA_DEFAULTS.minBasePrice).length / Math.max(1, sales.length));
  stats.atBase.push(sales.filter((s) => s.price === byId.get(s.playerId)?.basePrice).length / Math.max(1, sales.length));
  stats.spendShare.push(teams.reduce((acc, t) => acc + (MEGA_DEFAULTS.purse - t.purse), 0) / (MEGA_DEFAULTS.purse * teams.length));
  stats.minSquad.push(Math.min(...teams.map((t) => t.squad.length)));
  stats.maxSquad.push(Math.max(...teams.map((t) => t.squad.length)));
  stats.under18.push(teams.filter((t) => t.squad.length < MEGA_DEFAULTS.minSquad).length);
  stats.maxOverseas.push(Math.max(...teams.map((t) => t.overseasCount)));
  stats.minPurse.push(Math.min(...teams.map((t) => t.purse)));
  stats.corrReal.push(spearman(sales.map((s) => s.price), sales.map((s) => byId.get(s.playerId)?.contractPrice ?? 0)));
  for (const s of sales) {
    const e = priceSum.get(s.playerId) ?? { total: 0, n: 0 };
    e.total += s.price;
    e.n += 1;
    priceSum.set(s.playerId, e);
  }
}

const row = (label: string, xs: number[], fmt: (n: number) => string = (n) => n.toFixed(1)) =>
  console.log(`  ${label.padEnd(34)} avg ${fmt(mean(xs)).padStart(10)}   min ${fmt(Math.min(...xs)).padStart(10)}   max ${fmt(Math.max(...xs)).padStart(10)}`);
const money = (n: number) => formatLakh(Math.round(n));
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;

const real = players.map((p) => p.contractPrice).sort((x, y) => y - x);

console.log(`\n${runs} mega auctions, ${players.length} players, difficulty ${difficulty} (${((Date.now() - started) / 1000).toFixed(1)} s)\n`);
console.log('Prices                                                                                      real 2026 contracts');
const cmp = (label: string, xs: number[], realValue: string, fmt: (n: number) => string) => {
  row(label, xs, fmt);
  process.stdout.moveCursor?.(0, -1);
  console.log(`${' '.repeat(92)}${realValue.padStart(10)}`);
};
cmp('Top price', stats.topPrice, money(real[0] ?? 0), money);
cmp('Average of top 10 prices', stats.top10Avg, money(mean(real.slice(0, 10))), money);
cmp('Median price', stats.medianPrice, money(median(real)), money);
cmp('Lower quartile price', stats.p25Price, money(real[Math.floor(real.length * 0.75)] ?? 0), money);
cmp('Sold at ₹30 L', stats.atMin, pct(real.filter((p) => p <= 30).length / real.length), pct);
row('Sold at base price', stats.atBase, pct);
row('Rank correlation with real price*', stats.corrReal, (n) => n.toFixed(2));
console.log('Squads and money');
row('Players sold', stats.sold);
row('Players unsold', stats.unsold);
row('Purse spent (all teams)', stats.spendShare, pct);
row('Smallest squad', stats.minSquad);
row('Largest squad', stats.maxSquad);
row('Teams under 18 players', stats.under18);
row('Most overseas in a squad', stats.maxOverseas);
row('Lowest purse left', stats.minPurse, money);

console.log('\n* Ratings are still derived from real prices, so this correlation is circular until Cricsheet ratings are in.');

const avgPrice = [...priceSum.entries()]
  .map(([id, e]) => ({ p: byId.get(id), avg: e.total / e.n, n: e.n }))
  .sort((x, y) => y.avg - x.avg);
console.log('\nHighest average sim price vs real 2026 contract');
for (const { p, avg, n } of avgPrice.slice(0, 15)) {
  if (!p) continue;
  console.log(`  ${p.name.padEnd(22)} sim ${money(avg).padStart(10)}   real ${formatLakh(p.contractPrice).padStart(10)}   sold in ${n}/${runs}`);
}
