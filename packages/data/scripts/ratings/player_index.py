#!/usr/bin/env python3
"""
Player Index: a 0-100 rating for every squad player that moves after every T20 match.

    python3 player_index.py --download            # latest IPL data from the GitHub mirror, then build
    python3 player_index.py --ipl-csv FOLDER      # IPL: Match_Info.csv + Ball_By_Ball_Match_Data.csv
    python3 player_index.py --cricsheet           # every competition in compute_ratings.COMPETITIONS
                                                  # (run compute_ratings.py --download first)
    python3 player_index.py --backtest            # test the settings; --tune searches for better ones

Writes packages/data/generated/player-index.json, which `npm run seed` turns into game ratings.

How a match is scored
---------------------
Every ball is judged against par for its phase of the innings, adjusted to that match:

  par (runs per ball) = this season's average for the phase (powerplay overs 1-6, middle 7-15,
                        death 16-20) x how high-scoring this match was compared with the season

  batting  = sum over balls faced of (runs - par)
  bowling  = sum over balls bowled of (par - runs conceded) + value of each wicket taken
  fielding = credit for catches, stumpings and run-outs

A wicket is worth the season's runs per wicket, scaled by who got out: openers and No. 3
x1.3, Nos. 4-6 x1.0, No. 7 x0.7, the tail x0.4. A catch or stumping earns the fielder 30% of
that wicket's value; a run-out is shared among the fielders involved.

Close finishes count more: in a match won by 10 runs or fewer, or chased with an over or
less to spare or two wickets or fewer in hand, every contribution counts 1.25x.

Each contribution becomes a 0-100 match score: 50 is average, one standard deviation is 15.

How the index moves
-------------------
Each player keeps a batting, a bowling and a fielding index, starting at 45 for a newcomer.

  Form   moves part of the way toward each match score (ALPHA_FORM) and drifts back toward 50
         between seasons: the last handful of matches.
  Class  moves slowly (ALPHA_CLASS) and never drifts: the whole career, recent matches counting
         a little more.

A match only moves an index as much as the player was involved (15+ balls faced or 18+ balls
bowled count fully) and as much as the competition counts (IPL and T20Is fully, overseas
leagues 0.85, Indian domestic 0.7).

  Index = FORM_WEIGHT x Form + (1 - FORM_WEIGHT) x Class

Batters and keepers are judged on batting, bowlers on bowling, all-rounders on 55% of the
better skill and 45% of the other. Fielding then counts 10% (15% for keepers).
Confidence (0-1) says how much cricket the index rests on: about 12 full matches = 1.
The settings at the top of this file were chosen by --tune (see the calibration block in the
output for how well they predict the next match).
"""
from __future__ import annotations

import argparse
import itertools
import json
import statistics
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field as dc_field
from pathlib import Path

import compute_ratings as cr

HERE = Path(__file__).resolve().parent
GENERATED = HERE.parent.parent / "generated"
CACHE = HERE / "cache" / "ipl-csv"
MIRROR = "https://raw.githubusercontent.com/ritesh-ojha/IPL-DATASET/main/csv"
FILES = ["Match_Info.csv", "Ball_By_Ball_Match_Data.csv"]

FIRST_SEASON = 2022
NEWCOMER = 45.0
AVERAGE = 50.0
SCORE_SD = 15.0
FULL_BAT_BALLS = 15
FULL_BOWL_BALLS = 18
FULL_CONFIDENCE_MATCHES = 12.0
HISTORY = 15
NOT_BOWLER_WICKETS = cr.NOT_BOWLER_WICKETS

# Tunable settings (chosen by --tune; see the module docstring).
# Memory settings below were chosen by `--tune` (fit on 2025, checked on unseen 2026).
SETTINGS = {
    "alpha_form": 0.5,
    "alpha_class": 0.02,
    "form_weight": 0.3,
    "season_regression": 0.0,
    "close_match": 1.25,
    "catch_share": 0.3,
}

PHASES = ((0, 6, "powerplay"), (6, 15, "middle"), (15, 99, "death"))
POSITION_WEIGHT = {1: 1.3, 2: 1.3, 3: 1.3, 4: 1.0, 5: 1.0, 6: 1.0, 7: 0.7}  # 8-11: 0.4


def phase_of(over: int) -> str:
    return next(name for lo, hi, name in PHASES if lo <= over < hi)


