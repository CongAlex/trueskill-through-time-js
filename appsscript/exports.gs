/**
 * Public functions for using TTT as an Apps Script library.
 *
 * Put this file AFTER TTT.gs in the library project. Libraries only expose
 * top-level functions, so these wrap the TTT global.
 */

/**
 * Rates a list of free-for-all games (e.g. 4-player mahjong) with TrueSkill Through Time.
 *
 * games: array of { players: [id, ...], ranks: [0, 1, 2, 3], time: number }
 *   players - player ids (strings)
 *   ranks   - optional finishing position of each player, 0 = first; equal ranks are ties.
 *             Omit to mean "players are listed in finishing order".
 *   time    - optional; games with a larger time happen later. Use days, e.g.
 *             new Date(timestamp).getTime() / 86400000. Default: game order.
 * options: { mu, sigma, beta, gamma, pDraw, iterations, epsilon, priors }
 *   priors  - optional { id: { mu, sigma, beta, gamma } } for players with known skill
 *   Ties need pDraw > 0.
 *
 * Returns {
 *   ratings:     { id: { mu, sigma, games } }     latest estimate per player
 *   curves:      { id: [{ time, mu, sigma }] }    estimate at each time the player played
 *   logEvidence: number                           how well the model explains the results
 *   iterations:  number                           passes used by the last convergence round
 * }
 */
function rateGames(games, options) {
  var o = options || {};
  var composition = [], results = [], times = [], hasTimes = true, counts = {};
  games.forEach(function (g) {
    var players = g.players.map(String);
    var ranks = g.ranks || players.map(function (_, i) { return i; });
    if (ranks.length !== players.length) throw new Error('ranks and players have different lengths');
    composition.push(players.map(function (p) { return [p]; }));
    results.push(ranks.map(function (r) { return -r; }));   // TTT scores: higher is better
    if (g.time === undefined || g.time === null) hasTimes = false;
    times.push(g.time);
    players.forEach(function (p) { counts[p] = (counts[p] || 0) + 1; });
  });

  var priors;
  if (o.priors) {
    priors = {};
    Object.keys(o.priors).forEach(function (id) {
      var p = o.priors[id];
      priors[String(id)] = new TTT.Player(new TTT.Gaussian(p.mu, p.sigma),
        p.beta === undefined ? (o.beta === undefined ? 1 : o.beta) : p.beta,
        p.gamma === undefined ? (o.gamma === undefined ? 0.15 : o.gamma) : p.gamma);
    });
  }

  var h = new TTT.History(composition, {
    results: results,
    times: hasTimes ? times : undefined,
    priors: priors,
    mu: o.mu, sigma: o.sigma, beta: o.beta, gamma: o.gamma, pDraw: o.pDraw
  });
  var conv = h.convergence(o.iterations, o.epsilon);

  var lc = h.learningCurves();
  var ratings = {}, curves = {};
  Object.keys(lc).forEach(function (id) {
    curves[id] = lc[id].map(function (tp) { return { time: tp[0], mu: tp[1].mu, sigma: tp[1].sigma }; });
    var last = lc[id][lc[id].length - 1][1];
    ratings[id] = { mu: last.mu, sigma: last.sigma, games: counts[id] };
  });

  return { ratings: ratings, curves: curves, logEvidence: h.logEvidence(), iterations: conv[1] };
}

/** Conservative display value: mu - k * sigma (k defaults to 3). */
function conservative(rating, k) {
  return rating.mu - (k === undefined ? 3 : k) * rating.sigma;
}

/** A History object for advanced use (see the README). */
function newHistory(composition, options) {
  return new TTT.History(composition, options);
}

/** A Gaussian (mu, sigma). */
function gaussian(mu, sigma) {
  return new TTT.Gaussian(mu, sigma);
}

/** A Player with a prior skill and its beta (performance noise) and gamma (drift). */
function player(mu, sigma, beta, gamma) {
  return new TTT.Player(new TTT.Gaussian(mu, sigma), beta, gamma);
}

/** A single Game; see the README. */
function newGame(teams, result, pDraw, weights, obs) {
  return new TTT.Game(teams, result, pDraw, weights, obs);
}
