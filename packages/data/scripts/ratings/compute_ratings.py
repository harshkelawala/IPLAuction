#!/usr/bin/env python3
"""
Compute stats-based player ratings (0-100) from Cricsheet ball-by-ball data.

Writes packages/data/raw/ratings-cricsheet.csv (id,rating,balls_bat,balls_bowl,matches),
which `npm run seed` then prefers over the provisional price-derived ratings.

Usage (from this folder, needs internet access to cricsheet.org):
    python3 compute_ratings.py --download              # fetch zips into ./cache
    python3 compute_ratings.py                         # compute from ./cache
    python3 compute_ratings.py --data-dir path/to/json # compute from any folder of match JSON files

Method (see the design doc, "How ratings are computed"):
  1. T20 matches from the last 3 seasons, weighted 1.0 / 0.5 / 0.2 by season,
     and by competition (IPL and T20Is 1.0, big leagues 0.85, domestic 0.7).
  2. Weighted totals per player -> strike rate, average, runs; economy, wickets/match,
     death-overs economy.
  3. Small samples shrunk toward the role average (100 balls batting, 120 bowling).
  4. Percentile within role, combined:
        batting = 0.5 SR + 0.3 avg + 0.2 runs
        bowling = 0.5 econ + 0.3 wkts/match + 0.2 death econ (lower econ is better)
        skill   = by role (AR = 0.55 best + 0.45 other; WK = batting + 5)
        rating  = 0.70 skill + 0.15 form (latest season) + 0.10 experience + 0.05 age factor
     Cricsheet has no dates of birth, so the age factor is a neutral 80 unless
     raw/player-ages.csv (id,age) exists.
  Players below the minimum sample are left out and keep their price-derived rating.
"""
from __future__ import annotations

import argparse
import csv
import difflib
import io
import json
import re
import unicodedata
import urllib.request
import zipfile
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
RAW = HERE.parent.parent / "raw"
CACHE = HERE / "cache"

# Cricsheet zip name -> competition weight. Check https://cricsheet.org/downloads/ if one 404s.
COMPETITIONS = {
    "ipl_json.zip": 1.0,
    "t20s_male_json.zip": 1.0,
    "bbl_json.zip": 0.85,
    "psl_json.zip": 0.85,
    "cpl_json.zip": 0.85,
    "sat_json.zip": 0.85,
    "sma_json.zip": 0.7,  # Syed Mushtaq Ali Trophy: covers uncapped Indians
}
SEASON_WEIGHTS = [1.0, 0.5, 0.2]  # latest season first: current form matters most
SHRINK_BAT_BALLS = 100
SHRINK_BOWL_BALLS = 120
MIN_BAT_BALLS = 60
MIN_BOWL_BALLS = 60
DEATH_OVERS = range(15, 20)  # overs 16-20, zero-indexed
NEUTRAL_AGE_FACTOR = 80.0
NOT_BOWLER_WICKETS = {"run out", "retired hurt", "retired out", "obstructing the field", "retired not out"}


def slugify(name: str) -> str:
    """Must match slugify() in packages/data/src/players.ts."""
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


@dataclass
class Totals:
    runs: float = 0.0
    balls: float = 0.0
    outs: float = 0.0
    bowl_balls: float = 0.0
    conceded: float = 0.0
    wickets: float = 0.0
    death_balls: float = 0.0
    death_conceded: float = 0.0
    matches: float = 0.0
    bowl_matches: float = 0.0

    def add(self, other: "Totals", w: float) -> None:
        for k in self.__dataclass_fields__:
            setattr(self, k, getattr(self, k) + w * getattr(other, k))


@dataclass
class PlayerData:
    # season -> competition weight -> raw totals; aggregated with weights later
    by_season: dict[int, Totals] = field(default_factory=lambda: defaultdict(Totals))
    ipl_matches: int = 0
    # season -> franchise names played for (used to tell apart players with similar names)
    teams: dict[int, set] = field(default_factory=lambda: defaultdict(set))


