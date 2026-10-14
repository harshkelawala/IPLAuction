#!/usr/bin/env python3
"""
Player Index: a 0-100 rating for every squad player that moves after every IPL match.

    python3 player_index.py --download        # fetch the latest IPL ball-by-ball data, then build
    python3 player_index.py --ipl-csv FOLDER  # build from Match_Info.csv + Ball_By_Ball_Match_Data.csv

Writes packages/data/generated/player-index.json, which `npm run seed` turns into game ratings.

How a match is scored
---------------------
Each match is judged against that match's own conditions, so 40 off 25 on a slow pitch
counts for more than 40 off 25 in a 230-run game.

  batting impact = runs - balls faced x (runs per ball by all batters in the match)
  bowling impact = (runs per legal ball conceded by all bowlers) x balls bowled - runs conceded
                   + 20 runs per wicket

An impact becomes a match score on a 0-100 scale: 50 is an average performance and one
standard deviation of impact (measured over all IPL matches used) is 15 points.

How the index moves
-------------------
Each player keeps a batting index and a bowling index, both starting at 45 for a newcomer.
After every match they move 15% of the way toward that match's score, scaled by how much
the player did (a 3-ball cameo barely counts; 15+ balls faced or 18+ balls bowled count
fully). Between seasons every index drifts 15% back toward 50, so last year fades.

Each player has two of these:
  Form   moves 15% per match and drifts back 15% between seasons: roughly the last 6-7 matches.
  Class  moves 4% per match and never drifts: the whole 2022-on IPL career, recent matches
         still counting a little more.
The Index the game uses is 55% Form + 45% Class, so the current season matters most but
one bad season doesn't erase a proven player (or one good season make a star).

Batters and keepers are judged on batting, bowlers on bowling, all-rounders on 55% of
the better skill and 45% of the other.
Confidence (0-1) says how much IPL cricket the index rests on: about 12 full matches = 1.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import urllib.request
from collections import defaultdict
from dataclasses import dataclass, field
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
ALPHA = 0.15
ALPHA_CLASS = 0.04
FORM_WEIGHT = 0.55
SEASON_REGRESSION = 0.15
WICKET_RUNS = 20.0
SCORE_SD = 15.0
FULL_BAT_BALLS = 15
FULL_BOWL_BALLS = 18
FULL_CONFIDENCE_MATCHES = 12.0
HISTORY = 15

NOT_BOWLER_WICKETS = cr.NOT_BOWLER_WICKETS


@dataclass
class Line:
    runs: int = 0
    balls: int = 0
    bowl_balls: int = 0
    conceded: int = 0
    wickets: int = 0


@dataclass
class Track:
    bat: float = NEWCOMER
    bowl: float = NEWCOMER
    bat_n: float = 0.0
    bowl_n: float = 0.0
    bat_class: float = NEWCOMER
    bowl_class: float = NEWCOMER
    last_season: int | None = None
    # (date, team, opponent, bat score or None, bowl score or None, bat index, bowl index)
    history: list = field(default_factory=list)


def download(folder: Path) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    for name in FILES:
        url = f"{MIRROR}/{name}"
        print(f"downloading {url}")
        with urllib.request.urlopen(url) as resp:  # noqa: S310 (fixed https host)
            (folder / name).write_bytes(resp.read())


def match_lines(m: dict) -> tuple[dict[str, Line], float, float]:
    """Each player's line in one match, and the match's par rates (batting, bowling)."""
    lines: dict[str, Line] = defaultdict(Line)
    bat_runs = bat_balls = conceded = legal = 0
    for inn in m["innings"]:
        if inn.get("super_over"):
            continue
        for over in inn["overs"]:
            for d in over["deliveries"]:
                ex = d.get("extras", {})
                wide, nb = "wides" in ex, "noballs" in ex
                runs = d["runs"]["batter"]
                b, w = lines[d["batter"]], lines[d["bowler"]]
                b.runs += runs
                if not wide:
                    b.balls += 1
                    bat_balls += 1
                bat_runs += runs
                c = runs + ex.get("wides", 0) + ex.get("noballs", 0)
                w.conceded += c
                conceded += c
                if not wide and not nb:
                    w.bowl_balls += 1
                    legal += 1
                for wk in d.get("wickets", []):
                    if wk["kind"] not in NOT_BOWLER_WICKETS:
                        w.wickets += 1
    par_bat = bat_runs / bat_balls if bat_balls else 1.3
    par_bowl = conceded / legal if legal else 1.4
    return lines, par_bat, par_bowl


def impacts(line: Line, par_bat: float, par_bowl: float) -> tuple[float | None, float | None]:
    bat = line.runs - par_bat * line.balls if line.balls > 0 else None
    bowl = par_bowl * line.bowl_balls - line.conceded + WICKET_RUNS * line.wickets if line.bowl_balls > 0 else None
    return bat, bowl


def build(matches: list[dict]) -> tuple[dict[str, Track], dict]:
    matches = sorted(
        (m for m in matches if cr.season_of(m) >= FIRST_SEASON),
        key=lambda m: m["info"]["dates"][0],
    )
    # Calibrate: spread of impacts for meaningful innings / spells.
    bat_imp, bowl_imp, per_match = [], [], []
    for m in matches:
        lines, pb, pw = match_lines(m)
        per_match.append((m, lines, pb, pw))
        for line in lines.values():
            bi, wi = impacts(line, pb, pw)
            if bi is not None and line.balls >= 10:
                bat_imp.append(bi)
            if wi is not None and line.bowl_balls >= 12:
                bowl_imp.append(wi)
    bat_mean, bat_sd = statistics.fmean(bat_imp), statistics.pstdev(bat_imp)
    bowl_mean, bowl_sd = statistics.fmean(bowl_imp), statistics.pstdev(bowl_imp)

    def to_score(impact: float, mean: float, sd: float) -> float:
        return max(0.0, min(100.0, AVERAGE + (impact - mean) / sd * SCORE_SD))

    tracks: dict[str, Track] = defaultdict(Track)
    for m, lines, pb, pw in per_match:
        season = cr.season_of(m)
        date = m["info"]["dates"][0]
        team_of = {p: t for t, ps in m["info"]["players"].items() for p in ps}
        teams = list(m["info"]["players"])
        for name in team_of:
            t = tracks[name]
            if t.last_season is not None and season != t.last_season:
                t.bat = AVERAGE + (t.bat - AVERAGE) * (1 - SEASON_REGRESSION)
                t.bowl = AVERAGE + (t.bowl - AVERAGE) * (1 - SEASON_REGRESSION)
            t.last_season = season
            line = lines.get(name, Line())
            bi, wi = impacts(line, pb, pw)
            bat_score = to_score(bi, bat_mean, bat_sd) if bi is not None else None
            bowl_score = to_score(wi, bowl_mean, bowl_sd) if wi is not None else None
            if bat_score is not None:
                w = min(1.0, line.balls / FULL_BAT_BALLS)
                t.bat += ALPHA * w * (bat_score - t.bat)
                t.bat_class += ALPHA_CLASS * w * (bat_score - t.bat_class)
                t.bat_n += w
            if bowl_score is not None:
                w = min(1.0, line.bowl_balls / FULL_BOWL_BALLS)
                t.bowl += ALPHA * w * (bowl_score - t.bowl)
                t.bowl_class += ALPHA_CLASS * w * (bowl_score - t.bowl_class)
                t.bowl_n += w
            if bat_score is None and bowl_score is None:
                continue  # in the XI but didn't bat or bowl: nothing to learn
            team = team_of[name]
            opponent = next((x for x in teams if x != team), "")
            t.history.append((date, team, opponent, bat_score, bowl_score, t.bat, t.bowl, t.bat_class, t.bowl_class))
    calibration = {
        "seasons_from": FIRST_SEASON,
        "matches": len(per_match),
        "batting_impact_mean": round(bat_mean, 2),
        "batting_impact_sd": round(bat_sd, 2),
        "bowling_impact_mean": round(bowl_mean, 2),
        "bowling_impact_sd": round(bowl_sd, 2),
        "latest_match": per_match[-1][0]["info"]["dates"][0] if per_match else None,
    }
    return tracks, calibration


def role_index(role: str, bat: float, bowl: float, bat_n: float, bowl_n: float) -> float:
    if role in ("BAT", "WK"):
        return bat
    if role == "BOWL":
        return bowl
    # All-rounder: lean on the stronger skill, but only trust a skill with some data behind it.
    b = bat if bat_n >= 2 else min(bat, NEWCOMER)
    w = bowl if bowl_n >= 2 else min(bowl, NEWCOMER)
    return 0.55 * max(b, w) + 0.45 * min(b, w)


def export(tracks: dict[str, Track], squad: list[dict], names: dict[str, str], calibration: dict) -> dict:
    players = {}
    for r in squad:
        cs = names.get(r["id"])
        if not cs or cs not in tracks:
            continue
        t = tracks[cs]
        role = r["role"]
        n = {"BAT": t.bat_n, "WK": t.bat_n, "BOWL": t.bowl_n}.get(role, max(t.bat_n, t.bowl_n))
        form = role_index(role, t.bat, t.bowl, t.bat_n, t.bowl_n)
        klass = role_index(role, t.bat_class, t.bowl_class, t.bat_n, t.bowl_n)
        index = FORM_WEIGHT * form + (1 - FORM_WEIGHT) * klass
        history = []
        for date, team, opp, bs, ws, bi, wi, bc, wc in t.history[-HISTORY:]:
            score = (
                bs if role in ("BAT", "WK") else ws if role == "BOWL"
                else max(x for x in (bs, ws) if x is not None)
            )
            history.append({
                "date": date,
                "against": opp,
                "score": None if score is None else round(score, 1),
                "form": round(role_index(role, bi, wi, t.bat_n, t.bowl_n), 1),
                "index": round(
                    FORM_WEIGHT * role_index(role, bi, wi, t.bat_n, t.bowl_n)
                    + (1 - FORM_WEIGHT) * role_index(role, bc, wc, t.bat_n, t.bowl_n),
                    1,
                ),
            })
        five_ago = history[-6]["form"] if len(history) >= 6 else (history[0]["form"] if history else form)
        players[r["id"]] = {
            "cricsheet_name": cs,
            "index": round(index, 1),
            "form": round(form, 1),
            "class": round(klass, 1),
            "batting": round(t.bat, 1),
            "bowling": round(t.bowl, 1),
            "matches": len(t.history),
            "confidence": round(min(1.0, n / FULL_CONFIDENCE_MATCHES), 2),
            "trend": round(form - five_ago, 1),
            "last_match": t.history[-1][0] if t.history else None,
            "history": history,
        }
    return {"method": __doc__.split("How a match is scored")[1].strip(), "calibration": calibration, "players": players}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--download", action="store_true", help="fetch the latest IPL CSVs into ./cache/ipl-csv first")
    ap.add_argument("--ipl-csv", type=Path, default=CACHE, help="folder with Match_Info.csv + Ball_By_Ball_Match_Data.csv")
    ap.add_argument("--out", type=Path, default=GENERATED / "player-index.json")
    args = ap.parse_args()
    if args.download:
        download(args.ipl_csv)
    matches = list(m for _, _, m in cr.iter_ipl_csv(args.ipl_csv))
    tracks, calibration = build(matches)
    squad = cr.load_squads()
    data = cr.collect(((1.0, True, m) for m in matches), sorted({cr.season_of(m) for m in matches}, reverse=True)[:3])
    names = cr.match_names(squad, data)
    out = export(tracks, squad, names, calibration)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out, indent=1) + "\n")
    print(
        f"Player Index for {len(out['players'])} of {len(squad)} squad players "
        f"from {calibration['matches']} IPL matches ({calibration['seasons_from']} to {calibration['latest_match']})"
    )


if __name__ == "__main__":
    main()
