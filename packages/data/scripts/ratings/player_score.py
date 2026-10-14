#!/usr/bin/env python3
"""
Player Score: one central 0-100 number per player that moves after every T20 match he plays,
in any competition. The game takes each player's rating, fair value, base price and team-strength
numbers from it.

    python3 player_score.py                 # build from raw/cricsheet/t20-matches.jsonl.gz
                                            # (npm run data:fetch) plus the IPL CSV mirror
    python3 player_score.py --download-ipl  # refresh the IPL CSV mirror first
    python3 player_score.py --tune          # let the data choose the settings and the mix
    python3 player_score.py --backtest      # how well the current settings predict

Writes packages/data/generated/player-score.json, which `npm run seed` turns into the game.

How a match is scored
---------------------
Every ball is judged against par for its phase (powerplay overs 1-6, middle 7-15, death 16-20)
in that competition and season, adjusted for how high-scoring the match was:

  batting  = sum over balls faced of (runs - par)
  bowling  = sum over balls bowled of (par - runs conceded) + value of each wicket taken
  fielding = credit for catches, stumpings and run-outs

A wicket is worth the season's runs per wicket, scaled by who got out: openers and No. 3 x1.3,
Nos. 4-6 x1.0, No. 7 x0.7, the tail x0.4. A catch or stumping earns the fielder 30% of that
wicket's value; a run-out is shared among the fielders involved. Close finishes (won by 10 runs
or fewer, or chased with an over or less or two wickets or fewer left) count 1.25x.

Each contribution becomes a 0-100 match score: 50 is an average IPL performance, one standard
deviation is 15. Scores from other competitions are shifted by that competition's strength,
which the data measures: players who appear in two competitions show how a score in one
translates to the other (IPL = 0).

What the score is made of
-------------------------
For batting, bowling and fielding separately:

  Form        the last few matches (moves fast)
  Class       the whole record since 2021 (moves slowly)
  Importance  the proven match-winner part: the best season (average match score, pulled toward
              Class when the season was short) in the last three years, plus how much better or worse than usual the player does in close finishes.
              This is what keeps a Bumrah or a Hardik high through an off season.

  Score = w_form x Form + w_class x Class + w_importance x Importance

The weights, the memory speeds and how much other competitions count are all chosen by --tune:
the combination that best predicts players' next IPL performances in 2025, then checked on 2026,
which the search never saw.

Batters and keepers are judged on batting, bowlers on bowling, all-rounders on 55% of the better
skill and 45% of the other. Fielding then counts 10% (15% for keepers).
"""
from __future__ import annotations

import argparse
import gzip
import itertools
import json
import statistics
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field as dc_field
from pathlib import Path

import compute_ratings as cr

HERE = Path(__file__).resolve().parent
DATA_ROOT = HERE.parent.parent
GENERATED = DATA_ROOT / "generated"
RAW = DATA_ROOT / "raw"
T20_FILE = RAW / "cricsheet" / "t20-matches.jsonl.gz"
IPL_CSV = HERE / "cache" / "ipl-csv"
MIRROR = "https://raw.githubusercontent.com/ritesh-ojha/IPL-DATASET/main/csv"
IPL_FILES = ["Match_Info.csv", "Ball_By_Ball_Match_Data.csv"]

SINCE = "2021-01-01"
NEWCOMER = 45.0
AVERAGE = 50.0
SCORE_SD = 15.0
FULL_BAT_BALLS = 15
FULL_BOWL_BALLS = 18
FULL_CONFIDENCE = 12.0
HISTORY = 15
PEAK_MIN_SEASON = 5.0  # a season counts for Importance after 5 full appearances
CLUTCH_PRIOR = 8.0  # close matches needed before clutch counts half
COMP_SHRINK = 40.0  # appearances needed before a competition's strength counts half
NOT_BOWLER_WICKETS = cr.NOT_BOWLER_WICKETS
TOP_LEVEL = {"ipl", "t20s"}