# ---------------------------------------------------------------- loading

def download(cache: Path) -> None:
    cache.mkdir(parents=True, exist_ok=True)
    for name in COMPETITIONS:
        url = f"https://cricsheet.org/downloads/{name}"
        print(f"downloading {url}")
        with urllib.request.urlopen(url) as resp:  # noqa: S310 (fixed https host)
            (cache / name).write_bytes(resp.read())


def iter_matches(cache: Path | None, data_dir: Path | None):
    """Yield (competition_weight, is_ipl, match_json)."""
    if data_dir is not None:
        for f in sorted(data_dir.glob("**/*.json")):
            m = json.loads(f.read_text())
            event = (m.get("info", {}).get("event", {}) or {}).get("name", "")
            is_ipl = "Indian Premier League" in event
            yield 1.0 if is_ipl else 0.85, is_ipl, m
        return
    assert cache is not None
    for name, weight in COMPETITIONS.items():
        path = cache / name
        if not path.exists():
            print(f"  skipping {name}: not downloaded")
            continue
        with zipfile.ZipFile(path) as z:
            for member in z.namelist():
                if member.endswith(".json"):
                    yield weight, name == "ipl_json.zip", json.loads(z.read(member))


def iter_ipl_csv(folder: Path):
    """
    Yield (1.0, True, match_json) from an IPL ball-by-ball CSV mirror of Cricsheet
    (Match_Info.csv + Ball_By_Ball_Match_Data.csv, e.g. github.com/ritesh-ojha/IPL-DATASET),
    converted to the Cricsheet JSON shape that collect() reads.
    """
    info: dict[str, dict] = {}
    with open(folder / "Match_Info.csv", newline="") as f:
        for r in csv.DictReader(f):
            info[r["match_number"]] = {
                "match_type": "T20",
                "season": r["match_date"][:4],
                "dates": [r["match_date"]],
                "players": {
                    r["team1"]: [x.strip() for x in r["team1_players"].split(",") if x.strip()],
                    r["team2"]: [x.strip() for x in r["team2_players"].split(",") if x.strip()],
                },
            }
    innings: dict[str, dict[int, dict[int, list]]] = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    with open(folder / "Ball_By_Ball_Match_Data.csv", newline="") as f:
        for r in csv.DictReader(f):
            extras: dict[str, int] = {}
            kind = (r["ExtraType"] or "").strip()
            extra_runs = int(r["ExtrasRun"] or 0)
            if kind in ("wides", "noballs", "legbyes", "byes", "penalty") and extra_runs:
                extras[kind] = extra_runs
            elif kind in ("wides", "noballs"):
                extras[kind] = 1
            d = {
                "batter": r["Batter"],
                "bowler": r["Bowler"],
                "non_striker": r.get("NonStriker", ""),
                "runs": {"batter": int(r["BatsmanRun"] or 0), "extras": extra_runs, "total": int(r["TotalRun"] or 0)},
            }
            if extras:
                d["extras"] = extras
            if r["IsWicketDelivery"] == "1" and r["PlayerOut"] not in ("", "NA"):
                fielders = [x.strip() for x in (r.get("FieldersInvolved") or "").split(",") if x.strip() not in ("", "NA")]
                d["wickets"] = [{"player_out": r["PlayerOut"], "kind": r["Kind"], "fielders": [{"name": x} for x in fielders]}]
            innings[r["ID"]][int(r["Innings"])][int(r["Overs"])].append(d)
    for match_id, inns in innings.items():
        if match_id not in info:
            continue
        m = {"info": info[match_id], "innings": []}
        for number in sorted(inns):
            overs = [{"over": o, "deliveries": ds} for o, ds in sorted(inns[number].items())]
            m["innings"].append({"overs": overs, "super_over": number > 2})
        yield 1.0, True, m


