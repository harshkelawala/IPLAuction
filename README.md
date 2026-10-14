# IPL Auction

A web game of the IPL player auction. Up to 10 people each run a real IPL franchise and bid live against each other; AI bidders run every team nobody claims, so a solo player still gets a full 10-team auction.

Design doc and execution plan: see the "IPL Auction Game — Design Doc & Execution Plan" doc in the claude.ai project.

## Play it

```bash
npm install
npm run dev
```

Open http://localhost:3000, pick a franchise and start. `npm run dev` runs the game server (port 4000) and the web app (port 3000) together.

Controls: click **Bid** or press **B**. **Pause** stops the clock; closing the tab pauses the auction too, and reopening the link picks it up where you left it.

## Status

**Phase 0 — data and rules** (done)

- [x] Monorepo with TypeScript and Vitest
- [x] `@ipl/rules`: bid increments, purse reserve rule, squad and overseas limits, bid validation, sale settlement
- [x] 2026 squads for all 10 teams (272 players) with roles, nationality, capped status and contract prices
- [x] `@ipl/data`: provisional ratings, fair value, base prices, auction sets, seed generator
- [x] Central Player Score from 3,800+ T20 matches in 14 competitions since 2021; drives every rating and price
- [x] Headless 10-AI simulation to check auction prices look realistic

**Phase 1 — solo game** (done)

- [x] `@ipl/engine`: auction state machine (sets, lots, timers, bids, sold/unsold, accelerated round)
- [x] AI bidder v1 (value × need × budget × personality × noise, interest, marquee limits, realistic reserve)
- [x] Game server with real timers, pause/resume, reconnect (`apps/server`)
- [x] Screens: landing and team picker, live auction, results (`apps/web`), desktop and mobile

**Phase 2 — multiplayer** (next): rooms with codes, lobby, several humans, Redis snapshots.

### Pool sizes

| Pool | Players | Squad size | Max overseas | Purse |
| --- | --- | --- | --- | --- |
| Quick | 150 | 11–14 | 6 | ₹125 cr |
| Standard | 250 | 18–25 | 8 | ₹125 cr |
| Full | 272 | 18–25 | 8 | ₹125 cr |

In 100 simulated auctions per pool, every AI team reached its minimum squad.

### Simulation check (20 mega auctions, all 10 teams AI, 272 players)

| | Sim (average) | Real 2026 contracts |
| --- | --- | --- |
| Top price | ₹26.6 cr | ₹27 cr |
| Average of top 10 | ₹23.6 cr | ₹21.6 cr |
| Median price | ₹2.7 cr | ₹2 cr |
| Lower quartile | ₹53 L | ₹40 L |
| Sold at ₹30 L | 13% | 24% |

Every run: all teams finish with 18–25 players, at most 8 overseas, and a purse of ₹0 or more. About 230 players sell and 88% of the purse is spent. Run it yourself with `npm run simulate`.

## Layout

```
apps/
  server/                Socket.IO game server: rooms, timers, AI bidding (port 4000)
  web/                   Next.js app: landing, auction screen, results (port 3000)
packages/
  protocol/              typed messages between server and browser
  rules/                 shared game rules, used by server and browser
    src/bidding.ts       increments, reserve rule, checkBid, settleSale
    src/settings.ts      mega / mini defaults, purse presets
    src/teams.ts         the 10 franchises and their colours
  data/
    raw/                 squads-2026.csv, cricsheet/t20-matches.jsonl.gz, rating overrides, SOURCES.md
    src/                 valuation curve, player builder, set builder, seed script
    generated/           player-score.json (npm run score), players-2026.json, sets-2026-mega.json (npm run seed)
    scripts/fetch-cricsheet.mjs   downloads the T20 data (npm run data:fetch)
    scripts/ratings/     player_score.py (the Player Score), compute_ratings.py (name matching)
  engine/
    src/auction.ts       authoritative auction state machine (clock passed in)
    src/ai.ts            AI bidder: max price, interest, bid timing, personalities
    src/simulate.ts      run a full auction with 10 AI teams on a virtual clock
    scripts/simulate.ts  price report across many seeds
```

## Commands

```bash
npm install
npm run dev         # game server + web app
npm test            # all TypeScript tests
npm run typecheck
npm run simulate    # 20 all-AI auctions, price report
npm run seed        # rebuild packages/data/generated/*.json from raw/

# Player Score
npm run ratings:update   # download the latest T20 data, rebuild the score, reseed (after a season)
npm run score            # rebuild the score from the data already downloaded
npm run test:py          # Python tests
cd packages/data/scripts/ratings && python3 player_score.py --tune   # let the data re-choose the settings
```

Settings: `NEXT_PUBLIC_SERVER_URL` (web, default `http://localhost:4000`), `PORT` and `WEB_ORIGIN` (server). `TIME_SCALE=0.05` on the server speeds every timer up for testing.

## How players are rated and priced

Everything starts from one central **Player Score**, built by `scripts/ratings/player_score.py` from
ball-by-ball data for every men's T20 match since 2021 in 14 competitions (IPL, T20 internationals,
Syed Mushtaq Ali, BBL, PSL, CPL, SA20, ILT20, MLC, T20 Blast, BPL, LPL, Super Smash, CSA T20), from
[Cricsheet](https://cricsheet.org).

1. **Each match** is scored 0–100 (50 = an average IPL performance) for batting, bowling and fielding:
   runs against par for the phase (powerplay, middle, death) and the match conditions, wickets valued
   by who got out, catches, stumpings and run-outs credited, close finishes counting 1.25×. Scores in
   other competitions are shifted by that competition's strength, which the data measures from
   players who play in both.
2. **The score** mixes Form (last few matches), Class (the whole record) and Importance (best season in
   the last three years plus record in close finishes). The mix and the memory speeds were chosen by
   the data: the combination that best predicts players' next IPL performance in 2024–25, checked on
   2026, which the search never saw. Today: 20% Form, 70% Class, 10% Importance. A player with few
   matches stays near a cautious newcomer level (45) until he has played enough.
3. **Rating** (0–100): players are ranked by score and given the rating at the same rank in the
   spread the game economy was tuned on, so the order comes from the score and total spending stays
   realistic. Batting and bowling ratings are ranked the same way and drive team strength. A hand
   override in `raw/rating-overrides.csv` beats everything.
4. **Fair value**: `₹0.2 cr × e^(0.075 × (rating − 40))` × nationality (Indian ×1.3, overseas ×0.9) ×
   scarcity (keepers and Indian fast bowlers ×1.15). The AI starts from this, then adjusts for its
   needs, including specialist jobs the data tags (death and powerplay bowlers, openers, finishers):
   two teams short of a death bowler push each other's price up. Humans never see ratings or values,
   only each player's form, record and last 15 matches.
5. **Base price** by rating tier, from ₹30 L to ₹2 cr; uncapped players start at ₹30 L unless rated 75+.
6. **Set**: marquee sets M1 and M2, then rotating capped role sets and uncapped sets.

Validation: score-based simulated prices have a rank correlation of about 0.5 with what real teams
paid in 2026, and the score predicts the next IPL performance better than the old price-based ratings.

Money is always an integer number of lakhs (₹1 crore = 100 lakh).

## Not affiliated

Fan-made game, not affiliated with the BCCI, the IPL or any franchise. It uses team names and colours only, with original badges and no official logos.
