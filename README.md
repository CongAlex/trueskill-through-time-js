# TrueSkill Through Time for JavaScript and Google Apps Script

A dependency-free JavaScript port of [TrueSkill Through Time](https://github.com/glandfried/TrueSkillThroughTime.py) (TTT), the skill-rating model by Gustavo Landfried and Esteban Mocskos.

Unlike TrueSkill, Glicko or Elo, which update ratings one game at a time, TTT models the **whole history of games as one Bayesian network**. Information flows both forward and backward in time, so:

- a player's early estimates are corrected by what their later games reveal,
- ratings from different times are comparable, and
- new players get reasonable estimates quickly.

This port is a single file with no dependencies. It runs unchanged in **Google Apps Script**, Node.js and browsers.

## Verified against the Python package

`test/compare.js` runs the same inputs through this port and through the official Python package (`trueskillthroughtime` 2.0.0) and compares every estimate. All 23 cases agree to within a relative difference of about 1e-14 (floating-point round-off). They cover:

- 1v1, team and free-for-all games (including 4 players), shuffled results, ties and draws, player weights, and the Continuous observation model
- histories with and without drift over time, repeated times, custom priors, online mode, and incremental updates with `addHistory`
- the numerical functions (`erfc`, `erfcinv`, draw margins)

## What's included

| Python | JavaScript | Ported |
| --- | --- | --- |
| `Gaussian`, `Player` | `TTT.Gaussian`, `TTT.Player` | Yes. Operators become methods: `add`, `sub`, `mul`, `div`. |
| `Game` | `TTT.Game` | Ordinal (win/loss/draw) and Continuous observation models. |
| `History` | `TTT.History` | Batch and online modes, `convergence`, `learningCurves`, `logEvidence`, `geometricMean`, `addHistory`. |
| Discrete (Poisson score) model | — | Not ported. |

## Use it in Google Apps Script

### Option 1: paste into your project

Add a script file and paste in [`appsscript/TTT.gs`](appsscript/TTT.gs). This creates a global called `TTT`.

Apps Script runs files from top to bottom, so put `TTT.gs` above any file that uses `TTT` at the top level.

### Option 2: set it up as a library

Use this if several projects need it.

1. Create a new Apps Script project. Add [`appsscript/TTT.gs`](appsscript/TTT.gs), then add [`appsscript/exports.gs`](appsscript/exports.gs) **after** it.
2. Click **Deploy → New deployment → Library**.
3. Copy the **Script ID** from **Project Settings**. Use the Script ID, not the deployment ID that starts with `AKfycb`.
4. In your main project, click **Libraries → +**, paste the Script ID, and set an identifier such as `TTT`.

The library exposes `rateGames`, `conservative`, `newHistory`, `newGame`, `gaussian` and `player`.

### Rating free-for-all games (for example, 4-player mahjong)

```js
const games = [
  // players in finishing order; time in days
  { players: ['ann', 'bo', 'cy', 'di'], time: 20000 },
  { players: ['bo', 'ann', 'di', 'cy'], time: 20001 },
  // ranks: 0 = first; equal ranks are ties (ties need pDraw > 0)
  { players: ['di', 'ann', 'bo', 'cy'], ranks: [0, 1, 1, 3], time: 20005 },
];

const result = TTT.rateGames(games, { pDraw: 0.01, gamma: 0.03 });   // the library function
result.ratings.ann            // { mu, sigma, games }
result.curves.ann             // [{ time, mu, sigma }, ...]
TTT.conservative(result.ratings.ann)   // mu - 3*sigma, for leaderboards
```

If you pasted `TTT.gs` directly instead of using the library, copy `rateGames` and `conservative` from `exports.gs` into your project, or use the raw API below.

Example with an Airtable game log, where each game has four placings and a timestamp:

```js
const PLACES = ['First place', 'Second place', 'Third place', 'Fourth place'];

const games = GAMES.map(game => ({
  players: PLACES.map(place => game[place + ' name'][0]),
  time: new Date(game.Timestamp).getTime() / 86400000,   // days
}));

const { ratings } = TTT.rateGames(games, { gamma: 0.03 });
```

Recomputing from the full history on every run is the intended way to use TTT. In Node, 150 four-player games take about 0.15 seconds; Apps Script is slower but still far inside its 6-minute limit for histories of this size.

## Raw API

The API mirrors the Python package, with camelCase names and an options object.

```js
const h = new TTT.History(
  [[['a'], ['b']], [['b'], ['c']], [['c'], ['a']]],   // games → teams → player names
  {
    results: [[1, 0], [1, 0], [1, 0]],   // per game, one score per team; HIGHER is better
    times: [0, 5, 9],                    // optional; default 0, 1, 2, ...
    mu: 0, sigma: 3, beta: 1, gamma: 0.15, pDraw: 0,   // these are the defaults
    // priors: { a: new TTT.Player(new TTT.Gaussian(2, 0.5), 1, 0.01) },
    // online: true,
  });

h.convergence();             // (iterations = 8, epsilon = 1e-5, verbose = false)
h.learningCurves();          // { a: [[time, Gaussian], ...], ... }
h.currentSkills();           // { a: Gaussian, ... }  latest estimate per player
h.logEvidence();             // log probability of all observed results
```

Notes:

- **Results:** a higher score is better, and equal scores are ties. If you omit `results`, teams are assumed to be listed from winner to loser. The Python docstring says "lower is better", but the Python code and README use higher-is-better, and so does this port.
- **Ties** require `pDraw > 0`. Otherwise the model gives the observed tie zero probability, so the port throws a clear error.
- **A single game:** `new TTT.Game(teams, result, pDraw, weights, obs)`, where `teams` are arrays of `TTT.Player`. Then call `game.posteriors()` and read `game.evidence`.

### Choosing parameters

| Parameter | Meaning | Default |
| --- | --- | --- |
| `mu`, `sigma` | Prior skill of a new player | `0`, `3` |
| `beta` | Game-to-game performance noise | `1` |
| `gamma` | How much skill can drift per unit of time | `0.15` |
| `pDraw` | Probability of a tie between adjacent finishers | `0` |

Skill is on an arbitrary scale, so only the ratios between parameters matter.

`gamma` is per unit of `times`. If you measure time in days, `0.15` allows a lot of change, so try values around `0.01`–`0.05`.

To choose parameters, compare `logEvidence()` across settings. The one that's closest to zero explains your results best.

## Differences from the Python package

- **`addHistory`.** In Python 2.0.0, `add_history` always starts a new time step, even when a game's time matches an existing one. That's because it checks the time against the wrong list (`batches` instead of `btimes`). In this port, a game at the latest existing time joins that time step, a later time starts a new step, and an earlier time throws an error. Default times continue from the latest time (+1, +2, …). When every added game has a new, later time, the result matches Python exactly.
- **`convergence` output:** it doesn't print unless you pass `verbose = true`. It then logs with `Logger.log` in Apps Script and `console.log` elsewhere.
- **Round-off guard:** a tiny negative variance caused by round-off is clamped to 0 instead of producing `NaN`.

## Running the tests

```bash
npm test          # rebuilds appsscript/TTT.gs, compares with Python, checks the Apps Script library
npm run fixtures  # regenerates test/fixtures.json (needs: pip install trueskillthroughtime numpy scipy)
```

`src/ttt.js` is the source. `appsscript/TTT.gs` is generated from it by `npm run build`.

## Credits and license

The model and the original implementation are by Gustavo Landfried. Please cite the paper if you use this in research:

> Landfried, G., & Mocskos, E. (2025). *TrueSkill Through Time: Reliable Initial Skill Estimates and Historical Comparability with Julia, Python, and R.* Journal of Statistical Software, 112, 1–41.

This port is released under the same [Clear BSD License](LICENSE) as the original.

As the original project notes, the TrueSkill™ brand is Microsoft's and is not covered by the BSD license. Microsoft permits only Xbox Live games or non-commercial projects to use the TrueSkill name.