@dataclass
class Line:
    bat: float = 0.0
    bowl: float = 0.0
    field: float = 0.0
    balls: int = 0
    bowl_balls: int = 0
    fielded: bool = False


@dataclass
class Track:
    bat: float = NEWCOMER
    bowl: float = NEWCOMER
    field: float = NEWCOMER
    bat_class: float = NEWCOMER
    bowl_class: float = NEWCOMER
    field_class: float = NEWCOMER
    bat_n: float = 0.0
    bowl_n: float = 0.0
    last_season: int | None = None
    history: list = dc_field(default_factory=list)


# ------------------------------------------------------------------ data

def download(folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        url = f"{MIRROR}/{name}"
        print(f"downloading {url}")
        with urllib.request.urlopen(url) as resp:  # noqa: S310 (fixed https host)
            (folder / name).write_bytes(resp.read())


def season_pars(matches: list[tuple[float, bool, dict]]) -> dict[int, dict]:
    """Per season: runs per ball by phase, runs per ball overall, runs per wicket."""
    acc: dict[int, dict] = defaultdict(lambda: {"runs": defaultdict(float), "balls": defaultdict(float), "wkts": 0.0})
    for _, _, m in matches:
        a = acc[cr.season_of(m)]
        for inn in m["innings"]:
            if inn.get("super_over"):
                continue
            for over in inn["overs"]:
                ph = phase_of(over["over"])
                for d in over["deliveries"]:
                    ex = d.get("extras", {})
                    a["runs"][ph] += d["runs"]["batter"] + ex.get("wides", 0) + ex.get("noballs", 0)
                    if "wides" not in ex and "noballs" not in ex:
                        a["balls"][ph] += 1
                    a["wkts"] += sum(1 for w in d.get("wickets", []) if w["kind"] not in NOT_BOWLER_WICKETS)
    out = {}
    for season, a in acc.items():
        total_runs = sum(a["runs"].values())
        total_balls = sum(a["balls"].values()) or 1
        out[season] = {
            "phase": {ph: a["runs"][ph] / max(1.0, a["balls"][ph]) for _, _, ph in PHASES},
            "overall": total_runs / total_balls,
            "runs_per_wicket": total_runs / max(1.0, a["wkts"]),
        }
    return out


def is_close(m: dict) -> bool:
    """Won by 10 runs or fewer, or chased with 6 balls or fewer left or 2 wickets or fewer in hand."""
    totals, wkts, balls = [], [], []
    for inn in m["innings"]:
        if inn.get("super_over"):
            return True
        r = w = b = 0
        for over in inn["overs"]:
            for d in over["deliveries"]:
                ex = d.get("extras", {})
                r += d["runs"]["total"]
                w += len(d.get("wickets", []))
                if "wides" not in ex and "noballs" not in ex:
                    b += 1
        totals.append(r)
        wkts.append(w)
        balls.append(b)
    if len(totals) < 2:
        return False
    if totals[1] > totals[0]:
        return balls[1] >= 114 or wkts[1] >= 8
    return totals[0] - totals[1] <= 10


def match_lines(m: dict, par: dict, close_mult: float, catch_share: float) -> dict[str, Line]:
    """Each player's batting, bowling and fielding contribution (in runs) in one match."""
    lines: dict[str, Line] = defaultdict(Line)
    # How high-scoring this match was, compared with the season.
    runs = balls = 0
    for inn in m["innings"]:
        if inn.get("super_over"):
            continue
        for over in inn["overs"]:
            for d in over["deliveries"]:
                ex = d.get("extras", {})
                runs += d["runs"]["batter"] + ex.get("wides", 0) + ex.get("noballs", 0)
                if "wides" not in ex and "noballs" not in ex:
                    balls += 1
    conditions = (runs / balls) / par["overall"] if balls else 1.0
    mult = close_mult if is_close(m) else 1.0
    for inn in m["innings"]:
        if inn.get("super_over"):
            continue
        order: dict[str, int] = {}
        for over in inn["overs"]:
            p = par["phase"][phase_of(over["over"])] * conditions
            for d in over["deliveries"]:
                for who in (d["batter"], d.get("non_striker", "")):
                    if who and who not in order:
                        order[who] = len(order) + 1
                ex = d.get("extras", {})
                wide, nb = "wides" in ex, "noballs" in ex
                b, w = lines[d["batter"]], lines[d["bowler"]]
                if not wide:
                    b.balls += 1
                    b.bat += (d["runs"]["batter"] - p) * mult
                conceded = d["runs"]["batter"] + ex.get("wides", 0) + ex.get("noballs", 0)
                if not wide and not nb:
                    w.bowl_balls += 1
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
                        w.fielded = True
                    elif kind in ("caught", "stumped") and fielders:
                        lines[fielders[0]].field += catch_share * value
                        lines[fielders[0]].fielded = True
                    elif kind == "run out" and fielders:
                        for f in fielders:
                            lines[f].field += catch_share * value / len(fielders)
                            lines[f].fielded = True
    return lines


def load(args) -> list[tuple[float, bool, dict]]:
    if args.cricsheet:
        matches = list(cr.iter_matches(cr.CACHE, None))
        if args.ipl_csv and (args.ipl_csv / FILES[0]).exists():
            # Cricsheet's own IPL zip already covers the IPL; the CSV mirror is only a fallback.
            pass
        return [x for x in matches if cr.season_of(x[2]) >= FIRST_SEASON]
    return [x for x in cr.iter_ipl_csv(args.ipl_csv) if cr.season_of(x[2]) >= FIRST_SEASON]


# ------------------------------------------------------------------ the index

def score_matches(matches, settings):
    """Every (match, player) contribution as a 0-100 score, in date order."""
    matches = sorted(matches, key=lambda x: x[2]["info"]["dates"][0])
    pars = season_pars(matches)
    raw = []
    for comp_w, _, m in matches:
        par = pars[cr.season_of(m)]
        lines = match_lines(m, par, settings["close_match"], settings["catch_share"])
        raw.append((comp_w, m, lines))
    bats = [l.bat for _, _, ls in raw for l in ls.values() if l.balls >= 10]
    bowls = [l.bowl for _, _, ls in raw for l in ls.values() if l.bowl_balls >= 12]
    # Most players field without taking a catch, so measure fielding over everyone in each XI.
    fields = [ls[p].field if p in ls else 0.0
              for _, m, ls in raw for ps in m["info"]["players"].values() for p in ps]
    cal = {
        "bat": (statistics.fmean(bats), statistics.pstdev(bats)),
        "bowl": (statistics.fmean(bowls), statistics.pstdev(bowls)),
        "field": (statistics.fmean(fields), statistics.pstdev(fields)),
    }

    def to_score(x, kind):
        mean, sd = cal[kind]
        return max(0.0, min(100.0, AVERAGE + (x - mean) / sd * SCORE_SD)) if sd else AVERAGE

    out = []
    for comp_w, m, lines in raw:
        team_of = {p: t for t, ps in m["info"]["players"].items() for p in ps}
        entries = {}
        for name in team_of:
            l = lines.get(name, Line())
            entries[name] = {
                "bat": to_score(l.bat, "bat") if l.balls > 0 else None,
                "bowl": to_score(l.bowl, "bowl") if l.bowl_balls > 0 else None,
                "field": to_score(l.field, "field"),
                "balls": l.balls,
                "bowl_balls": l.bowl_balls,
                "team": team_of[name],
            }
        out.append((comp_w, m, entries))
    return out, cal, pars


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


def run_index(scored, settings, on_before=None) -> dict[str, Track]:
    """Replay every match in order. on_before(player, track, entry) sees the index before each match."""
    af, ac, reg = settings["alpha_form"], settings["alpha_class"], settings["season_regression"]
    tracks: dict[str, Track] = defaultdict(Track)
    for comp_w, m, entries in scored:
        season = cr.season_of(m)
        date = m["info"]["dates"][0]
        teams = list(m["info"]["players"])
        for name, e in entries.items():
            t = tracks[name]
            if t.last_season is not None and season != t.last_season:
                t.bat = AVERAGE + (t.bat - AVERAGE) * (1 - reg)
                t.bowl = AVERAGE + (t.bowl - AVERAGE) * (1 - reg)
                t.field = AVERAGE + (t.field - AVERAGE) * (1 - reg)
            t.last_season = season
            if on_before:
                on_before(name, t, e)
            if e["bat"] is not None:
                w = comp_w * min(1.0, e["balls"] / FULL_BAT_BALLS)
                t.bat += af * w * (e["bat"] - t.bat)
                t.bat_class += ac * w * (e["bat"] - t.bat_class)
                t.bat_n += w
            if e["bowl"] is not None:
                w = comp_w * min(1.0, e["bowl_balls"] / FULL_BOWL_BALLS)
                t.bowl += af * w * (e["bowl"] - t.bowl)
                t.bowl_class += ac * w * (e["bowl"] - t.bowl_class)
                t.bowl_n += w
            t.field += af * comp_w * 0.5 * (e["field"] - t.field)
            t.field_class += ac * comp_w * 0.5 * (e["field"] - t.field_class)
            if e["bat"] is None and e["bowl"] is None and e["field"] <= AVERAGE:
                continue
            opponent = next((x for x in teams if x != e["team"]), "")
            t.history.append({
                "date": date, "against": opponent, "bat": e["bat"], "bowl": e["bowl"], "field": e["field"],
                "state": (t.bat, t.bowl, t.field, t.bat_class, t.bowl_class, t.field_class, t.bat_n, t.bowl_n),
            })
    return tracks


# ------------------------------------------------------------------ backtest

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
    rx, ry = ranks(xs), ranks(ys)
    mx, my = statistics.fmean(rx), statistics.fmean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = (sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry)) ** 0.5
    return num / den if den else 0.0


