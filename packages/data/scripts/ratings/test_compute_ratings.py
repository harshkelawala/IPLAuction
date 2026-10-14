"""Synthetic-data tests for compute_ratings.py. Run: python3 -m unittest test_compute_ratings.py"""
import unittest

import compute_ratings as cr

SEASON = 2026


def delivery(batter, bowler, runs=0, wicket=None, wide=False):
    d = {"batter": batter, "bowler": bowler, "runs": {"batter": runs, "extras": 1 if wide else 0, "total": runs}}
    if wide:
        d["extras"] = {"wides": 1}
    if wicket:
        d["wickets"] = [{"player_out": batter, "kind": wicket}]
    return d


def match(balls_by_over, players):
    """balls_by_over: list of lists of deliveries; over index = list index."""
    return {
        "info": {"match_type": "T20", "season": str(SEASON), "dates": [f"{SEASON}-04-01"],
                 "players": {"A": players, "B": []}},
        "innings": [{"overs": [{"over": i, "deliveries": ds} for i, ds in enumerate(balls_by_over)]}],
    }


def build_dataset():
    """Two batters (fast vs slow scorer) and two bowlers (cheap vs expensive), 10 matches each."""
    names = ["V Kohli", "RG Sharma", "JJ Bumrah", "Mohammed Siraj"]
    matches = []
    for _ in range(10):
        overs = []
        for o in range(20):
            bowler = "JJ Bumrah" if o % 2 == 0 else "Mohammed Siraj"
            batter = "V Kohli" if o < 10 else "RG Sharma"
            runs = 2 if batter == "V Kohli" else 1  # Kohli faster in this fake world
            if bowler == "Mohammed Siraj":
                runs += 1  # Siraj more expensive
            overs.append([delivery(batter, bowler, runs) for _ in range(6)])
        overs[19][5] = delivery("RG Sharma", "JJ Bumrah", 0, wicket="bowled")
        matches.append((1.0, True, match(overs, names)))
    return cr.collect(matches, [SEASON, SEASON - 1, SEASON - 2])


class RatingTests(unittest.TestCase):
    def setUp(self):
        self.data = build_dataset()
        self.squad = [
            {"id": "virat-kohli", "name": "Virat Kohli", "role": "BAT", "team": "RCB"},
            {"id": "rohit-sharma", "name": "Rohit Sharma", "role": "BAT", "team": "MI"},
            {"id": "jasprit-bumrah", "name": "Jasprit Bumrah", "role": "BOWL", "team": "MI"},
            {"id": "mohammed-siraj", "name": "Mohammed Siraj", "role": "BOWL", "team": "GT"},
            {"id": "nobody-here", "name": "Nobody Here", "role": "BAT", "team": "CSK"},
        ]

    def test_counts_runs_balls_and_wickets(self):
        k = self.data["V Kohli"].by_season[SEASON]
        self.assertEqual(k.balls, 10 * 60)
        b = self.data["JJ Bumrah"].by_season[SEASON]
        self.assertEqual(b.wickets, 10)
        self.assertEqual(self.data["V Kohli"].ipl_matches, 10)

    def test_matches_full_names_to_cricsheet_names(self):
        names = cr.match_names(self.squad, self.data)
        self.assertEqual(names["virat-kohli"], "V Kohli")
        self.assertEqual(names["rohit-sharma"], "RG Sharma")
        self.assertEqual(names["mohammed-siraj"], "Mohammed Siraj")
        self.assertNotIn("nobody-here", names)

    def test_better_players_rate_higher(self):
        rows = {r["id"]: r["rating"] for r in cr.compute(self.squad, self.data, [SEASON, SEASON - 1, SEASON - 2])}
        self.assertGreater(rows["virat-kohli"], rows["rohit-sharma"])
        self.assertGreater(rows["jasprit-bumrah"], rows["mohammed-siraj"])
        for r in rows.values():
            self.assertTrue(0 <= r <= 100)

    def test_one_cricsheet_name_per_player_and_surname_alone_is_not_enough(self):
        data = {n: cr.PlayerData() for n in ["SN Khan", "M Shahrukh Khan", "Kuldeep Yadav"]}
        for n in data:
            data[n].by_season[SEASON].matches = 10
        data["SN Khan"].teams[SEASON].add("Chennai Super Kings")
        squad = [
            {"id": "sarfaraz-khan", "name": "Sarfaraz Khan", "role": "BAT", "team": "CSK"},
            {"id": "aman-hakim-khan", "name": "Aman Hakim Khan", "role": "AR", "team": "CSK"},
            {"id": "shahrukh-khan", "name": "Shahrukh Khan", "role": "BAT", "team": "GT"},
            {"id": "kuldeep-yadav", "name": "Kuldeep Yadav", "role": "BOWL", "team": "DC"},
            {"id": "kuldip-yadav", "name": "Kuldip Yadav", "role": "BOWL", "team": "CSK"},
        ]
        names = cr.match_names(squad, data)
        self.assertEqual(names["sarfaraz-khan"], "SN Khan")
        self.assertEqual(names["shahrukh-khan"], "M Shahrukh Khan")
        self.assertNotIn("aman-hakim-khan", names)
        self.assertEqual(names["kuldeep-yadav"], "Kuldeep Yadav")
        self.assertNotIn("kuldip-yadav", names)

    def test_shrinkage_pulls_small_samples_to_prior(self):
        self.assertAlmostEqual(cr.shrink(250, 20, 140, 100), (20 * 250 + 100 * 140) / 120)
        self.assertAlmostEqual(cr.shrink(150, 10_000, 140, 100), 150, delta=0.2)

    def test_slug_matches_typescript(self):
        self.assertEqual(cr.slugify("T. Natarajan"), "t-natarajan")
        self.assertEqual(cr.slugify("Lhuan-dre Pretorius"), "lhuan-dre-pretorius")

    def test_age_factor(self):
        self.assertEqual(cr.age_factor(27), 100)
        self.assertEqual(cr.age_factor(None), cr.NEUTRAL_AGE_FACTOR)
        self.assertLess(cr.age_factor(36), cr.age_factor(32))


if __name__ == "__main__":
    unittest.main()