def season_of(match: dict) -> int:
    season = str(match["info"].get("season", ""))
    m = re.match(r"(\d{4})", season)
    if m:
        return int(m.group(1))
    return int(match["info"]["dates"][0][:4])


def collect(matches, seasons: list[int]) -> dict[str, PlayerData]:
    """Per Cricsheet display name: per-season totals already weighted by competition."""
    wanted = set(seasons)
    data: dict[str, PlayerData] = defaultdict(PlayerData)
    for comp_w, is_ipl, m in matches:
        if m["info"].get("match_type") not in ("T20", "IT20"):
            continue
        season = season_of(m)
        if season not in wanted:
            continue
        per_match: dict[str, Totals] = defaultdict(Totals)
        team_players = m["info"].get("players", {})
        players = {p for team in team_players.values() for p in team}
        for team_name, names in team_players.items():
            for name in names:
                data[name].teams[season].add(team_name)
        for innings in m.get("innings", []):
            if innings.get("super_over"):
                continue
            for over in innings.get("overs", []):
                ov = over["over"]
                for d in over.get("deliveries", []):
                    extras = d.get("extras", {})
                    runs = d["runs"]
                    bat, bowl = d["batter"], d["bowler"]
                    wide = "wides" in extras
                    no_ball = "noballs" in extras
                    t_bat, t_bowl = per_match[bat], per_match[bowl]
                    t_bat.runs += runs["batter"]
                    if not wide:
                        t_bat.balls += 1
                    conceded = runs["batter"] + extras.get("wides", 0) + extras.get("noballs", 0)
                    legal = not wide and not no_ball
                    t_bowl.conceded += conceded
                    t_bowl.bowl_balls += 1 if legal else 0
                    if ov in DEATH_OVERS:
                        t_bowl.death_conceded += conceded
                        t_bowl.death_balls += 1 if legal else 0
                    for w in d.get("wickets", []):
                        per_match[w["player_out"]].outs += 1
                        if w["kind"] not in NOT_BOWLER_WICKETS:
                            t_bowl.wickets += 1
        for name in players:
            t = per_match[name]
            t.matches = 1
            t.bowl_matches = 1 if t.bowl_balls > 0 else 0
            data[name].by_season[season].add(t, comp_w)
            if is_ipl:
                data[name].ipl_matches += 1
    return data


# ---------------------------------------------------------------- name matching

def load_squads() -> list[dict]:
    with open(RAW / "squads-2026.csv", newline="") as f:
        rows = [r for r in csv.DictReader(line for line in f if not line.startswith("#"))]
    for r in rows:
        r["id"] = slugify(r["name"])
    return rows


def load_name_map() -> dict[str, str]:
    """Optional raw/cricsheet-names.csv (id,cricsheet_name) for names the matcher gets wrong."""
    path = RAW / "cricsheet-names.csv"
    if not path.exists():
        return {}
    with open(path, newline="") as f:
        return {r["id"]: r["cricsheet_name"] for r in csv.DictReader(line for line in f if not line.startswith("#"))}


FRANCHISE_NAMES = {
    "CSK": {"Chennai Super Kings"},
    "MI": {"Mumbai Indians"},
    "RCB": {"Royal Challengers Bangalore", "Royal Challengers Bengaluru"},
    "KKR": {"Kolkata Knight Riders"},
    "SRH": {"Sunrisers Hyderabad"},
    "RR": {"Rajasthan Royals"},
    "DC": {"Delhi Capitals", "Delhi Daredevils"},
    "PBKS": {"Punjab Kings", "Kings XI Punjab"},
    "LSG": {"Lucknow Super Giants"},
    "GT": {"Gujarat Titans"},
}


def _tokens(name: str) -> list[str]:
    return [t for t in re.split(r"[\s.]+", name) if t]