COMPETITION_NAMES = {
    "ipl": "IPL", "t20s": "T20 internationals", "sma": "Syed Mushtaq Ali Trophy", "bbl": "Big Bash League",
    "psl": "Pakistan Super League", "cpl": "Caribbean Premier League", "sat": "SA20", "ilt": "ILT20",
    "mlc": "Major League Cricket", "ntb": "T20 Blast", "bpl": "Bangladesh Premier League",
    "lpl": "Lanka Premier League", "ssm": "Super Smash", "ctc": "CSA T20 Challenge",
}

# Chosen by --tune (see calibration in the output). Scoring settings (close_match, catch_share)
# define the targets themselves, so they are fixed by principle rather than tuned.
SETTINGS = {
    "alpha_form": 0.5,
    "alpha_class": 0.02,
    "peak_shrink": 12.0,
    "other_weight": 0.5,
    "w_form": 0.2,
    "w_class": 0.7,
    "w_importance": 0.1,
    "close_match": 1.25,
    "catch_share": 0.3,
}
MEMORY_GRID = {
    "alpha_form": [0.35, 0.5],
    "alpha_class": [0.02, 0.04],
    "peak_shrink": [3.0, 6.0, 12.0],
    "other_weight": [0.25, 0.5, 0.75, 1.0],
}
WEIGHT_STEP = 0.1

PHASES = ((0, 6, "powerplay"), (6, 15, "middle"), (15, 99, "death"))
POSITION_WEIGHT = {1: 1.3, 2: 1.3, 3: 1.3, 4: 1.0, 5: 1.0, 6: 1.0, 7: 0.7}  # 8-11: 0.4


def phase_of(over: int) -> str:
    return next(name for lo, hi, name in PHASES if lo <= over < hi)


def legal(d: dict) -> bool:
    ex = d.get("extras", {})
    return "wides" not in ex and "noballs" not in ex


# ------------------------------------------------------------------ data

