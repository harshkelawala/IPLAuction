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
- **Ratings are provisional.** Until `scripts/ratings/compute_ratings.py` is run, each rating is the fair-value curve inverted on the player's contract price. That under-rates bargain buys and youth retentions (e.g. Vaibhav Sooryavanshi at ₹1.1 cr), and over-rates players whose price was set by the retention slabs. Use `rating-overrides.csv` for quick fixes.