def _first_ok(cs_first: str, squad_first: str) -> bool:
    """
    Cricsheet's first token is either initials ("RG", "PVD") or a name ("Shubman").
    Initials match if they contain the first initial (Sri Lankan names often put the
    given-name initial last: Dushmantha Chameera = "PVD Chameera"); names match on
    spelling variants ("Abishek" / "Abhishek").
    """
    if cs_first.isupper() and len(cs_first) <= 4:
        return squad_first[0].lower() in cs_first.lower()
    a, b = cs_first.lower(), squad_first.lower()
    return a == b or difflib.SequenceMatcher(None, a, b).ratio() >= 0.8


def match_names(squad: list[dict], data: dict[str, PlayerData]) -> dict[str, str]:
    """
    Squad full names ("Virat Kohli") -> Cricsheet display names ("V Kohli").
    1. A manual entry in raw/cricsheet-names.csv.
    2. The exact name.
    3. Same surname and a compatible first name or initial; ties go to whoever played for the
       player's franchise (latest season first), then to the most matches.
    4. Otherwise someone who played for that franchise and shares a 4+ letter name token
       ("Varun Chakravarthy" -> "CV Varun"), if exactly one does.
    """
    manual = load_name_map()
    by_surname: dict[str, list[str]] = defaultdict(list)
    for cs in data:
        toks = _tokens(cs)
        if toks:
            by_surname[toks[-1].lower()].append(cs)
    seasons_desc = sorted({s for pd in data.values() for s in pd.teams}, reverse=True)

    def volume(cs: str) -> float:
        return sum(t.matches for t in data[cs].by_season.values())

    def played_for(cs: str, team: str) -> int:
        """Most recent season index (0 = latest) the player turned out for this franchise, else 99."""
        names = FRANCHISE_NAMES.get(team, set())
        for i, season in enumerate(seasons_desc):
            if data[cs].teams.get(season, set()) & names:
                return i
        return 99

    def first_name_hit(cs: str, first: str) -> bool:
        """The Cricsheet name spells out the player's first name anywhere ("M Shahrukh Khan")."""
        return any(t.lower() == first.lower() for t in _tokens(cs)[:-1])

    # Pass 1: manual entries and exact names are certain; reserve them first.
    out: dict[str, str] = {}
    taken: set[str] = set()
    blocked = {pid for pid, cs in manual.items() if not cs.strip()}  # a blank name means "no record"
    for r in squad:
        if r["id"] in blocked:
            continue
        if r["id"] in manual:
            out[r["id"]] = manual[r["id"]]
        elif r["name"] in data:
            out[r["id"]] = r["name"]
        if r["id"] in out:
            taken.add(out[r["id"]])

    # Pass 2: everyone else, best candidate first; one Cricsheet name per squad player.
    guesses: list[tuple[tuple, str, str]] = []
    for r in squad:
        if r["id"] in out or r["id"] in blocked:
            continue
        toks = _tokens(r["name"])
        if not toks:
            continue
        surname, first = toks[-1].lower(), toks[0]
        team = r.get("team", "")
        cands = [
            c for c in by_surname.get(surname, [])
            if c not in taken and (first_name_hit(c, first) or _first_ok(_tokens(c)[0], first))
        ]
        if not cands:
            # Same franchise this season and a shared 4+ letter name other than the surname
            # ("Varun Chakravarthy" -> "CV Varun").
            given = {t.lower() for t in toks[:-1] if len(t) >= 4}
            cands = [
                c for c in data
                if c not in taken and played_for(c, team) == 0
                and given & {t.lower() for t in _tokens(c) if len(t) >= 4}
            ]
            if len(cands) != 1:
                continue
        for c in cands:
            # Lower sorts first: spelled-out first name, then played for this franchise recently, then most matches.
            lead = _tokens(c)[0]
            exact_initial = lead[0].lower() == first[0].lower()
            key = (0 if first_name_hit(c, first) else 1 if exact_initial else 2, played_for(c, team), -volume(c))
            guesses.append((key, r["id"], c))
    for _, rid, c in sorted(guesses):
        if rid in out or c in taken:
            continue
        out[rid] = c
        taken.add(c)
    return out


