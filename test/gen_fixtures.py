"""
Generates reference results from the official Python package so the JavaScript
port can be checked against it.

    pip install trueskillthroughtime numpy scipy
    python3 test/gen_fixtures.py > test/fixtures.json
"""
import json
import math
import random
import sys

import trueskillthroughtime as ttt


def g2d(g):
    return [g.mu, g.sigma]


def game_case(name, teams, result=None, p_draw=0.0, weights=None, obs="Ordinal"):
    players = [[ttt.Player(ttt.Gaussian(p[0], p[1]), p[2], p[3]) for p in team] for team in teams]
    g = ttt.Game(players, result or [], p_draw, weights or [], obs)
    return {
        "name": name, "kind": "game",
        "input": {"teams": teams, "result": result, "pDraw": p_draw, "weights": weights, "obs": obs},
        "output": {
            "evidence": g.evidence,
            "likelihoods": [[g2d(l) for l in t] for t in g.likelihoods],
            "posteriors": [[g2d(p) for p in t] for t in g.posteriors()],
        },
    }


def history_out(h):
    lc = h.learning_curves()
    online_lc = h.learning_curves(online=True) if h.online else None
    return {
        "logEvidence": h.log_evidence(),
        "curves": {str(k): [[t, g2d(s)] for t, s in v] for k, v in lc.items()},
        "onlineCurves": None if online_lc is None else {str(k): [[t, g2d(s)] for t, s in v] for k, v in online_lc.items()},
    }


def history_case(name, composition, results=None, times=None, priors=None, params=None,
                 online=False, weights=None, iterations=8, epsilon=1e-5):
    params = params or {}
    py_priors = None
    if priors:
        py_priors = {k: ttt.Player(ttt.Gaussian(v[0], v[1]), v[2], v[3]) for k, v in priors.items()}
    h = ttt.History(composition, results or [], times or [], py_priors,
                    mu=params.get("mu", 0), sigma=params.get("sigma", 3), beta=params.get("beta", 1),
                    gamma=params.get("gamma", 0.15), p_draw=params.get("pDraw", 0.0),
                    online=online, weights=weights or [])
    step, its = h.convergence(iterations=iterations, epsilon=epsilon, verbose=False)
    return {
        "name": name, "kind": "history",
        "input": {"composition": composition, "results": results, "times": times, "priors": priors,
                  "params": params, "online": online, "weights": weights,
                  "iterations": iterations, "epsilon": epsilon},
        "output": dict(history_out(h), iterationsRun=its),
    }


def mahjong_history(rng, n_players, n_games, p_tie=0.0, same_day=0.3):
    names = ["p%d" % i for i in range(n_players)]
    true_skill = {n: rng.gauss(0, 1.5) for n in names}
    comp, res, times = [], [], []
    day = 0
    for _ in range(n_games):
        if rng.random() > same_day:
            day += rng.choice([1, 1, 2, 3, 7, 14])
        table = rng.sample(names, 4)
        perf = [true_skill[n] + rng.gauss(0, 1) for n in table]
        order = sorted(range(4), key=lambda i: -perf[i])
        place = [0] * 4
        for rank, i in enumerate(order):
            place[i] = rank
        if p_tie and rng.random() < p_tie:
            # make two adjacent finishers tie
            i = order[1]; j = order[2]
            place[j] = place[i]
        comp.append([[n] for n in table])
        res.append([-p for p in place])      # higher is better
        times.append(day)
    return comp, res, times


