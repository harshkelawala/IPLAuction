# IPL Auction

A web game of the IPL player auction. Up to 10 people each run a real IPL franchise and bid live against each other; AI bidders run every team nobody claims, so a solo player still gets a full 10-team auction.

Design doc and execution plan: see the "IPL Auction Game — Design Doc & Execution Plan" doc in the claude.ai project.

## Status

**Phase 0 — data and rules** (in progress)

- [x] Monorepo with TypeScript and Vitest
- [x] `@ipl/rules`: bid increments, purse reserve rule, squad and overseas limits, bid validation, sale settlement
- [x] 2026 squads for all 10 teams (272 players) with roles, nationality, capped status and contract prices
- [x] `@ipl/data`: provisional ratings, fair value, base prices, auction sets, seed generator
- [x] Cricsheet stats pipeline for stats-based ratings (written and tested on synthetic data; needs a run with internet access)
- [x] Headless 10-AI simulation to check auction prices look realistic

**Phase 1 — solo game** (in progress)

- [x] `@ipl/engine`: auction state machine (sets, lots, timers, bids, sold/unsold, accelerated round)
- [x] AI bidder v1 (value × need × budget × personality × noise, interest, marquee limits)
- [ ] Game server with real timers
- [ ] Pages: landing, team picker, live auction screen, results

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
packages/
  rules/                 shared game rules, used by server and browser
    src/bidding.ts       increments, reserve rule, checkBid, settleSale
    src/settings.ts      mega / mini defaults, purse presets
    src/teams.ts         the 10 franchises and their colours
  data/
    raw/                 squads-2026.csv, rating overrides, SOURCES.md
    src/                 valuation curve, player builder, set builder, seed script
    generated/           players-2026.json, sets-2026-mega.json (from `npm run seed`)
    scripts/ratings/     compute_ratings.py (Cricsheet → stats-based ratings)
  engine/
    src/auction.ts       authoritative auction state machine (clock passed in)
    src/ai.ts            AI bidder: max price, interest, bid timing, personalities
    src/simulate.ts      run a full auction with 10 AI teams on a virtual clock
    scripts/simulate.ts  price report across many seeds
```

## Commands

```bash
npm install
npm test            # all TypeScript tests
npm run typecheck
npm run seed        # rebuild packages/data/generated/*.json from raw/

# Stats-based ratings (needs internet access to cricsheet.org)
cd packages/data/scripts/ratings
python3 compute_ratings.py --download
python3 -m unittest test_compute_ratings.py
cd ../../../.. && npm run seed
```

## How players are priced

Every player gets four numbers:

1. **Rating** (0–100). Priority order: a hand override in `raw/rating-overrides.csv`, then the Cricsheet stats rating, then a provisional rating inverted from the player's real contract price.
2. **Fair value**: `₹0.2 cr × e^(0.075 × (rating − 40))` × nationality modifier (Indian ×1.3, overseas ×0.9) × scarcity modifier (wicketkeepers and Indian fast bowlers ×1.15). Never below base price. This is what the AI starts from; humans never see it.
3. **Base price** by rating tier, from ₹30 L to ₹2 cr. Uncapped players start at ₹30 L unless rated 75 or more.
4. **Set**. Mega mode puts the 12 most valuable players into marquee sets M1 and M2, then rotates capped role sets of 8 (BA, AL, WK, FA, SP) with uncapped sets of 10 (UBA, UAL, …).

Money is always an integer number of lakhs (₹1 crore = 100 lakh).

## Not affiliated

Fan-made game, not affiliated with the BCCI, the IPL or any franchise. It uses team names and colours only, with original badges and no official logos.
