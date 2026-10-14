"""Tests for player_score.py. Run: python3 -m unittest test_player_score.py"""
import random
import unittest

import player_score as ps

S = dict(ps.SETTINGS)


class CompetitionStrengthTests(unittest.TestCase):
    def test_recovers_how_much_easier_a_competition_is(self):
        rng = random.Random(1)
        rows = []
        for i in range(120):
            level = rng.gauss(50, 6)
            for _ in range(12):
                rows.append((f"p{i}", "ipl", level + rng.gauss(0, 10)))
            for _ in range(12):
                rows.append((f"p{i}", "sma", level + 6 + rng.gauss(0, 10)))  # 6 points easier
        effect = ps.competition_strength(rows)
        self.assertEqual(effect["ipl"], 0.0)
        self.assertAlmostEqual(effect["sma"], 6, delta=1.0)


class SkillTests(unittest.TestCase):
    def test_few_matches_stay_near_the_newcomer_level(self):
        k = ps.Skill()
        for _ in range(2):
            k.update(90, 1.0, S, 2026, False)
        self.assertLess(k.value(S, 2026), 60)
        self.assertGreater(k.value(S, 2026), ps.NEWCOMER)

    def test_a_proven_player_keeps_his_importance_through_a_bad_season(self):
        star, steady = ps.Skill(), ps.Skill()
        for year, x in ((2024, 70), (2025, 70)):
            for _ in range(14):
                star.update(x, 1.0, S, year, False)
                steady.update(55, 1.0, S, year, False)
        for _ in range(14):
            star.update(40, 1.0, S, 2026, False)
            steady.update(55, 1.0, S, 2026, False)
        self.assertGreater(star.importance(2026), steady.importance(2026))
        self.assertLess(star.form, steady.form)

    def test_short_seasons_do_not_count_as_a_peak(self):
        k = ps.Skill()
        for _ in range(3):
            k.update(95, 1.0, S, 2026, False)
        self.assertEqual(k.peak(2026), k.klass)

    def test_clutch_rewards_doing_better_in_close_matches(self):
        k = ps.Skill()
        for _ in range(10):
            k.update(50, 1.0, S, 2026, False)
        for _ in range(6):
            k.update(70, 1.0, S, 2026, True)
        self.assertGreater(k.clutch(), 0)


def ball(batter, bowler, runs=0, extras=None, wicket=None):
    d = {"batter": batter, "bowler": bowler, "non_striker": "N", "runs": {"batter": runs, "extras": 0, "total": runs}}
    if extras:
        d["extras"] = extras
        d["runs"]["extras"] = d["runs"]["total"] = sum(extras.values())
    if wicket:
        d["wickets"] = [wicket]
    return d


class MatchTests(unittest.TestCase):
    PAR = {"phase": {"powerplay": 1.0, "middle": 1.0, "death": 1.0},
           "bat_phase": {"powerplay": 1.0, "middle": 1.0, "death": 1.0},
           "overall": 1.0, "runs_per_wicket": 20.0, "balls": 9999}

    def test_wides_do_not_count_against_the_batter_and_catches_credit_the_fielder(self):
        m = {"info": {"dates": ["2026-04-01"], "players": {"A": ["B1", "N"], "B": ["W", "F"]}},
             "innings": [{"overs": [{"over": 0, "deliveries": [
                 ball("B1", "W", 1),
                 ball("B1", "W", 0, extras={"wides": 1}),
                 ball("B1", "W", 0, wicket={"player_out": "B1", "kind": "caught", "fielders": [{"name": "F"}]}),
             ]}]}]}
        lines = ps.match_lines(m, self.PAR, 1.0, 0.3)
        self.assertEqual(lines["B1"].balls, 2)
        self.assertAlmostEqual(lines["F"].field, 0.3 * 20 * 1.3)  # opener out: x1.3
        self.assertGreater(lines["W"].bowl, 20)

    def test_the_same_match_from_two_sources_is_counted_once(self):
        m = {"info": {"dates": ["2026-04-01"]}, "innings": [{"overs": [{"over": 0, "deliveries": [ball("X", "Y")]}]}]}
        self.assertEqual(ps.match_key(m), ("2026-04-01", "X", "Y"))


class TagTests(unittest.TestCase):
    def test_bowlers_are_not_tagged_as_batters(self):
        t = ps.Track()
        for i in range(10):
            t.usage.append((f"2026-04-{i + 1:02d}", 1, 20, 0, {"death": 18}))
        self.assertEqual(ps.tags(t, "2026-05-01", "BOWL"), ["death"])
        self.assertEqual(ps.tags(t, "2026-05-01", "BAT"), ["opener"])


if __name__ == "__main__":
    unittest.main()