def backtest(scored, settings, from_season: int = 2025, to_season: int = 9999) -> dict:
    """
    For every innings (10+ balls) and spell (12+ balls) from `from_season` on, compare the
    player's index before the match with the score he then made. Higher correlation = the
    index predicts better. Only players with some history (3+ earlier appearances) count.
    """
    fw = settings["form_weight"]
    preds = {"bat": ([], []), "bowl": ([], [])}

    def before(name, t, e):
        if not from_season <= int(e.get("season", 0) or 0) <= to_season:
            return
        if e["bat"] is not None and e["balls"] >= 10 and t.bat_n >= 3:
            preds["bat"][0].append(fw * t.bat + (1 - fw) * t.bat_class)
            preds["bat"][1].append(e["bat"])
        if e["bowl"] is not None and e["bowl_balls"] >= 12 and t.bowl_n >= 3:
            preds["bowl"][0].append(fw * t.bowl + (1 - fw) * t.bowl_class)
            preds["bowl"][1].append(e["bowl"])

    for _, m, entries in scored:
        s = cr.season_of(m)
        for e in entries.values():
            e["season"] = s
    run_index(scored, settings, before)
    return {k: {"n": len(v[0]), "spearman": round(spearman(*v), 4)} for k, v in preds.items()}


def combined(r: dict) -> float:
    n = r["bat"]["n"] + r["bowl"]["n"]
    return (r["bat"]["spearman"] * r["bat"]["n"] + r["bowl"]["spearman"] * r["bowl"]["n"]) / n if n else 0.0


