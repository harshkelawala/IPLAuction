#!/usr/bin/env node
/**
 * Download men's T20 ball-by-ball data from Cricsheet (https://cricsheet.org, CC BY 4.0)
 * and pack the recent matches into one small file the Player Score reads:
 *
 *   packages/data/raw/cricsheet/t20-matches.jsonl.gz   (one match per line, slimmed down)
 *
 * Run from the repo root:  npm run data:fetch
 * Needs: Node 18+, curl and unzip (both come with macOS).
 *
 * Testing without internet: CRICSHEET_LOCAL=/folder/with/zips npm run data:fetch
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const CACHE = join(HERE, 'ratings', 'cache', 'cricsheet');
const OUT_DIR = join(HERE, '..', 'raw', 'cricsheet');
const OUT = join(OUT_DIR, 't20-matches.jsonl.gz');
const SINCE = '2021-01-01';

/** Cricsheet zip code -> competition name. Strength weights are learned later from the data. */
const COMPETITIONS = {
  ipl: 'Indian Premier League',
  t20s: 'T20 internationals',
  sma: 'Syed Mushtaq Ali Trophy',
  bbl: 'Big Bash League',
  psl: 'Pakistan Super League',
  cpl: 'Caribbean Premier League',
  sat: 'SA20',
  ilt: 'International League T20',
  mlc: 'Major League Cricket',
  ntb: 'T20 Blast',
  bpl: 'Bangladesh Premier League',
  lpl: 'Lanka Premier League',
  ssm: 'Super Smash',
  ctc: 'CSA T20 Challenge',
};

/** T20Is are kept only when a full-member nation plays, which drops thousands of minor games. */
const FULL_MEMBERS = new Set([
  'India', 'Australia', 'England', 'Pakistan', 'South Africa', 'New Zealand', 'Sri Lanka',
  'West Indies', 'Bangladesh', 'Afghanistan', 'Zimbabwe', 'Ireland',
]);

function fetchZip(code) {
  const file = `${code}_male_json.zip`;
  const local = process.env.CRICSHEET_LOCAL;
  if (local) return existsSync(join(local, file)) ? join(local, file) : null;
  const dest = join(CACHE, file);
  const url = `https://cricsheet.org/downloads/${file}`;
  process.stdout.write(`  downloading ${file} ... `);
  try {
    execFileSync('curl', ['-fsSL', '--retry', '3', '-o', dest, url], { stdio: ['ignore', 'ignore', 'pipe'] });
    console.log(`${(statSync(dest).size / 1e6).toFixed(1)} MB`);
    return dest;
  } catch {
    console.log('not available, skipped');
    return null;
  }
}

/** Keep only what the scoring reads: who played, every ball, wickets with fielders. */
function slim(m, code) {
  const info = m.info;
  return {
    comp: code,
    info: {
      match_type: info.match_type,
      season: String(info.season ?? ''),
      dates: [info.dates[0]],
      event: info.event?.name ?? COMPETITIONS[code],
      players: info.players,
      registry: Object.fromEntries(
        Object.values(info.players ?? {}).flat().map((n) => [n, info.registry?.people?.[n] ?? null]),
      ),
    },
    innings: (m.innings ?? []).map((inn) => ({
      team: inn.team,
      super_over: Boolean(inn.super_over),
      overs: (inn.overs ?? []).map((o) => ({
        over: o.over,
        deliveries: o.deliveries.map((d) => {
          const out = { batter: d.batter, bowler: d.bowler, non_striker: d.non_striker, runs: d.runs };
          if (d.extras) out.extras = d.extras;
          if (d.wickets) {
            out.wickets = d.wickets.map((w) => ({
              player_out: w.player_out,
              kind: w.kind,
              fielders: (w.fielders ?? []).filter((f) => f.name && !f.substitute).map((f) => ({ name: f.name })),
            }));
          }
          return out;
        }),
      })),
    })),
  };
}

function keep(m, code) {
  const info = m.info ?? {};
  if (!info.dates?.length || info.dates[0] < SINCE) return false;
  if (!['T20', 'IT20'].includes(info.match_type)) return false;
  if (info.gender && info.gender !== 'male') return false;
  if (code === 't20s' && !(info.teams ?? []).some((t) => FULL_MEMBERS.has(t))) return false;
  return true;
}

function main() {
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT_DIR, { recursive: true });
  const lines = [];
  const summary = {};
  for (const code of Object.keys(COMPETITIONS)) {
    const zip = fetchZip(code);
    if (!zip) continue;
    const dir = join(CACHE, code);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '*.json', '-d', dir]);
    let n = 0;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const m = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (!keep(m, code)) continue;
      lines.push(JSON.stringify(slim(m, code)));
      n++;
    }
    summary[code] = n;
    console.log(`    ${COMPETITIONS[code]}: ${n} matches since ${SINCE}`);
  }
  if (!lines.length) {
    console.error('Nothing downloaded. Check your internet connection and try again.');
    process.exit(1);
  }
  writeFileSync(OUT, gzipSync(lines.join('\n') + '\n', { level: 9 }));
  writeFileSync(
    join(OUT_DIR, 'MANIFEST.json'),
    JSON.stringify({ source: 'https://cricsheet.org (CC BY 4.0)', fetched: new Date().toISOString(), since: SINCE, matches: summary }, null, 2) + '\n',
  );
  console.log(`\nSaved ${lines.length} matches to ${OUT} (${(statSync(OUT).size / 1e6).toFixed(1)} MB)`);
}

main();