# ---------------------------------------------------------------- scoring

def weighted(pd: PlayerData, seasons: list[int], weights: list[float]) -> Totals:
    t = Totals()
    for season, w in zip(seasons, weights):
        if season in pd.by_season:
            t.add(pd.by_season[season], w)
    return t


def shrink(value: float, n: float, prior: float, k: float) -> float:
    return (n * value + k * prior) / (n + k)


def percentiles(values: dict[str, float], higher_is_better: bool = True) -> dict[str, float]:
    if not values:
        return {}
    items = sorted(values.items(), key=lambda kv: kv[1], reverse=not higher_is_better)
    n = len(items)
    # Worst gets 0, best gets 100.
    return {k: 100.0 * i / max(1, n - 1) for i, (k, _) in enumerate(items)}


def bat_rates(t: Totals) -> tuple[float, float, float]:
    sr = 100.0 * t.runs / t.balls if t.balls else 0.0
    avg = t.runs / max(1.0, t.outs)
    return sr, avg, t.runs


def bowl_rates(t: Totals) -> tuple[float, float, float]:
    econ = 6.0 * t.conceded / t.bowl_balls if t.bowl_balls else 99.0
    wpm = t.wickets / max(1.0, t.bowl_matches)
    death = 6.0 * t.death_conceded / t.death_balls if t.death_balls else econ
    return econ, wpm, death


def score(totals: dict[str, Totals], roles: dict[str, str]) -> tuple[dict[str, float], dict[str, float]]:
    """Batting and bowling scores (0-100), percentiles taken within each role."""
    bat_score: dict[str, float] = {}
    bowl_score: dict[str, float] = {}
    for role in ("BAT", "WK", "AR", "BOWL"):
        ids = [i for i in totals if roles[i] == role]
        batters = [i for i in ids if totals[i].balls >= MIN_BAT_BALLS]
        bowlers = [i for i in ids if totals[i].bowl_balls >= MIN_BOWL_BALLS]
        if batters:
            raw = {i: bat_rates(totals[i]) for i in batters}
            p_sr = sum(r[0] for r in raw.values()) / len(raw)
            p_avg = sum(r[1] for r in raw.values()) / len(raw)
            sr = {i: shrink(raw[i][0], totals[i].balls, p_sr, SHRINK_BAT_BALLS) for i in batters}
            avg = {i: shrink(raw[i][1], totals[i].balls, p_avg, SHRINK_BAT_BALLS) for i in batters}
            runs = {i: raw[i][2] for i in batters}
            P = (percentiles(sr), percentiles(avg), percentiles(runs))
            for i in batters:
                bat_score[i] = 0.5 * P[0][i] + 0.3 * P[1][i] + 0.2 * P[2][i]
        if bowlers:
            raw = {i: bowl_rates(totals[i]) for i in bowlers}
            p_e = sum(r[0] for r in raw.values()) / len(raw)
            p_w = sum(r[1] for r in raw.values()) / len(raw)
            p_d = sum(r[2] for r in raw.values()) / len(raw)
            econ = {i: shrink(raw[i][0], totals[i].bowl_balls, p_e, SHRINK_BOWL_BALLS) for i in bowlers}
            wpm = {i: shrink(raw[i][1], totals[i].bowl_balls, p_w, SHRINK_BOWL_BALLS) for i in bowlers}
            death = {i: shrink(raw[i][2], totals[i].death_balls, p_d, SHRINK_BOWL_BALLS) for i in bowlers}
            P = (percentiles(econ, False), percentiles(wpm), percentiles(death, False))
            for i in bowlers:
                bowl_score[i] = 0.5 * P[0][i] + 0.3 * P[1][i] + 0.2 * P[2][i]
    return bat_score, bowl_score