def main():
    cases = []

    # --- numerics ---
    xs = [-8, -5, -3, -2.5, -1.6, -1.5, -1.49, -1, -0.5, -1e-3, 0, 1e-3, 0.3, 1, 1.49, 1.5, 1.6, 2, 3, 5, 8, 12, 26.5]
    ys = [1e-12, 1e-8, 1e-4, 0.01, 0.05, 0.2, 0.5, 0.75, 0.9, 0.99, 1.0, 1.1, 1.5, 1.9, 1.99, 1.9999]
    cases.append({"name": "erfc", "kind": "erfc", "input": xs, "output": [math.erfc(x) for x in xs]})
    cases.append({"name": "erfcinv", "kind": "erfcinv", "input": ys, "output": [float(ttt.erfcinv(y)) for y in ys]})
    pd = [0.01, 0.1, 0.25, 0.5, 0.9]
    cases.append({"name": "computeMargin", "kind": "margin", "input": [[p, s] for p in pd for s in [1, math.sqrt(2), 3]],
                  "output": [ttt.compute_margin(p, s) for p in pd for s in [1, math.sqrt(2), 3]]})

    # --- single games (player = [mu, sigma, beta, gamma]) ---
    d = [0.0, 6.0, 1.0, 0.03]
    cases.append(game_case("1v1 default", [[d], [d]]))
    cases.append(game_case("2v2 README", [[d, d], [d, d]]))
    cases.append(game_case("3 teams tie README", [[d], [d, d], [d]], [1, 0, 0], 0.25))
    cases.append(game_case("4p FFA", [[[25, 8.3, 4.2, 0.08]], [[22, 3, 4.2, 0.08]], [[30, 5, 4.2, 0.08]], [[18, 7, 4.2, 0.08]]], [0, -1, -2, -3]))
    cases.append(game_case("4p FFA shuffled result", [[d], [[1, 2, 1, 0]], [[-1, 3, 1, 0]], [[0.5, 1, 1, 0]]], [-2, 0, -3, -1]))
    cases.append(game_case("4p FFA tie", [[d], [d], [d], [d]], [0, -1, -1, -3], 0.1))
    cases.append(game_case("1v1 draw", [[[1, 2, 1, 0]], [[0, 3, 1, 0]]], [0, 0], 0.3))
    cases.append(game_case("weights", [[d, [2, 1, 1, 0]], [[1, 2, 1, 0]]], [1, 0], 0.0, [[0.7, 0.4], [1.0]]))
    cases.append(game_case("3 teams weights", [[d, [2, 1, 1, 0]], [[1, 2, 1, 0]], [[0, 1, 0.5, 0]]], [2, 0, 1], 0.0, [[0.7, 0.4], [1.0], [0.5]]))
    cases.append(game_case("continuous 1v1", [[d], [[1, 2, 1, 0]]], [3.5, 1.0], 0.0, None, "Continuous"))
    cases.append(game_case("continuous 3 teams", [[d], [[1, 2, 1, 0]], [[0, 1, 1, 0]]], [3.5, 1.0, 2.0], 0.0, None, "Continuous"))

    # --- histories ---
    comp = [[["a"], ["b"]], [["b"], ["c"]], [["c"], ["a"]]]
    cases.append(history_case("README 3 games", comp, [[1, 0], [1, 0], [1, 0]], params={"gamma": 0.0}))
    cases.append(history_case("README 3 games drift", comp, [[1, 0], [1, 0], [1, 0]], [0, 5, 9], params={"gamma": 0.15}))
    cases.append(history_case("default results and times", [[["a"], ["b"], ["c"]], [["c"], ["a"]], [["b"], ["a"], ["c"]]]))
    cases.append(history_case("teams", [[["a", "b"], ["c", "d"]], [["a", "c"], ["b", "d"]], [["a", "d"], ["b", "c"]]],
                              [[1, 0], [0, 1], [1, 0]], [1, 1, 2], params={"pDraw": 0.0}))

    rng = random.Random(7)
    comp, res, times = mahjong_history(rng, 12, 150)
    cases.append(history_case("mahjong 150 games", comp, res, times, params={"mu": 25, "sigma": 8, "beta": 4, "gamma": 0.1}))

    comp, res, times = mahjong_history(rng, 10, 120, p_tie=0.15)
    cases.append(history_case("mahjong ties", comp, res, times, params={"pDraw": 0.05, "gamma": 0.05}))

    comp, res, times = mahjong_history(rng, 8, 60)
    cases.append(history_case("mahjong online", comp, res, times, online=True, params={"gamma": 0.1}))

    comp, res, times = mahjong_history(rng, 8, 60)
    cases.append(history_case("mahjong priors", comp, res, times,
                              priors={"p0": [2, 0.5, 1, 0.01], "p3": [-1, 1, 1.5, 0.2]}, params={"gamma": 0.1}))

    # Incremental: build from the first 40 games, converge, add 20 more at later times, converge again.
    comp, res, times = mahjong_history(rng, 8, 60)
    h = ttt.History(comp[:40], res[:40], times[:40], None, gamma=0.1)
    h.convergence(verbose=False)
    t_last = times[39]
    # Python's add_history always starts a new time step per game, so give each
    # new game its own later time; both implementations then build the same steps.
    later = [t_last + 1 + i for i in range(20)]
    h.add_history(comp[40:], res[40:], later)
    h.convergence(verbose=False)
    cases.append({
        "name": "addHistory", "kind": "addHistory",
        "input": {"first": {"composition": comp[:40], "results": res[:40], "times": times[:40]},
                  "second": {"composition": comp[40:], "results": res[40:], "times": later},
                  "params": {"gamma": 0.1}},
        "output": history_out(h),
    })

    json.dump({"version": "trueskillthroughtime 2.0.0", "cases": cases}, sys.stdout)


if __name__ == "__main__":
    main()