def download_ipl(folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for name in IPL_FILES:
        url = f"{MIRROR}/{name}"
        print(f"downloading {url}")
        with urllib.request.urlopen(url) as resp:  # noqa: S310 (fixed https host)
            (folder / name).write_bytes(resp.read())


def match_key(m: dict) -> tuple:
    """Same match from two sources: same date and same first ball."""
    first = m["innings"][0]["overs"][0]["deliveries"][0] if m["innings"] and m["innings"][0]["overs"] else {}
    return m["info"]["dates"][0], first.get("batter"), first.get("bowler")


def load_matches(t20_file: Path | None, ipl_csv: Path | None) -> list[tuple[str, dict]]:
    """(competition code, match) since SINCE, oldest first. The IPL CSV only fills IPL gaps."""
    out: list[tuple[str, dict]] = []
    seen: set[tuple] = set()
    if t20_file and t20_file.exists():
        with gzip.open(t20_file, "rt") as f:
            for line in f:
                if not line.strip():
                    continue
                m = json.loads(line)
                comp = m.pop("comp")
                out.append((comp, m))
                if comp == "ipl":
                    seen.add(match_key(m))
    if ipl_csv and (ipl_csv / IPL_FILES[0]).exists():
        for _, _, m in cr.iter_ipl_csv(ipl_csv):
            if m["innings"] and match_key(m) not in seen:
                out.append(("ipl", m))
    out = [(c, m) for c, m in out if m["innings"] and m["info"]["dates"][0] >= SINCE]
    out.sort(key=lambda x: x[1]["info"]["dates"][0])
    return out


def year_of(m: dict) -> int:
    return int(m["info"]["dates"][0][:4])


# ------------------------------------------------------------------ scoring one match

def pars(matches) -> dict:
    """Par per (competition, season): runs per ball by phase, overall, runs per wicket."""
    def blank():
        return {"runs": defaultdict(float), "balls": defaultdict(float), "bat_runs": defaultdict(float),
                "faced": defaultdict(float), "wkts": 0.0}

    acc: dict = defaultdict(blank)
    for comp, m in matches:
        keys = [(comp, cr.season_of(m)), (comp, None), (None, None)]
        for inn in m["innings"]:
            if inn.get("super_over"):
                continue
            for over in inn["overs"]:
                ph = phase_of(over["over"])
                for d in over["deliveries"]:
                    ex = d.get("extras", {})
                    r = d["runs"]["batter"] + ex.get("wides", 0) + ex.get("noballs", 0)
                    w = sum(1 for x in d.get("wickets", []) if x["kind"] not in NOT_BOWLER_WICKETS)
                    for k in keys:
                        a = acc[k]
                        a["runs"][ph] += r
                        a["balls"][ph] += 1 if legal(d) else 0
                        if "wides" not in ex:
                            a["bat_runs"][ph] += d["runs"]["batter"]
                            a["faced"][ph] += 1
                        a["wkts"] += w

    def finish(a):
        runs, balls = sum(a["runs"].values()), sum(a["balls"].values()) or 1
        return {
            # Bowlers are judged on everything they concede per legal ball; batters only on
            # their own runs per ball faced (they can't score wides).
            "phase": {ph: a["runs"][ph] / max(1.0, a["balls"][ph]) for _, _, ph in PHASES},
            "bat_phase": {ph: a["bat_runs"][ph] / max(1.0, a["faced"][ph]) for _, _, ph in PHASES},
            "overall": runs / balls,
            "runs_per_wicket": runs / max(1.0, a["wkts"]),
            "balls": balls,
        }

    done = {k: finish(a) for k, a in acc.items()}

    def lookup(comp, season):
        for k in ((comp, season), (comp, None), (None, None)):
            if k in done and done[k]["balls"] >= 3000:
                return done[k]
        return done[(None, None)]

    return {k: lookup(*k) for k in done if k[1] is not None}


def is_close(m: dict) -> bool:
    totals, wkts, balls = [], [], []
    for inn in m["innings"]:
        if inn.get("super_over"):
            return True
        r = w = b = 0
        for over in inn["overs"]:
            for d in over["deliveries"]:
                r += d["runs"]["total"]
                w += len(d.get("wickets", []))
                b += 1 if legal(d) else 0
        totals.append(r)
        wkts.append(w)
        balls.append(b)
    if len(totals) < 2:
        return False
    if totals[1] > totals[0]:
        return balls[1] >= 114 or wkts[1] >= 8
    return totals[0] - totals[1] <= 10


@dataclass
class Line:
    bat: float = 0.0
    bowl: float = 0.0
    field: float = 0.0
    balls: int = 0
    bowl_balls: int = 0
    position: int = 0
    bat_death_balls: int = 0
    bowl_phase: dict = dc_field(default_factory=lambda: defaultdict(int))


def match_lines(m: dict, par: dict, close_mult: float, catch_share: float) -> dict[str, Line]:
    """Each player's batting, bowling and fielding contribution (in runs) in one match."""
    lines: dict[str, Line] = defaultdict(Line)
    runs = balls = 0
    for inn in m["innings"]:
        if inn.get("super_over"):
            continue
        for over in inn["overs"]:
            for d in over["deliveries"]:
                ex = d.get("extras", {})
                runs += d["runs"]["batter"] + ex.get("wides", 0) + ex.get("noballs", 0)
                balls += 1 if legal(d) else 0
    conditions = (runs / balls) / par["overall"] if balls else 1.0
    mult = close_mult if is_close(m) else 1.0
    for inn in m["innings"]:
        if inn.get("super_over"):
            continue
        order: dict[str, int] = {}
        for over in inn["overs"]:
            ph = phase_of(over["over"])
            p = par["phase"][ph] * conditions
            pb = par["bat_phase"][ph] * conditions
            for d in over["deliveries"]:
                for who in (d["batter"], d.get("non_striker", "")):
                    if who and who not in order:
                        order[who] = len(order) + 1
                        lines[who].position = order[who]
                ex = d.get("extras", {})
                wide, nb = "wides" in ex, "noballs" in ex
                b, w = lines[d["batter"]], lines[d["bowler"]]
                if not wide:
                    b.balls += 1
                    b.bat += (d["runs"]["batter"] - pb) * mult
                    if ph == "death":
                        b.bat_death_balls += 1
                conceded = d["runs"]["batter"] + ex.get("wides", 0) + ex.get("noballs", 0)
                if not wide and not nb:
                    w.bowl_balls += 1
                    w.bowl_phase[ph] += 1
                    w.bowl += (p - conceded) * mult
                else:
                    w.bowl -= conceded * mult
                for wk in d.get("wickets", []):
                    pos = order.get(wk["player_out"], 8)
                    value = par["runs_per_wicket"] * POSITION_WEIGHT.get(pos, 0.4) * mult
                    kind = wk["kind"]
                    fielders = [f["name"] for f in wk.get("fielders", []) if f.get("name")]
                    if kind not in NOT_BOWLER_WICKETS:
                        w.bowl += value
                    if kind == "caught and bowled":
                        w.field += catch_share * value
                    elif kind in ("caught", "stumped") and fielders:
                        lines[fielders[0]].field += catch_share * value
                    elif kind == "run out" and fielders:
                        for f in fielders:
                            lines[f].field += catch_share * value / len(fielders)
    return lines


# ------------------------------------------------------------------ all matches

def competition_strength(rows: list[tuple[str, str, float]]) -> dict[str, float]:
    """
    rows = (player, competition, score). Fits score = player level + competition effect with the
    IPL fixed at 0, so a competition's effect is how much higher the same players score there.
    Effects resting on few appearances are pulled toward 0.
    """
    comps = {c for _, c, _ in rows}
    effect = {c: 0.0 for c in comps}
    level: dict[str, float] = {}
    for _ in range(25):
        acc = defaultdict(list)
        for p, c, s in rows:
            acc[p].append(s - effect[c])
        level = {p: statistics.fmean(v) for p, v in acc.items()}
        accc = defaultdict(list)
        for p, c, s in rows:
            accc[c].append(s - level[p])
        for c, v in accc.items():
            effect[c] = sum(v) / (len(v) + COMP_SHRINK)
        base = effect.get("ipl", 0.0)
        effect = {c: e - base for c, e in effect.items()}
    return effect


def score_matches(matches, settings) -> tuple[list, dict]:
    """Every (match, player) contribution as a 0-100 score in IPL terms, oldest first."""
    par = pars(matches)
    raw = []
    for comp, m in matches:
        lines = match_lines(m, par[(comp, cr.season_of(m))], settings["close_match"], settings["catch_share"])
        raw.append((comp, m, lines, is_close(m)))

    def cal(xs):
        return statistics.fmean(xs), statistics.pstdev(xs)

    ipl = [r for r in raw if r[0] == "ipl"] or raw
    c = {
        "bat": cal([l.bat for _, _, ls, _ in ipl for l in ls.values() if l.balls >= 10]),
        "bowl": cal([l.bowl for _, _, ls, _ in ipl for l in ls.values() if l.bowl_balls >= 12]),
        # Most players field without taking a catch, so measure fielding over everyone in each XI.
        "field": cal([ls[p].field if p in ls else 0.0 for _, m, ls, _ in ipl
                      for ps in m["info"]["players"].values() for p in ps]),
    }

    def to_score(x, kind):
        mean, sd = c[kind]
        return AVERAGE + (x - mean) / sd * SCORE_SD if sd else AVERAGE

    scored = []
    for comp, m, lines, close in raw:
        team_of = {p: t for t, ps in m["info"]["players"].items() for p in ps}
        entries = {}
        for name in team_of:
            l = lines.get(name, Line())
            entries[name] = {
                "bat": to_score(l.bat, "bat") if l.balls > 0 else None,
                "bowl": to_score(l.bowl, "bowl") if l.bowl_balls > 0 else None,
                "field": to_score(l.field, "field"),
                "balls": l.balls, "bowl_balls": l.bowl_balls, "position": l.position,
                "bat_death_balls": l.bat_death_balls, "bowl_phase": dict(l.bowl_phase),
                "team": team_of[name],
            }
        scored.append((comp, m, entries, close))

    # Competition strength, measured from players who appear in more than one competition.
    effects = {}
    for kind, min_balls in (("bat", 10), ("bowl", 12)):
        rows = [(p, comp, e[kind]) for comp, _, es, _ in scored for p, e in es.items()
                if e[kind] is not None and e["balls" if kind == "bat" else "bowl_balls"] >= min_balls]
        effects[kind] = competition_strength(rows)
    for comp, _, es, _ in scored:
        for e in es.values():
            for kind in ("bat", "bowl"):
                if e[kind] is not None:
                    e[kind] = max(0.0, min(100.0, e[kind] - effects[kind].get(comp, 0.0)))
            e["field"] = max(0.0, min(100.0, e["field"]))
    return scored, {"impact_mean_sd": c, "competition_effect": effects}


# ------------------------------------------------------------------ the score

@dataclass
class Skill:
    form: float = NEWCOMER
    klass: float = NEWCOMER
    n: float = 0.0
    season_n: dict = dc_field(default_factory=lambda: defaultdict(float))
    season_sum: dict = dc_field(default_factory=lambda: defaultdict(float))
    peak_shrink: float = 6.0
    clutch_sum: float = 0.0
    clutch_n: float = 0.0

    def season_level(self, y: int) -> float:
        """A season's average match score, pulled toward Class when the season was short."""
        return (self.season_sum[y] + self.peak_shrink * self.klass) / (self.season_n[y] + self.peak_shrink)

    def peak(self, year: int) -> float:
        levels = [self.season_level(y) for y in self.season_n if year - 2 <= y <= year and self.season_n[y] >= PEAK_MIN_SEASON]
        return max(levels) if levels else self.klass

    def clutch(self) -> float:
        return self.clutch_sum / (self.clutch_n + CLUTCH_PRIOR)

    def importance(self, year: int) -> float:
        return self.peak(year) + self.clutch()

    def value(self, s: dict, year: int) -> float:
        return s["w_form"] * self.form + s["w_class"] * self.klass + s["w_importance"] * self.importance(year)

    def update(self, x: float, w: float, s: dict, year: int, close: bool) -> None:
        if close:
            self.clutch_sum += w * (x - (0.5 * self.form + 0.5 * self.klass))
            self.clutch_n += w
        self.form += s["alpha_form"] * w * (x - self.form)
        self.klass += s["alpha_class"] * w * (x - self.klass)
        self.peak_shrink = s["peak_shrink"]
        self.n += w
        self.season_n[year] += w
        self.season_sum[year] += w * x


@dataclass
class Track:
    bat: Skill = dc_field(default_factory=Skill)
    bowl: Skill = dc_field(default_factory=Skill)
    field: Skill = dc_field(default_factory=Skill)
    comps: dict = dc_field(default_factory=lambda: defaultdict(int))
    history: list = dc_field(default_factory=list)
    usage: list = dc_field(default_factory=list)  # (date, position, balls, death balls faced, bowling phases)


def comp_weight(comp: str, s: dict) -> float:
    return 1.0 if comp in TOP_LEVEL else s["other_weight"]


def replay(scored, s: dict, on_before=None) -> dict[str, Track]:
    """Replay every match in order. on_before(name, track, entry, comp, year) sees each player beforehand."""
    tracks: dict[str, Track] = defaultdict(Track)
    for comp, m, entries, close in scored:
        year = year_of(m)
        date = m["info"]["dates"][0]
        teams = list(m["info"]["players"])
        cw = comp_weight(comp, s)
        for name, e in entries.items():
            t = tracks[name]
            if on_before:
                on_before(name, t, e, comp, year)
            if e["bat"] is not None:
                t.bat.update(e["bat"], cw * min(1.0, e["balls"] / FULL_BAT_BALLS), s, year, close)
            if e["bowl"] is not None:
                t.bowl.update(e["bowl"], cw * min(1.0, e["bowl_balls"] / FULL_BOWL_BALLS), s, year, close)
            t.field.update(e["field"], cw * 0.5, s, year, False)
            t.comps[comp] += 1
            t.usage.append((date, e["position"], e["balls"], e["bat_death_balls"], e["bowl_phase"]))
            t.history.append({"date": date, "comp": comp, "against": next((x for x in teams if x != e["team"]), ""),
                              "bat": e["bat"], "bowl": e["bowl"], "field": e["field"], "year": year})
    return tracks


# ------------------------------------------------------------------ choosing the settings

def spearman(xs: list[float], ys: list[float]) -> float:
    def ranks(v):
        order = sorted(range(len(v)), key=lambda i: v[i])
        r = [0.0] * len(v)
        i = 0
        while i < len(order):
            j = i
            while j + 1 < len(order) and v[order[j + 1]] == v[order[i]]:
                j += 1
            for k in range(i, j + 1):
                r[order[k]] = (i + j) / 2
            i = j + 1
        return r
    if len(xs) < 3:
        return 0.0
    rx, ry = ranks(xs), ranks(ys)
    mx, my = statistics.fmean(rx), statistics.fmean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5
    return num / den if den else 0.0


def predictions(scored, s: dict, seasons: set[int]) -> list[tuple[int, float, float, float, float]]:
    """(season, form, class, importance, actual) before every IPL innings (10+ balls) / spell (12+ balls)."""
    out = []

    def before(name, t, e, comp, year):
        if comp != "ipl" or year not in seasons:
            return
        if e["bat"] is not None and e["balls"] >= 10 and t.bat.n >= 3:
            out.append((year, t.bat.form, t.bat.klass, t.bat.importance(year), e["bat"]))
        if e["bowl"] is not None and e["bowl_balls"] >= 12 and t.bowl.n >= 3:
            out.append((year, t.bowl.form, t.bowl.klass, t.bowl.importance(year), e["bowl"]))

    replay(scored, s, before)
    return out


def weight_options():
    steps = [round(i * WEIGHT_STEP, 2) for i in range(int(1 / WEIGHT_STEP) + 1)]
    for wf in steps:
        for wc in steps:
            wi = round(1 - wf - wc, 2)
            if wi >= -1e-9:
                yield {"w_form": wf, "w_class": wc, "w_importance": max(0.0, wi)}


def accuracy(preds, w: dict, season) -> float:
    seasons = season if isinstance(season, (set, frozenset, tuple, list)) else {season}
    xs = [w["w_form"] * f + w["w_class"] * c + w["w_importance"] * i for y, f, c, i, _ in preds if y in seasons]
    ys = [a for y, _, _, _, a in preds if y in seasons]
    return spearman(xs, ys)


def tune(scored, fit: tuple = (2024, 2025), test: int = 2026) -> dict:
    """Choose memory speeds, competition weight and the Form/Class/Importance mix on `fit`, check on `test`."""
    results = []
    for values in itertools.product(*MEMORY_GRID.values()):
        s = {**SETTINGS, **dict(zip(MEMORY_GRID, values))}
        preds = predictions(scored, s, {*fit, test})
        for w in weight_options():
            results.append((accuracy(preds, w, fit), {**s, **w}, preds))
    results.sort(key=lambda r: -r[0])
    best_fit, best, best_preds = results[0]
    no_importance = max((r for r in results if r[1]["w_importance"] == 0), key=lambda r: r[0])
    cur_preds = predictions(scored, SETTINGS, {*fit, test})
    return {
        "best": {k: best[k] for k in SETTINGS},
        "fit_seasons": list(fit),
        "test_season": test,
        "accuracy": {
            "chosen": {"fit": round(best_fit, 4), "test": round(accuracy(best_preds, best, test), 4)},
            "without_importance": {"fit": round(no_importance[0], 4),
                                   "test": round(accuracy(no_importance[2], no_importance[1], test), 4)},
            "previous_settings": {"fit": round(accuracy(cur_preds, SETTINGS, fit), 4),
                                  "test": round(accuracy(cur_preds, SETTINGS, test), 4)},
        },
        "predictions": len([p for p in best_preds if p[0] == test]),
    }


# ------------------------------------------------------------------ export

def role_value(role: str, bat: float, bowl: float, fld: float, bat_n: float, bowl_n: float) -> float:
    if role in ("BAT", "WK"):
        core = bat
    elif role == "BOWL":
        core = bowl
    else:
        b = bat if bat_n >= 2 else min(bat, NEWCOMER)
        w = bowl if bowl_n >= 2 else min(bowl, NEWCOMER)
        core = 0.55 * max(b, w) + 0.45 * min(b, w)
    f = 0.15 if role == "WK" else 0.10
    return (1 - f) * core + f * fld


def tags(t: Track, latest: str, role: str) -> list[str]:
    """What teams use the player for, from the last two years of matches."""
    cutoff = f"{int(latest[:4]) - 2}{latest[4:]}"
    recent = [u for u in t.usage if u[0] >= cutoff]
    out = []
    inns = [u for u in recent if u[2] >= 1 and u[1] > 0]
    if len(inns) >= 8 and role != "BOWL":
        avg_pos = statistics.fmean(u[1] for u in inns)
        balls = sum(u[2] for u in inns)
        death = sum(u[3] for u in inns)
        if avg_pos <= 2.2:
            out.append("opener")
        elif avg_pos >= 4.5 and balls and death / balls >= 0.4:
            out.append("finisher")
    phase = defaultdict(int)
    for u in recent:
        for ph, n in u[4].items():
            phase[ph] += n
    total = sum(phase.values())
    if total >= 120 and role not in ("BAT", "WK"):
        if phase["powerplay"] / total >= 0.4:
            out.append("powerplay")
        if phase["death"] / total >= 0.35:
            out.append("death")
    return out


def player_view(role: str, t: Track, s: dict, year: int) -> dict:
    def part(sk: Skill):
        return {"score": round(sk.value(s, year), 1), "form": round(sk.form, 1), "class": round(sk.klass, 1),
                "importance": round(sk.importance(year), 1), "matches": round(sk.n, 1)}

    def pick(fn):
        return role_value(role, fn(t.bat), fn(t.bowl), fn(t.field), t.bat.n, t.bowl.n)

    return {
        "score": round(pick(lambda k: k.value(s, year)), 1),
        "form": round(pick(lambda k: k.form), 1),
        "class": round(pick(lambda k: k.klass), 1),
        "importance": round(pick(lambda k: k.importance(year)), 1),
        "batting": part(t.bat),
        "bowling": part(t.bowl),
        "fielding": part(t.field),
    }


def export(scored, squad, names, s: dict, calibration: dict) -> dict:
    """Replay once more, recording each squad player's score after every match he played."""
    wanted = {cs: r for r in squad if (cs := names.get(r["id"]))}
    trail: dict[str, list] = defaultdict(list)
    latest = scored[-1][1]["info"]["dates"][0]

    def before(name, t, e, comp, year):
        if name in wanted and t.history:
            h = t.history[-1]
            trail[name].append((h, player_view(wanted[name]["role"], t, s, h["year"])["score"]))

    final = replay(scored, s, before)
    players = {}
    year = int(latest[:4])
    for cs, r in wanted.items():
        if cs not in final:
            continue
        t = final[cs]
        role = r["role"]
        view = player_view(role, t, s, year)
        steps = trail[cs] + [(t.history[-1], view["score"])]
        history = []
        for h, sc in steps[-HISTORY:]:
            perf = [x for x in ((h["bat"] if role != "BOWL" else None), (h["bowl"] if role not in ("BAT", "WK") else None)) if x is not None]
            history.append({"date": h["date"], "comp": h["comp"], "against": h["against"],
                            "match": round(max(perf), 1) if perf else None, "score": round(sc, 1)})
        main_n = {"BAT": t.bat.n, "WK": t.bat.n, "BOWL": t.bowl.n}.get(role, max(t.bat.n, t.bowl.n))
        earlier = steps[-6][1] if len(steps) >= 6 else (steps[0][1] if steps else view["score"])
        players[r["id"]] = {
            "cricsheet_name": cs,
            **view,
            "confidence": round(min(1.0, main_n / FULL_CONFIDENCE), 2),
            "trend": round(view["score"] - earlier, 1),
            "matches": dict(t.comps),
            "last_match": t.history[-1]["date"],
            "tags": tags(t, latest, role),
            "timeline": [(h["date"], round(sc, 1)) for h, sc in steps],
            "history": history,
        }
    return {
        "method": __doc__.split("How a match is scored")[1].strip(),
        "settings": s,
        "calibration": calibration,
        "players": players,
    }


def auction_check(out: dict, squad: list[dict]) -> dict:
    """
    Validation only: do players the score rates higher get paid more? Compares each 2026 auction
    buy's price with his score on the eve of the December 2025 auction.
    """
    eve = "2025-12-15"
    pairs = []
    for r in squad:
        p = out["players"].get(r["id"])
        if not p or r.get("acquired") != "auction" or not r.get("price_lakh"):
            continue
        before = [sc for d, sc in p["timeline"] if d < eve]
        if before:
            pairs.append((before[-1], int(r["price_lakh"]), r["name"]))
    return {"auction_buys": len(pairs), "spearman_score_vs_price": round(spearman([a for a, _, _ in pairs], [b for _, b, _ in pairs]), 3)}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--download-ipl", action="store_true", help="refresh the IPL CSV mirror first")
    ap.add_argument("--t20", type=Path, default=T20_FILE, help="compact Cricsheet file from npm run data:fetch")
    ap.add_argument("--ipl-csv", type=Path, default=IPL_CSV, help="folder with the IPL CSV mirror")
    ap.add_argument("--tune", action="store_true", help="let the data choose the settings and print them")
    ap.add_argument("--backtest", action="store_true", help="print how well the current settings predict")
    ap.add_argument("--out", type=Path, default=GENERATED / "player-score.json")
    args = ap.parse_args()
    if args.download_ipl:
        download_ipl(args.ipl_csv)
    matches = load_matches(args.t20, args.ipl_csv)
    if not matches:
        raise SystemExit("No match data. Run `npm run data:fetch` or pass --ipl-csv.")
    comps = defaultdict(int)
    for c, _ in matches:
        comps[c] += 1
    scored, cal = score_matches(matches, SETTINGS)
    if args.tune:
        print(json.dumps(tune(scored), indent=1))
        return
    preds = predictions(scored, SETTINGS, {2025, 2026})
    bt = {str(y): round(accuracy(preds, SETTINGS, y), 4) for y in (2025, 2026)}
    if args.backtest:
        print(json.dumps(bt, indent=1))
    squad = cr.load_squads()
    data = cr.collect(((1.0, c == "ipl", m) for c, m in matches), sorted({year_of(m) for _, m in matches}, reverse=True))
    names = cr.match_names(squad, data)
    calibration = {
        "since": SINCE,
        "latest_match": matches[-1][1]["info"]["dates"][0],
        "matches": {COMPETITION_NAMES.get(c, c): n for c, n in sorted(comps.items(), key=lambda x: -x[1])},
        "impact_mean_sd": {k: [round(v[0], 2), round(v[1], 2)] for k, v in cal["impact_mean_sd"].items()},
        "competition_effect": {k: {COMPETITION_NAMES.get(c, c): round(e, 1) for c, e in v.items()}
                               for k, v in cal["competition_effect"].items()},
        "next_ipl_match_prediction": bt,
    }
    out = export(scored, squad, names, SETTINGS, calibration)
    out["calibration"]["auction_check"] = auction_check(out, squad)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=1) + "\n")
    print(f"Player Score for {len(out['players'])} of {len(squad)} squad players from {len(matches)} matches "
          f"({', '.join(f'{k} {v}' for k, v in calibration['matches'].items())}).")
    print(f"Next IPL match prediction: {bt}. Auction check: {out['calibration']['auction_check']}")


if __name__ == "__main__":
    main()