def skill_for(role: str, bat: float | None, bowl: float | None) -> float | None:
    if role == "BAT":
        return bat
    if role == "WK":
        return None if bat is None else min(100.0, bat + 5)
    if role == "BOWL":
        return bowl
    # AR: 55% stronger skill + 45% weaker; a missing skill counts as 0.
    a, b = bat or 0.0, bowl or 0.0
    if bat is None and bowl is None:
        return None
    return 0.55 * max(a, b) + 0.45 * min(a, b)


def load_ages() -> dict[str, float]:
    path = RAW / "player-ages.csv"
    if not path.exists():
        return {}
    with open(path, newline="") as f:
        return {r["id"]: float(r["age"]) for r in csv.DictReader(line for line in f if not line.startswith("#"))}


def age_factor(age: float | None) -> float:
    if age is None:
        return NEUTRAL_AGE_FACTOR
    if 24 <= age <= 30:
        return 100.0
    if age < 24:
        return max(60.0, 100.0 - 8 * (24 - age))
    return max(20.0, 100.0 - (8 if age <= 34 else 15) * (age - 30))


def compute(squad: list[dict], data: dict[str, PlayerData], seasons: list[int]) -> list[dict]:
    names = match_names(squad, data)
    roles = {r["id"]: r["role"] for r in squad}
    ages = load_ages()

    full = {i: weighted(data[cs], seasons, SEASON_WEIGHTS) for i, cs in names.items()}
    latest = {i: weighted(data[cs], seasons[:1], [1.0]) for i, cs in names.items()}
    bat_all, bowl_all = score(full, roles)
    bat_now, bowl_now = score(latest, roles)

    rows = []
    for i, cs in names.items():
        skill = skill_for(roles[i], bat_all.get(i), bowl_all.get(i))
        if skill is None:
            continue  # not enough data: keep the price-derived rating
        form = skill_for(roles[i], bat_now.get(i), bowl_now.get(i))
        form = skill if form is None else form
        experience = min(100.0, float(data[cs].ipl_matches))
        # Current form counts heavily so breakout seasons show; experience barely, so newcomers aren't held back.
        rating = 0.60 * skill + 0.30 * form + 0.05 * experience + 0.05 * age_factor(ages.get(i))
        rows.append({
            "id": i,
            "cricsheet_name": cs,
            "rating": round(rating),
            "balls_bat": round(full[i].balls),
            "balls_bowl": round(full[i].bowl_balls),
            "matches": round(full[i].matches),
        })
    return sorted(rows, key=lambda r: -r["rating"])


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--download", action="store_true", help="download Cricsheet zips into ./cache first")
    ap.add_argument("--data-dir", type=Path, help="folder of Cricsheet match JSON files instead of the zips")
    ap.add_argument("--ipl-csv", type=Path, help="folder with Match_Info.csv + Ball_By_Ball_Match_Data.csv (IPL only)")
    ap.add_argument("--latest-season", type=int, default=2026, help="most recent season to include")
    ap.add_argument("--out", type=Path, default=RAW / "ratings-cricsheet.csv")
    args = ap.parse_args()

    if args.download:
        download(CACHE)
    seasons = [args.latest_season - k for k in range(len(SEASON_WEIGHTS))]
    if args.ipl_csv:
        data = collect(iter_ipl_csv(args.ipl_csv), seasons)
    else:
        data = collect(iter_matches(None if args.data_dir else CACHE, args.data_dir), seasons)
    rows = compute(load_squads(), data, seasons)
    with open(args.out, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["id", "cricsheet_name", "rating", "balls_bat", "balls_bowl", "matches"])
        w.writeheader()
        w.writerows(rows)
    print(f"wrote {len(rows)} ratings to {args.out} (seasons {seasons})")


if __name__ == "__main__":
    main()
