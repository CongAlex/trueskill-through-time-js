# TrueSkill Through Time for JavaScript and Google Apps Script

A dependency-free JavaScript port of [TrueSkill Through Time](https://github.com/glandfried/TrueSkillThroughTime.py) (TTT), the skill-rating model by Gustavo Landfried and Esteban Mocskos.

Unlike TrueSkill, Glicko or Elo, which update ratings one game at a time, TTT models the **whole history of games as one Bayesian network**. Information flows both forward and backward in time, so:

- a player's early estimates are corrected by what their later games reveal,
- ratings from different times are comparable, and
- new players get reasonable estimates quickly.

This port is a single file with no dependencies. It runs unchanged in **Google Apps Script**, Node.js and browsers.

**Contents:** [Verification](#verified-against-the-python-package) · [Quick start (Apps Script)](#quick-start-google-apps-script) · [rateGames reference](#rategames-reference) · [How time works](#how-time-works) · [Convergence](#convergence-and-iterations) · [Reading the ratings](#reading-the-ratings) · [Choosing parameters](#choosing-parameters) · [Raw API](#raw-api) · [Errors](#errors) · [Limitations](#limitations) · [Differences from Python](#differences-from-the-python-package) · [Tests](#running-the-tests) · [License](#credits-and-license)

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
| Saving and loading a History (pickling) | — | Not ported. Recompute from your game log instead. |

## Quick start (Google Apps Script)

### Option 1: set it up as a library (recommended)

1. Create a new Apps Script project. Add [`appsscript/TTT.gs`](appsscript/TTT.gs), then add [`appsscript/exports.gs`](appsscript/exports.gs) **after** it in the file list.
2. Click **Deploy → New deployment**, choose the **Library** type, and click **Deploy**.
3. Copy the **Script ID** from **Project Settings**. Use the Script ID, not the deployment ID that starts with `AKfycb`.
4. In your main project, click **Libraries → +**, paste the Script ID, click **Look up**, and set the identifier to `TTT`.

The library exposes these functions: `rateGames`, `conservative`, `newHistory`, `newGame`, `gaussian` and `player`.

**Updating:** after changing the library, create a new deployment, then select the new version in your main project's **Libraries** panel. Your main project keeps using the old version until you do.

### Option 2: paste into your project

Add a script file and paste in [`appsscript/TTT.gs`](appsscript/TTT.gs). This creates a global called `TTT` with the [raw API](#raw-api).

- If you also want `rateGames` and `conservative`, paste in [`exports.gs`](appsscript/exports.gs) too and call them without the `TTT.` prefix.
- Apps Script runs files from top to bottom, so put these files above any file that uses them at the top level.

### Test that it works

```js
function testTTT() {
  const games = [
    { players: ['ann', 'bo', 'cy', 'di'], time: 0 },                       // listed in finishing order
    { players: ['bo', 'ann', 'di', 'cy'], time: 1 },
    { players: ['ann', 'cy', 'bo', 'di'], time: 1 },                       // same day as the game before
    { players: ['di', 'ann', 'bo', 'cy'], ranks: [0, 1, 1, 3], time: 5 },  // ann and bo tie for 2nd
  ];
  const result = TTT.rateGames(games, { pDraw: 0.05 });
  Object.keys(result.ratings)
    .sort((a, b) => result.ratings[b].mu - result.ratings[a].mu)
    .forEach(id => {
      const r = result.ratings[id];
      Logger.log(`${id}: mu=${r.mu.toFixed(2)}, sigma=${r.sigma.toFixed(2)}, conservative=${TTT.conservative(r).toFixed(2)}`);
    });
}
```

Expected log:

```
ann: mu=0.93, sigma=0.76, conservative=-1.37
bo: mu=0.43, sigma=0.73, conservative=-1.76
di: mu=-0.52, sigma=0.77, conservative=-2.83
cy: mu=-0.77, sigma=0.79, conservative=-3.13
```

### Example: a game log from Airtable or a Sheet

```js
const PLACES = ['First place', 'Second place', 'Third place', 'Fourth place'];

const games = GAMES.map(game => ({
  players: PLACES.map(place => game[place + ' name'][0]),
  time: Math.floor(new Date(game.Timestamp).getTime() / 86400000),   // whole days; see "How time works"
}));

const { ratings } = TTT.rateGames(games, { gamma: 0.03, iterations: 30 });
// ratings[playerId] → { mu, sigma, games }
```

Recomputing from the full history on every run is the intended way to use TTT. In Node, 150 four-player games take about 0.04 seconds with the default 8 iterations, or 0.15 seconds with 30. Apps Script is slower, but still far inside its 6-minute limit for histories of this size.

## rateGames reference

`rateGames(games, options)` is the easiest way to rate free-for-all games, for example 4-player mahjong, where every player is their own team.

**`games`** is an array of objects:

| Field | Required | Meaning |
| --- | --- | --- |
| `players` | yes | Player ids. They're converted to strings, so `7` and `'7'` are the same player. |
| `ranks` | no | Finishing position of each player, with `0` = first. Equal ranks are ties. If omitted, `players` is taken to be in finishing order. Only the order matters: `[0, 1, 1, 3]` and `[0, 5, 5, 9]` mean the same thing. |
| `time` | no | When the game happened, as a number. Larger means later, and games don't need to be sorted. If any game omits it, all games are treated as consecutive, one per time step, in array order. See [How time works](#how-time-works). |

**`options`** (all optional):

| Option | Default | Meaning |
| --- | --- | --- |
| `mu`, `sigma` | `0`, `3` | Prior skill of a new player |
| `beta` | `1` | Game-to-game performance noise |
| `gamma` | `0.15` | Skill drift per unit of `time` |
| `pDraw` | `0` | Tie probability. **Must be > 0 if any game has tied ranks.** |
| `iterations` | `8` | Maximum forward/backward passes. See [Convergence](#convergence-and-iterations). |
| `epsilon` | `1e-5` | Stop early once the largest change is below this |
| `priors` | none | `{ id: { mu, sigma, beta?, gamma? } }` for players whose skill you already know |

**Returns:**

| Field | Meaning |
| --- | --- |
| `ratings` | `{ id: { mu, sigma, games } }`: each player's estimate at their most recent time step, and how many games they played |
| `curves` | `{ id: [{ time, mu, sigma }, ...] }`: the estimate at each time step the player played in, oldest first |
| `logEvidence` | How well the model explains all the results. Closer to 0 is better; use it to [compare parameters](#choosing-parameters). |
| `iterations` | Passes used by the final convergence round. If it equals `options.iterations`, the cap was reached before `epsilon`. |

`conservative(rating, k = 3)` returns `mu - k * sigma`. Sorting a leaderboard by this keeps players with few games from ranking high on luck.

## How time works

- **Time steps:** games with exactly the same `time` form one time step. Within a step, each player's skill is assumed to be constant.
- **Drift between steps:** between a player's steps, their skill may drift by up to `gamma × √(elapsed time)` standard deviations. The drift is capped at `1.67 × sigma`.
- **Choosing a unit:** pick one unit and use it consistently, because `gamma` is per unit. Days are a good choice for most clubs.
  - `Math.floor(ms / 86400000)` puts all of a day's games in one step. Use this when one evening's results shouldn't be treated as skill changing mid-session.
  - Fractional days, `ms / 86400000`, give every game its own step, with a tiny drift between games on the same day. That's also fine.
- **If you omit `time`:** games are numbered 0, 1, 2, … in order, so each game is one time unit after the previous one.

## Convergence and iterations

TTT refines all estimates by passing information forward and backward through the history until the estimates stop changing. `convergence()` (and `rateGames`) stops after `iterations` passes, or earlier once the largest change falls below `epsilon`.

The default of 8 iterations matches the Python package, but on real histories it often stops before full convergence. In a 150-game, 12-player test, 8 iterations left ratings within about 0.13 of their fully converged values, on a scale where sigma is about 8. 30 iterations brought that to about 0.06.

These differences are usually too small to change a leaderboard. For more precision, pass `iterations: 30` or more. Check the returned `iterations`: if it equals your cap, the estimates were still moving slightly.

## Reading the ratings

- **`mu` and `sigma`:** `mu` is the estimated skill and `sigma` its uncertainty. They're on TTT's own scale, centered on `mu` (default 0), so they can't be compared with OpenSkill or TrueSkill numbers, which start at 25.
- **Only differences matter:** what counts is the difference between players relative to `beta`. A player whose `mu` is `beta` higher than an opponent wins a 1v1 about 71–76% of the time, depending on how uncertain the two ratings are.
- **Earlier estimates change:** past values in `curves` change as new games arrive, because later results inform earlier estimates. This is intended, and it's what makes TTT ratings comparable across time.
- **Predicting a result:** build a game from current estimates and read its `evidence`, the model's probability of that result:

  ```js
  const p = (r) => TTT.player(r.mu, r.sigma, 1, 0);   // beta, gamma: use the values you rate with
  const g = TTT.newGame([[p(ratings.ann)], [p(ratings.bo)]], [1, 0]);   // ann beats bo
  g.evidence;   // probability that ann beats bo
  ```

  For more than two teams, `evidence` approximates the probability of that exact finishing order. For four equal players it gives 0.0416, against the exact 1/24 ≈ 0.0417.

## Choosing parameters

| Parameter | Meaning | Default |
| --- | --- | --- |
| `mu`, `sigma` | Prior skill of a new player | `0`, `3` |
| `beta` | Game-to-game performance noise | `1` |
| `gamma` | How much skill can drift per unit of time | `0.15` |
| `pDraw` | Probability of a tie between adjacent finishers | `0` |

- **Scale:** skill is on an arbitrary scale, so only the ratios between parameters matter. It's usually simplest to keep `beta = 1` and tune the others.
- **`gamma`:** this is per unit of `time`. With days, `0.15` allows a lot of change, so try values around `0.01`–`0.05`.
- **`pDraw`:** set it to roughly how often tied placements actually happen. It only needs to be above 0 if ties occur.
- **Comparing settings:** run `rateGames` with each candidate and compare `logEvidence`. The value closest to 0 explains your results best. With small histories, differences of less than about 1 aren't meaningful.

## Raw API

The raw API mirrors the Python package, with camelCase names and an options object. In a library, create objects with `newHistory`, `newGame`, `gaussian` and `player`. With pasted files, use `new TTT.History(...)` and the other constructors directly.

### History

```js
const h = new TTT.History(
  [[['a'], ['b']], [['b'], ['c']], [['c'], ['a']]],   // games → teams → player names
  {
    results: [[1, 0], [1, 0], [1, 0]],   // per game, one score per team; HIGHER is better
    times: [0, 5, 9],                    // optional; default 0, 1, 2, ...
    mu: 0, sigma: 3, beta: 1, gamma: 0.15, pDraw: 0,   // these are the defaults
    // priors: { a: new TTT.Player(new TTT.Gaussian(2, 0.5), 1, 0.01) },   // object or Map
    // weights: per game, [team][player] contribution weights (default all 1)
    // obs: per game, 'Ordinal' (default) or 'Continuous'
    // online: true,
  });
```

| Method | Returns |
| --- | --- |
| `convergence(iterations = 8, epsilon = 1e-5, verbose = false)` | `[[muStep, sigmaStep], iterationsRun]`. With `verbose`, progress is logged with `Logger.log` or `console.log`. |
| `learningCurves(who?, online?)` | `{ name: [[time, Gaussian], ...] }`. `who` is an optional array of names to include. |
| `currentSkills()` | `{ name: Gaussian }`: the latest estimate per player |
| `logEvidence()` | Log probability of all observed results |
| `geometricMean()` | Geometric mean of the per-game probability of the observed result |
| `addHistory(composition, { results, times, priors, weights, obs })` | Adds games; then call `convergence()` again. See [Differences](#differences-from-the-python-package). |

**Results:** higher scores are better, and equal scores are ties. If you omit `results` (or a game's entry is `[]`), teams are assumed to be listed from winner to loser. With `obs: 'Continuous'`, the scores are real measurements, such as points or times, and their differences are used directly.

**Online mode** (`online: true`): `learningCurves(null, true)` returns each step's estimate using only the games before it. That's what someone would have known at the time, and it's useful for testing predictions honestly. `convergence()` then processes the time steps one by one, so it takes longer.

### Game

`new TTT.Game(teams, result, pDraw, weights, obs)`. `teams` is an array of teams, and each team is an array of `TTT.Player`.

- `game.posteriors()` gives the updated skills, as `[team][player]` Gaussians.
- `game.evidence` is the probability of the result.
- `game.likelihoods` holds the raw messages.

### Gaussian and Player

- `new TTT.Gaussian(mu, sigma)` has the properties `mu`, `sigma`, `pi` (precision) and `tau`. Its methods are `add`, `sub`, `mul` (a Gaussian or a number), `div`, `delta`, `cdf(x)`, `isapprox(other, tol)` and `toJSON()`.
- `new TTT.Player(prior, beta, gamma)` takes a Gaussian `prior`. For a standalone player, the defaults are `N(0, 6)`, `beta = 1` and `gamma = 0.03`, the Python package's module defaults. Inside a History, players without priors use the History's `mu`, `sigma`, `beta` and `gamma` instead.

## Errors

| Message | Cause | Fix |
| --- | --- | --- |
| `A game has tied teams but pDraw is 0` | Two teams or players share a result while `pDraw` is 0 | Set `pDraw` above 0, for example `0.01` |
| `composition.length != results.length` (or `times`, `weights`, `obs`) | The per-game arrays have different lengths | Give one entry per game |
| `addHistory: time ... is earlier than the latest time` | Games were added out of order | Add later games only, or rebuild the History |
| `Unsupported observation model` | `obs` is something other than `'Ordinal'` or `'Continuous'` | The Discrete model isn't ported |
| `ranks and players have different lengths` | A game in `rateGames` has mismatched arrays | Give one rank per player |
| `TTT is not defined` (Apps Script) | The library identifier isn't `TTT`, or `TTT.gs` loads after the file using it | Check the identifier or the file order |
| `TTT.rateGames is not a function` | The library is missing `exports.gs`, or was deployed before it was added | Add it, redeploy, and update the version |

## Limitations

- **No weighting of whole games.** There's no built-in way to make some games count more than others, for example a short game counting half. The `weights` option is a different thing: it scales each player's contribution to their team's performance.
- **Discrete (Poisson score) model:** not ported.
- **No saved state.** There's no way to save and reload a converged History. TTT is designed to be recomputed from the full game log.
- **No automatic parameter fitting.** Compare `logEvidence` across settings yourself.
- **Runtime:** needs a JavaScript engine with ES2015 classes and `Map`. Apps Script's V8 runtime (the default) qualifies; the legacy Rhino runtime does not.

## Differences from the Python package

- **`addHistory`.** In Python 2.0.0, `add_history` always starts a new time step, even when a game's time matches an existing one. That's because it checks the time against the wrong list (`batches` instead of `btimes`). In this port, a game at the latest existing time joins that time step, a later time starts a new step, and an earlier time throws an error. Default times continue from the latest time (+1, +2, …). When every added game has a new, later time, the result matches Python exactly.
- **Results direction.** The Python `Game` docstring says "lower is better", but the Python code and README use higher-is-better, and so does this port.
- **`convergence` output:** it doesn't print unless you pass `verbose = true`.
- **Ties without `pDraw`.** Python fails with a division by zero. This port throws an error explaining the fix.
- **Round-off guard:** a tiny negative variance caused by round-off is clamped to 0 instead of producing `NaN`.

## Running the tests

```bash
npm test          # rebuilds appsscript/TTT.gs, compares with Python, checks the Apps Script library
npm run fixtures  # regenerates test/fixtures.json (needs: pip install trueskillthroughtime numpy scipy)
```

`src/ttt.js` is the source. `appsscript/TTT.gs` is generated from it by `npm run build`; edit `src/ttt.js`, not the generated file.

## Credits and license

The model and the original implementation are by Gustavo Landfried. Please cite the paper if you use this in research:

> Landfried, G., & Mocskos, E. (2025). *TrueSkill Through Time: Reliable Initial Skill Estimates and Historical Comparability with Julia, Python, and R.* Journal of Statistical Software, 112, 1–41.

This port is released under the same [Clear BSD License](LICENSE) as the original.

As the original project notes, the TrueSkill™ brand is Microsoft's and is not covered by the BSD license. Microsoft permits only Xbox Live games or non-commercial projects to use the TrueSkill name.
