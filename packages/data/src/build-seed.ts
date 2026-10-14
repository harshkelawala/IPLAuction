/**
 * Build the game's player seed from the raw squad CSV.
 *
 *   npm run seed            (from the repo root)
 *
 * Inputs  (packages/data/raw):
 *   squads-2026.csv          real squads: team, role, nationality, contract price
 *   ../generated/player-score.json  the central Player Score (scripts/ratings/player_score.py)
 *   ratings-cricsheet.csv    optional older stats ratings, used only without a Player Score
 *   rating-overrides.csv     optional, hand corrections (id,rating,reason)
 * Outputs (packages/data/generated):
 *   players-2026.json        every player with rating, fair value, base price, category
 *   sets-2026-mega.json      auction sets for a full-pool mega auction
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatLakh } from '@ipl/rules';
import { parseCsv } from './csv';
import { buildPlayers } from './players';
import type { RawScore } from './score';
import { buildSets } from './sets';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = (f: string) => join(root, 'raw', f);
const out = (f: string) => join(root, 'generated', f);

function readRatings(file: string): Map<string, number> | undefined {
  if (!existsSync(file)) return undefined;
  const map = new Map<string, number>();
  for (const row of parseCsv(readFileSync(file, 'utf8'))) {
    const rating = Number(row.rating);
    if (row.id && Number.isFinite(rating)) map.set(row.id, rating);
  }
  return map;
}

function readScores(file: string): Map<string, RawScore> | undefined {
  if (!existsSync(file)) return undefined;
  const json = JSON.parse(readFileSync(file, 'utf8')) as { players: Record<string, RawScore> };
  return new Map(Object.entries(json.players));
}

const rows = parseCsv(readFileSync(raw('squads-2026.csv'), 'utf8'));
const players = buildPlayers(rows, {
  scores: readScores(out('player-score.json')),
  cricsheet: readRatings(raw('ratings-cricsheet.csv')),
  overrides: readRatings(raw('rating-overrides.csv')),
});

const ids = new Set<string>();
for (const p of players) {
  if (ids.has(p.id)) throw new Error(`Duplicate player id ${p.id}`);
  ids.add(p.id);
}

const sets = buildSets(players, 'mega');

mkdirSync(join(root, 'generated'), { recursive: true });
writeFileSync(out('players-2026.json'), JSON.stringify(players, null, 2) + '\n');
writeFileSync(out('sets-2026-mega.json'), JSON.stringify(sets, null, 2) + '\n');

const bySource = players.reduce<Record<string, number>>((acc, p) => {
  acc[p.ratingSource] = (acc[p.ratingSource] ?? 0) + 1;
  return acc;
}, {});
const top = [...players].sort((a, b) => b.fairValue - a.fairValue).slice(0, 10);
console.log(`${players.length} players, ${sets.length} sets. Rating sources: ${JSON.stringify(bySource)}`);
console.log('Top 10 by fair value:');
for (const p of top) {
  console.log(`  ${p.name.padEnd(22)} ${p.role.padEnd(4)} rating ${p.rating}  value ${formatLakh(p.fairValue)}  base ${formatLakh(p.basePrice)}`);
}