def tune(matches, fit_season: int = 2025, test_season: int = 2026) -> dict:
    """
    Grid search how the index remembers. Settings are chosen on one season (fit) and then
    checked on the next season (test), which the search never saw, so a lucky fit shows up.
    Scoring settings change the targets themselves, so they stay fixed by principle.
    """
    grid = {
        "alpha_form": [0.08, 0.12, 0.15, 0.2, 0.3, 0.4, 0.5],
        "alpha_class": [0.005, 0.01, 0.02, 0.04, 0.07],
        "form_weight": [0.3, 0.45, 0.55, 0.7, 0.85],
        "season_regression": [0.0, 0.15, 0.3],
    }
    scored, _, _ = score_matches(matches, SETTINGS)
    results = []
    for values in itertools.product(*grid.values()):
        s = {**SETTINGS, **dict(zip(grid, values))}
        results.append((combined(backtest(scored, s, fit_season, fit_season)), s))
    results.sort(key=lambda x: -x[0])
    best = results[0][1]

    def check(s):
        return round(combined(backtest(scored, s, test_season, test_season)), 4)

    return {
        "best": best,
        "fit": {"season": fit_season, "best": round(results[0][0], 4),
                "current": round(combined(backtest(scored, SETTINGS, fit_season, fit_season)), 4)},
        "test": {"season": test_season, "best": check(best), "current": check(SETTINGS)},
        "top": [(round(c, 4), {k: s[k] for k in grid}) for c, s in results[:8]],
    }


# ------------------------------------------------------------------ export

