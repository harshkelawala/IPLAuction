# Data sources

`squads-2026.csv` holds every player on an IPL 2026 squad, including players who withdrew and their replacements: 272 players, collected on 13 October 2026.

| Team | Source |
| --- | --- |
| CSK, MI, KKR, SRH, RR, DC, PBKS, LSG, GT | Wikipedia "2026 <team> season" pages (squad table: nationality, batting/bowling style, salary, how acquired) |
| RCB | Wikipedia [2026 Royal Challengers Bengaluru season](https://en.wikipedia.org/wiki/2026_Royal_Challengers_Bengaluru_season) for the 17 retained players and their salaries; [SportsDigest](https://sportsdigest.in/rcb-full-squad-ipl-2026-full-list/173844/) for the 8 auction buys |

Official franchise sites and iplt20.com were tried first. Most of them blocked automated fetching, rendered their squads only with JavaScript, or were out of date, and none of them show prices.

## Columns

| Column | Meaning |
| --- | --- |
| `team` | Real 2026 franchise (`CSK`, `MI`, …) |
| `role` | `BAT`, `BOWL`, `AR`, `WK` |
| `bat` | Batting hand: `L` / `R` |
| `bowl` | `RF` `RFM` `RM` `LF` `LFM` `LM` (pace) · `OB` `LB` `SLA` `LWS` `UNO` (spin), blank = doesn't bowl |
| `price_lakh` | 2026 contract price in lakhs (₹1 crore = 100) |
| `acquired` | `retained`, `auction`, `trade`, `replacement` |
| `capped` | `1` capped, `0` uncapped (IPL classification, e.g. MS Dhoni counts as uncapped) |
| `status` | `active` or `withdrawn` from the real season (still auctionable in the game) |

## Known gaps — please review

- **Roles and capped status** were partly inferred from playing style and cricket knowledge, because the sources don't label them consistently. Rows marked `role unverified` in `notes` need checking: Satvik Deswal and Ravi Singh.
- **Ratings come from the Player Score** (`scripts/ratings/player_score.py`). Contract prices only set the overall spread of ratings. 19 squad players have no recorded T20 match since 2021 and start at the newcomer level; use `rating-overrides.csv` for any you know better.
- **Syed Mushtaq Ali data on Cricsheet stops at December 2024**, so newer Indian domestic form (and all first-class and 50-over cricket) isn't included.

## Match data

`cricsheet/t20-matches.jsonl.gz`: men's T20 ball-by-ball data since 1 January 2021 from [Cricsheet](https://cricsheet.org) (CC BY 4.0), 14 competitions, slimmed by `npm run data:fetch`. The IPL CSV mirror at github.com/ritesh-ojha/IPL-DATASET fills any IPL gaps. `cricsheet-names.csv` fixes names the matcher gets wrong (a blank name means "no record").