def export(tracks, squad, names, settings, calibration) -> dict:
    fw = settings["form_weight"]
    players = {}
    for r in squad:
        cs = names.get(r["id"])
        if not cs or cs not in tracks:
            continue
        t = tracks[cs]
        role = r["role"]
        form = role_value(role, t.bat, t.bowl, t.field, t.bat_n, t.bowl_n)
        klass = role_value(role, t.bat_class, t.bowl_class, t.field_class, t.bat_n, t.bowl_n)
        index = fw * form + (1 - fw) * klass
        n = {"BAT": t.bat_n, "WK": t.bat_n, "BOWL": t.bowl_n}.get(role, max(t.bat_n, t.bowl_n))
        history = []
        for h in t.history[-HISTORY:]:
            bi, wi, fi, bc, wc, fc, bn, wn = h["state"]
            parts = [x for x in ((h["bat"] if role != "BOWL" else None), (h["bowl"] if role not in ("BAT", "WK") else None)) if x is not None]
            score = max(parts) if parts else None
            f_now = role_value(role, bi, wi, fi, bn, wn)
            history.append({
                "date": h["date"],
                "against": h["against"],
                "score": None if score is None else round(score, 1),
                "form": round(f_now, 1),
                "index": round(fw * f_now + (1 - fw) * role_value(role, bc, wc, fc, bn, wn), 1),
            })
        earlier = history[-6]["form"] if len(history) >= 6 else (history[0]["form"] if history else form)
        players[r["id"]] = {
            "cricsheet_name": cs,
            "index": round(index, 1),
            "form": round(form, 1),
            "class": round(klass, 1),
            "batting": round(t.bat, 1),
            "bowling": round(t.bowl, 1),
            "fielding": round(t.field, 1),
            "matches": len(t.history),
            "confidence": round(min(1.0, n / FULL_CONFIDENCE_MATCHES), 2),
            "trend": round(form - earlier, 1),
            "last_match": t.history[-1]["date"] if t.history else None,
            "history": history,
        }
    return {
        "method": __doc__.split("How a match is scored")[1].strip(),
        "settings": settings,
        "calibration": calibration,
        "players": players,
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--download", action="store_true", help="fetch the latest IPL CSVs into ./cache/ipl-csv first")
    ap.add_argument("--ipl-csv", type=Path, default=CACHE, help="folder with Match_Info.csv + Ball_By_Ball_Match_Data.csv")
    ap.add_argument("--cricsheet", action="store_true", help="use Cricsheet zips in ./cache (all competitions)")
    ap.add_argument("--backtest", action="store_true", help="print how well the index predicts the next match")
    ap.add_argument("--tune", action="store_true", help="search the settings and print the best")
    ap.add_argument("--out", type=Path, default=GENERATED / "player-index.json")
    args = ap.parse_args()
    if args.download:
        download(args.ipl_csv)
    matches = load(args)
    if args.tune:
        print(json.dumps(tune(matches), indent=1))
        return
    scored, cal, pars = score_matches(matches, SETTINGS)
    bt = backtest(scored, SETTINGS)
    if args.backtest:
        print(json.dumps(bt, indent=1))
    # Fresh run for the export (backtest annotated entries).
    tracks = run_index(scored, SETTINGS)
    squad = cr.load_squads()
    seasons = sorted({cr.season_of(m) for _, _, m in matches}, reverse=True)[:3]
    data = cr.collect(((w, ipl, m) for w, ipl, m in matches), seasons)
    names = cr.match_names(squad, data)
    calibration = {
        "seasons_from": FIRST_SEASON,
        "matches": len(scored),
        "latest_match": scored[-1][1]["info"]["dates"][0] if scored else None,
        "competitions": "all Cricsheet T20 competitions" if args.cricsheet else "IPL only",
        "impact_mean_sd": {k: [round(v[0], 2), round(v[1], 2)] for k, v in cal.items()},
        "next_match_prediction_2025_26": bt,
    }
    out = export(tracks, squad, names, SETTINGS, calibration)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=1) + "\n")
    print(
        f"Player Index for {len(out['players'])} of {len(squad)} squad players from {len(scored)} matches "
        f"({FIRST_SEASON} to {calibration['latest_match']}, {calibration['competitions']}). "
        f"Next-match prediction: batting {bt['bat']['spearman']}, bowling {bt['bowl']['spearman']}"
    )


if __name__ == "__main__":
    main()
