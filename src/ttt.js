/**
 * ttt.js — TrueSkill Through Time in plain JavaScript.
 *
 * A dependency-free port of the official Python package `trueskillthroughtime`
 * (v2.0.0) by Gustavo Landfried: https://github.com/glandfried/TrueSkillThroughTime.py
 *
 * Runs unchanged in Google Apps Script (V8), Node.js and browsers.
 * In Apps Script it defines a global `TTT`; in Node it is also `module.exports`.
 *
 * Ported: Gaussian, Player, Game (Ordinal and Continuous observation models,
 * draws, team weights), History (batch and online modes, convergence,
 * learning curves, evidence, incremental addHistory).
 * Not ported: the "Discrete" (Poisson score) observation model.
 *
 * Original work: Copyright (c) 2019-2026 Gustavo Landfried. Clear BSD License.
 * JavaScript port: Copyright (c) 2026 CongAlex. Same license; see LICENSE.
 */
var TTT = (function () {
  'use strict';

  var INF = Infinity;
  var SQRT2 = Math.sqrt(2);
  var SQRT2PI = Math.sqrt(2 * Math.PI);
  var SQRTPI = Math.sqrt(Math.PI);

  var MU = 0.0;
  var SIGMA = 6;
  var BETA = 1.0;
  var GAMMA = 0.03;

  // ---------------------------------------------------------------------------
  // Numerics (replacing math.erfc and scipy.special.erfcinv)
  // ---------------------------------------------------------------------------

  // Same algorithm CPython used for math.erfc: a power series near zero and a
  // continued fraction in the tails. Accurate to about 1e-15.
  function erfSeries(x) {
    var x2 = x * x, acc = 0.0, fk = 25 + 0.5;
    for (var i = 0; i < 25; i++) {
      acc = 2.0 + x2 * acc / fk;
      fk -= 1.0;
    }
    return acc * x * Math.exp(-x2) / SQRTPI;
  }

  function erfcContfrac(x) {
    if (x >= 30.0) return 0.0;
    var x2 = x * x, a = 0.0, da = 0.5, p = 1.0, pLast = 0.0, q = da + x2, qLast = 1.0, b, tmp;
    for (var i = 0; i < 50; i++) {
      a += da;
      da += 2.0;
      b = da + x2;
      tmp = p; p = b * p - a * pLast; pLast = tmp;
      tmp = q; q = b * q - a * qLast; qLast = tmp;
    }
    return p / q * x * Math.exp(-x2) / SQRTPI;
  }

  function erfc(x) {
    if (isNaN(x)) return NaN;
    var absx = Math.abs(x);
    if (absx < 1.5) return 1.0 - erfSeries(x);
    var cf = erfcContfrac(absx);
    return x > 0.0 ? cf : 2.0 - cf;
  }

  // Inverse of erfc via a rough initial guess refined with Halley steps on erfc.
  function erfcinv(y) {
    if (y <= 0) return INF;
    if (y >= 2) return -INF;
    if (y === 1) return 0;
    // Standard normal quantile for p = y/2, then x = -z / sqrt(2).
    var p = y / 2;
    var pp = p < 0.5 ? p : 1 - p;
    var t = Math.sqrt(-2 * Math.log(pp));
    var z = t - (2.515517 + 0.802853 * t + 0.010328 * t * t) /
                (1 + 1.432788 * t + 0.189269 * t * t + 0.001308 * t * t * t);
    if (p < 0.5) z = -z;          // z ≈ Φ⁻¹(p), error < 4.5e-4
    var x = -z / SQRT2;           // erfc(x) = y
    for (var i = 0; i < 6; i++) {
      var err = erfc(x) - y;
      var deriv = -2 / SQRTPI * Math.exp(-x * x);    // d/dx erfc(x)
      if (deriv === 0) break;
      var step = err / deriv;
      x -= step / (1 + x * step);                     // Halley correction
      if (Math.abs(step) < 1e-16 * Math.max(1, Math.abs(x))) break;
    }
    return x;
  }

  function cdf(x, mu, sigma) {
    if (mu === undefined) mu = 0;
    if (sigma === undefined) sigma = 1;
    var z = -(x - mu) / (sigma * SQRT2);
    return 0.5 * erfc(z);
  }

  function pdf(x, mu, sigma) {
    var normalizer = 1 / (SQRT2PI * sigma);
    var functional = Math.exp(-((x - mu) * (x - mu)) / (2 * sigma * sigma));
    return normalizer * functional;
  }

  function ppf(p, mu, sigma) {
    return mu - sigma * SQRT2 * erfcinv(2 * p);
  }

  // Python's max(a, b): returns a unless b is strictly greater (so NaN never wins).
  function pmax(a, b) {
    return b > a ? b : a;
  }

  function vw(mu, sigma, margin, tie) {
    var v, w;
    if (!tie) {
      var alpha = (margin - mu) / sigma;
      v = pdf(-alpha, 0, 1) / cdf(-alpha, 0, 1);
      w = v * (v + (-alpha));
    } else {
      var a = (-margin - mu) / sigma;
      var b = (margin - mu) / sigma;
      var denom = cdf(b, 0, 1) - cdf(a, 0, 1);
      v = (pdf(a, 0, 1) - pdf(b, 0, 1)) / denom;
      var u = (a * pdf(a, 0, 1) - b * pdf(b, 0, 1)) / denom;
      w = -(u - v * v);
    }
    return [v, w];
  }

  function trunc(mu, sigma, margin, tie) {
    var r = vw(mu, sigma, margin, tie);
    return [mu + sigma * r[0], sigma * Math.sqrt(1 - r[1])];
  }

  function approx(N, margin, tie) {
    var r = trunc(N.mu, N.sigma, margin, tie);
    return new Gaussian(r[0], r[1]);
  }

  function computeMargin(pDraw, sd) {
    return Math.abs(ppf(0.5 - pDraw / 2, 0.0, sd));
  }

  // Indices that sort xs (stable). Descending by default, like Python's orden().
  function orden(xs, reverse) {
    if (reverse === undefined) reverse = true;
    var idx = xs.map(function (_, i) { return i; });
    idx.sort(function (i, j) {
      if (xs[i] === xs[j]) return 0;
      return reverse ? (xs[i] > xs[j] ? -1 : 1) : (xs[i] < xs[j] ? -1 : 1);
    });
    return idx;
  }

  // ---------------------------------------------------------------------------
  // Gaussian
  // ---------------------------------------------------------------------------

  class Gaussian {
    constructor(mu, sigma) {
      if (mu === undefined) mu = MU;
      if (sigma === undefined) sigma = SIGMA;
      if (!(sigma >= 0.0)) throw new Error('sigma should be greater than 0 (got ' + sigma + ')');
      this.mu = mu;
      this.sigma = sigma;
    }

    get pi() {
      return this.sigma > 0.0 ? 1 / (this.sigma * this.sigma) : INF;
    }

    get tau() {
      return this.sigma > 0.0 ? this.mu * this.pi : 0;
    }

    /** Sum of independent Gaussians. */
    add(M) {
      return new Gaussian(this.mu + M.mu, Math.sqrt(this.sigma * this.sigma + M.sigma * M.sigma));
    }

    /** Difference of independent Gaussians. */
    sub(M) {
      return new Gaussian(this.mu - M.mu, Math.sqrt(this.sigma * this.sigma + M.sigma * M.sigma));
    }

    /** Product of densities, or scaling when M is a number. */
    mul(M) {
      if (typeof M === 'number') {
        if (M === INF) return Ninf;
        return new Gaussian(M * this.mu, Math.abs(M) * this.sigma);
      }
      if (M.pi === 0) return this;
      if (this.pi === 0) return M;
      var p = this.pi + M.pi;
      return new Gaussian((this.tau + M.tau) / p, Math.pow(p, -0.5));
    }

    /** Division of densities (removes M's contribution). */
    div(M) {
      var p = this.pi - M.pi;
      var sigma = p === 0.0 ? INF : Math.pow(p, -0.5);
      var mu = p === 0.0 ? 0.0 : (this.tau - M.tau) / p;
      return new Gaussian(mu, sigma);
    }

    delta(M) {
      return [Math.abs(this.mu - M.mu), Math.abs(this.sigma - M.sigma)];
    }

    cdf(x) {
      return cdf(x, this.mu, this.sigma);
    }

    isapprox(M, tol) {
      if (tol === undefined) tol = 1e-5;
      return Math.abs(this.mu - M.mu) < tol && Math.abs(this.sigma - M.sigma) < tol;
    }

    toJSON() {
      return { mu: this.mu, sigma: this.sigma };
    }

    toString() {
      return 'N(mu=' + this.mu.toFixed(6) + ', sigma=' + this.sigma.toFixed(6) + ')';
    }
  }

  function suma(Ns) {
    var res = new Gaussian(0, 0);
    for (var i = 0; i < Ns.length; i++) res = res.add(Ns[i]);
    return res;
  }

  function producto(Ns) {
    var res = new Gaussian(0, INF);
    for (var i = 0; i < Ns.length; i++) res = res.mul(Ns[i]);
    return res;
  }

  var N01 = new Gaussian(0, 1);
  var N00 = new Gaussian(0, 0);
  var Ninf = new Gaussian(0, INF);
  var Nms = new Gaussian(MU, SIGMA);

  // ---------------------------------------------------------------------------
  // Player
  // ---------------------------------------------------------------------------

  class Player {
    constructor(prior, beta, gamma) {
      this.prior = prior === undefined ? new Gaussian(MU, SIGMA) : prior;
      this.beta = beta === undefined ? BETA : beta;
      this.gamma = gamma === undefined ? GAMMA : gamma;
    }

    performance() {
      return this.prior.add(new Gaussian(0, this.beta));
    }
  }

  class TeamVariable {
    constructor(prior) {
      this.prior = prior;
      this.likelihoodLose = Ninf;
      this.likelihoodWin = Ninf;
    }
    get p() { return this.prior.mul(this.likelihoodLose).mul(this.likelihoodWin); }
    get posteriorWin() { return this.prior.mul(this.likelihoodLose); }
    get posteriorLose() { return this.prior.mul(this.likelihoodWin); }
    get likelihood() { return this.likelihoodWin.mul(this.likelihoodLose); }
  }

  class DiffMessages {
    constructor(prior) {
      this.prior = prior;
      this.likelihood = Ninf;
    }
    get p() { return this.prior.mul(this.likelihood); }
  }

  // ---------------------------------------------------------------------------
  // Game
  // ---------------------------------------------------------------------------

  /**
   * A single game.
   *   teams   - array of teams; each team is an array of Player
   *   result  - one score per team; HIGHER is better, equal scores are ties.
   *             Omit to mean "teams are listed from winner to loser".
   *   pDraw   - draw probability (must be > 0 if any teams tie)
   *   weights - per-player contribution weights, [team][player] (default all 1)
   *   obs     - "Ordinal" (default) or "Continuous"
   */
  class Game {
    constructor(teams, result, pDraw, weights, obs) {
      if (obs === undefined) obs = 'Ordinal';
      if (obs !== 'Ordinal' && obs !== 'Continuous') {
        throw new Error('Unsupported observation model "' + obs + '" (supported: Ordinal, Continuous)');
      }
      var g = this;
      g.teams = teams;
      if (result && result.length === teams.length) {
        g.result = result;
      } else {
        g.result = [];
        for (var k = teams.length - 1; k >= 0; k--) g.result.push(k);
      }
      if (!weights || weights.length === 0) {
        weights = teams.map(function (t) { return t.map(function () { return 1.0; }); });
      }
      g.weights = weights;
      g.pDraw = pDraw || 0.0;
      g.o = orden(g.result);
      g.t = g.performanceTeams();
      g.d = g.differenceTeams();
      if (obs === 'Ordinal') {
        g.tie = [];
        for (var e = 0; e < g.d.length; e++) g.tie.push(g.result[g.o[e]] === g.result[g.o[e + 1]]);
        g.margin = g.computeMargins();
        for (var e2 = 0; e2 < g.d.length; e2++) {
          if (g.tie[e2] && g.margin[e2] === 0) {
            throw new Error('A game has tied teams but pDraw is 0; set pDraw > 0 to allow ties.');
          }
        }
      } else {
        g.tie = null;
        g.margin = null;
      }
      g.obs = obs;
      g.evidence = 1.0;
      g.likelihoods = g.computeLikelihoods();
    }

    get length() {
      return this.teams.length;
    }

    computeMargins() {
      var g = this, res = [];
      for (var e = 0; e < g.d.length; e++) {
        var s = 0;
        g.teams[g.o[e]].forEach(function (a) { s += a.beta * a.beta; });
        g.teams[g.o[e + 1]].forEach(function (a) { s += a.beta * a.beta; });
        res.push(g.pDraw === 0.0 ? 0.0 : computeMargin(g.pDraw, Math.sqrt(s)));
      }
      return res;
    }

    performanceIndividuals() {
      var g = this, res = [];
      for (var t = 0; t < g.teams.length; t++) {
        res.push([]);
        for (var i = 0; i < g.teams[t].length; i++) {
          res[t].push(g.teams[t][i].performance().mul(g.weights[t][i]));
        }
      }
      return res;
    }

    performanceTeams() {
      return this.performanceIndividuals().map(function (team) { return new TeamVariable(suma(team)); });
    }

    differenceTeams() {
      var g = this, res = [];
      for (var e = 0; e < g.teams.length - 1; e++) {
        res.push(new DiffMessages(g.t[g.o[e]].prior.sub(g.t[g.o[e + 1]].prior)));
      }
      return res;
    }

    partialEvidence(iD) {
      var g = this;
      var mu = g.d[iD].prior.mu, sigma = g.d[iD].prior.sigma;
      if (g.obs === 'Ordinal') {
        if (g.tie[iD]) {
          g.evidence *= cdf(g.margin[iD], mu, sigma) - cdf(-g.margin[iD], mu, sigma);
        } else {
          g.evidence *= 1 - cdf(g.margin[iD], mu, sigma);
        }
      } else {
        g.evidence *= pdf(g.result[g.o[iD]] - g.result[g.o[iD + 1]], mu, sigma);
      }
    }

    likelihoodDifference(iD) {
      var g = this;
      if (g.obs === 'Ordinal') {
        return approx(g.d[iD].prior, g.margin[iD], g.tie[iD]).div(g.d[iD].prior);
      }
      return new Gaussian(g.result[g.o[iD]] - g.result[g.o[iD + 1]], 0.0);
    }

    likelihoodConvergence() {
      var g = this, nd = g.d.length;
      for (var i = 0; i < 5; i++) {
        for (var e = 0; e < nd - 1; e++) {
          g.d[e].prior = g.t[g.o[e]].posteriorWin.sub(g.t[g.o[e + 1]].posteriorLose);
          if (i === 0) g.partialEvidence(e);
          g.d[e].likelihood = g.likelihoodDifference(e);
          g.t[g.o[e + 1]].likelihoodLose = g.t[g.o[e]].posteriorWin.sub(g.d[e].likelihood);
        }
        for (var e2 = nd - 1; e2 > 0; e2--) {
          g.d[e2].prior = g.t[g.o[e2]].posteriorWin.sub(g.t[g.o[e2 + 1]].posteriorLose);
          if (i === 0 && e2 === nd - 1) g.partialEvidence(e2);
          g.d[e2].likelihood = g.likelihoodDifference(e2);
          g.t[g.o[e2]].likelihoodWin = g.t[g.o[e2 + 1]].posteriorLose.add(g.d[e2].likelihood);
        }
      }
      if (nd === 1) {
        g.partialEvidence(0);
        g.d[0].prior = g.t[g.o[0]].posteriorWin.sub(g.t[g.o[1]].posteriorLose);
        g.d[0].likelihood = g.likelihoodDifference(0);
      }
      g.t[g.o[0]].likelihoodWin = g.t[g.o[1]].posteriorLose.add(g.d[0].likelihood);
      var last = g.o.length - 1;
      g.t[g.o[last]].likelihoodLose = g.t[g.o[last - 1]].posteriorWin.sub(g.d[nd - 1].likelihood);
      return g.t.map(function (tv) { return tv.likelihood; });
    }

    likelihoodPerformance() {
      var g = this;
      var perf = g.performanceIndividuals();
      var lt = g.likelihoodConvergence();
      var res = [];
      for (var e = 0; e < g.teams.length; e++) {
        res.push([]);
        for (var i = 0; i < g.teams[e].length; i++) {
          var te = lt[e];
          var v = g.t[e].prior.sigma * g.t[e].prior.sigma - perf[e][i].sigma * perf[e][i].sigma;
          if (v < 0 && v > -1e-9) v = 0; // guard against floating-point round-off
          var teWithoutI = new Gaussian(g.t[e].prior.mu - perf[e][i].mu, Math.sqrt(v));
          var w = g.weights[e][i];
          var invW = w === 0 ? INF : 1 / w;
          res[e].push(te.sub(teWithoutI).mul(invW));
        }
      }
      return res;
    }

    likelihoodSkill() {
      var g = this;
      var lhp = g.likelihoodPerformance();
      return lhp.map(function (team, e) {
        return team.map(function (lh, i) { return lh.sub(new Gaussian(0, g.teams[e][i].beta)); });
      });
    }

    likelihoodAnalytic() {
      var g = this;
      g.partialEvidence(0);
      var psi = g.d[0].prior.mu, vartheta = g.d[0].prior.sigma;
      var div = g.likelihoodDifference(0);
      var psiDiv = div.mu, varthetaDiv = div.sigma;
      var res = [];
      for (var t = 0; t < g.t.length; t++) {
        res.push([]);
        var sign = t === 1 ? -1 : 1;
        var team = g.teams[g.o[t]];
        for (var i = 0; i < team.length; i++) {
          var muI = team[i].prior.mu, sigmaI = team[i].prior.sigma;
          var w = g.weights[g.o[t]][i];
          var invW = w === 0 ? INF : 1 / w;
          var muA = muI + invW * (-psi + psiDiv) * sign;
          var sigmaA = Math.sqrt(invW * invW * varthetaDiv * varthetaDiv + invW * invW * vartheta * vartheta - sigmaI * sigmaI);
          res[t].push(new Gaussian(muA, sigmaA));
        }
      }
      return g.o[0] < g.o[1] ? [res[0], res[1]] : [res[1], res[0]];
    }

    computeLikelihoods() {
      return this.teams.length === 2 ? this.likelihoodAnalytic() : this.likelihoodSkill();
    }

    /** Posterior skill of every player, as [team][player] Gaussians. */
    posteriors() {
      var g = this;
      return g.teams.map(function (team, e) {
        return team.map(function (p, i) { return p.prior.mul(g.likelihoods[e][i]); });
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Skill (one player's skill variable at one time step)
  // ---------------------------------------------------------------------------

  class Skill {
    constructor(bevents, likelihoods) {
      this.bevents = bevents;
      this.forward = Ninf;
      this.backward = Ninf;
      this.likelihoods = likelihoods;
      this.online = null;
    }
    get posterior() { return this.forward.mul(this.backward).mul(producto(this.likelihoods)); }
    get forwardPosterior() { return this.forward.mul(producto(this.likelihoods)); }
    get backwardPosterior() { return this.backward.mul(producto(this.likelihoods)); }
    likelihood(e) { return this.likelihoods[this.bevents.indexOf(e)]; }
    updateLikelihood(e, likelihood) {
      var i = this.bevents.indexOf(e);
      var step = likelihood.delta(this.likelihoods[i]);
      this.likelihoods[i] = likelihood;
      return step;
    }
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  function toPriorMap(priors) {
    var m = new Map();
    if (!priors) return m;
    if (priors instanceof Map) {
      priors.forEach(function (v, k) { m.set(k, v); });
    } else {
      Object.keys(priors).forEach(function (k) { m.set(k, priors[k]); });
    }
    return m;
  }

  /**
   * A sequence of games, with skills estimated across the whole history.
   *
   *   composition - games; each game is an array of teams; each team is an array of player names
   *   options:
   *     results - per game, one score per team (HIGHER is better). Omit for "listed winner-first".
   *     times   - per game, a number (e.g. days). Games with the same time share a time step.
   *               Default: 0, 1, 2, ...
   *     priors  - {name: Player} (or a Map) for players with custom priors
   *     mu, sigma, beta, gamma, pDraw - model parameters (defaults 0, 3, 1, 0.15, 0)
   *     online  - online mode: estimates use only past games
   *     weights - per game, [team][player] contribution weights
   *     obs     - per game, "Ordinal" or "Continuous"
   */
  class History {
    constructor(composition, options) {
      var o = options || {};
      var mu = o.mu === undefined ? 0 : o.mu;
      var sigma = o.sigma === undefined ? 3 : o.sigma;
      var beta = o.beta === undefined ? 1 : o.beta;
      var gamma = o.gamma === undefined ? 0.15 : o.gamma;
      var pDraw = o.pDraw === undefined ? 0.0 : o.pDraw;
      History.checkData(composition, o);
      if (sigma < 0) throw new Error('sigma < 0.0');
      if (beta < 0) throw new Error('beta < 0.0');
      if (gamma < 0) throw new Error('gamma < 0.0');
      if (pDraw < 0 || pDraw > 1) throw new Error('pDraw < 0.0 or pDraw > 1.0');

      this.size = 0;
      this.batches = []; this.bresults = []; this.btimes = [];
      this.bskills = []; this.bweights = []; this.bobs = [];
      this.bevidence = [];
      this.mu = mu; this.sigma = sigma;
      this.beta = beta; this.gamma = gamma;
      this.pDraw = pDraw;
      this.priors = toPriorMap(o.priors);
      this.lastMessage = null;
      this.lastTime = null;
      this.online = !!o.online;
      this.initBatches(composition, o.results, o.times, o.weights, o.obs);
      this.bUntil = this.online ? 0 : this.batches.length;
    }

    static checkData(composition, o) {
      if (o.results && o.results.length && composition.length !== o.results.length) throw new Error('composition.length != results.length');
      if (o.times && o.times.length && composition.length !== o.times.length) throw new Error('composition.length != times.length');
      if (o.weights && o.weights.length && composition.length !== o.weights.length) throw new Error('composition.length != weights.length');
      if (o.obs && o.obs.length && composition.length !== o.obs.length) throw new Error('composition.length != obs.length');
    }

    /** The Player used for `name` (created with the default prior on first use). */
    prior(name) {
      if (!this.priors.has(name)) {
        this.priors.set(name, new Player(new Gaussian(this.mu, this.sigma), this.beta, this.gamma));
      }
      return this.priors.get(name);
    }

    newBatch(t) {
      this.btimes.push(t); this.batches.push([]);
      this.bresults.push([]); this.bweights.push([]);
      this.bskills.push(new Map()); this.bobs.push([]);
      this.bevidence.push([]);
      return this.batches.length - 1;
    }

    initBatches(composition, results, times, weights, obs) {
      if (!times || times.length === 0) times = composition.map(function (_, i) { return i; });
      var lastTime = -INF, iB = -1;
      var order = orden(times, false);
      for (var k = 0; k < order.length; k++) {
        var iE = order[k];
        var t = times[iE];
        if (t !== lastTime) {
          iB = this.newBatch(t);
          lastTime = t;
        }
        this.addToBatch(iB, iE, composition, results, weights, obs);
      }
    }

    /**
     * Adds games to an existing history. Times must not be earlier than the
     * latest time already in the history; a game at the latest time joins that
     * time step. Default times continue from the latest time (+1, +2, ...).
     * Run convergence() afterwards; new time steps are processed one by one.
     */
    addHistory(composition, options) {
      var o = options || {};
      History.checkData(composition, o);
      var self = this;
      if (o.priors) {
        toPriorMap(o.priors).forEach(function (v, k) { if (!self.priors.has(k)) self.priors.set(k, v); });
      }
      var lastT = this.btimes.length ? this.btimes[this.btimes.length - 1] : -1;
      var times = (o.times && o.times.length) ? o.times : composition.map(function (_, i) { return lastT + 1 + i; });
      var order = orden(times, false);
      for (var k = 0; k < order.length; k++) {
        var i = order[k];
        var t = times[i];
        var curLast = this.btimes.length ? this.btimes[this.btimes.length - 1] : -INF;
        if (t < curLast) throw new Error('addHistory: time ' + t + ' is earlier than the latest time in the history (' + curLast + ')');
        var iB = t === curLast ? this.btimes.length - 1 : this.newBatch(t);
        this.addToBatch(iB, i, composition, o.results, o.weights, o.obs);
      }
    }

    addToBatch(iB, i, composition, results, weights, obs) {
      this.size += 1;
      this.batches[iB].push(composition[i]);
      this.bresults[iB].push(results && results.length ? results[i] : []);
      this.bweights[iB].push(weights && weights.length ? weights[i] : []);
      this.bobs[iB].push(obs && obs.length ? obs[i] : 'Ordinal');
      this.bevidence[iB].push(null);
      var e = this.batches[iB].length - 1;
      var skills = this.bskills[iB];
      composition[i].forEach(function (team) {
        team.forEach(function (name) {
          if (skills.has(name)) {
            skills.get(name).bevents.push(e);
            skills.get(name).likelihoods.push(Ninf);
          } else {
            skills.set(name, new Skill([e], [Ninf]));
          }
        });
      });
    }

    inSkills(b, forward) {
      var h = this;
      h.bskills[b].forEach(function (skill, name) {
        var oldT = h.lastTime.has(name) ? h.lastTime.get(name) : null;
        var elapsed = oldT !== null ? Math.abs(h.btimes[b] - oldT) : 0;
        var gamma = h.prior(name).gamma;
        var msg = h.lastMessage.has(name) ? h.lastMessage.get(name) : h.defaultMessage;
        var receive = msg.add(new Gaussian(0, Math.min(Math.sqrt(elapsed * gamma * gamma), 1.67 * h.sigma)));
        if (forward) {
          skill.forward = receive;
          if (h.online && !skill.online) skill.online = receive;
        } else {
          skill.backward = receive;
        }
      });
    }

    upSkills(b, e) {
      var h = this;
      var g = new Game(h.withinPriors(b, e), h.bresults[b][e], h.pDraw, h.bweights[b][e], h.bobs[b][e]);
      var lh = g.likelihoods;
      if (h.online && !h.bevidence[b][e]) h.bevidence[b][e] = g.evidence;
      if (!h.online) h.bevidence[b][e] = g.evidence;
      var muMax = 0, sigmaMax = 0;
      var game = h.batches[b][e];
      for (var t = 0; t < game.length; t++) {
        for (var i = 0; i < game[t].length; i++) {
          var step = h.bskills[b].get(game[t][i]).updateLikelihood(e, lh[t][i]);
          muMax = pmax(muMax, step[0]);
          sigmaMax = pmax(sigmaMax, step[1]);
        }
      }
      return [muMax, sigmaMax];
    }

    outSkills(b, forward) {
      var h = this;
      h.bskills[b].forEach(function (skill, name) {
        h.lastTime.set(name, h.btimes[b]);
        h.lastMessage.set(name, forward ? skill.forwardPosterior : skill.backwardPosterior);
      });
    }

    withinPriors(b, e, online) {
      var h = this;
      return h.batches[b][e].map(function (team) {
        return team.map(function (name) {
          var skill = h.bskills[b].get(name);
          var prior = online ? skill.online : skill.posterior.div(skill.likelihood(e));
          var p = h.prior(name);
          return new Player(prior, p.beta, p.gamma);
        });
      });
    }

    forwardPropagation() {
      var h = this;
      h.lastMessage = new Map();
      h.priors.forEach(function (p, name) { h.lastMessage.set(name, p.prior); });
      h.defaultMessage = new Gaussian(h.mu, h.sigma);
      h.lastTime = new Map();
      var muMax = 0, sigmaMax = 0;
      for (var b = 0; b < h.bUntil; b++) {
        h.inSkills(b, true);
        for (var e = 0; e < h.batches[b].length; e++) {
          var s = h.upSkills(b, e);
          muMax = pmax(muMax, s[0]); sigmaMax = pmax(sigmaMax, s[1]);
        }
        h.outSkills(b, true);
      }
      return [muMax, sigmaMax];
    }

    backwardPropagation() {
      var h = this;
      h.lastMessage = new Map();
      h.defaultMessage = new Gaussian(0.0, INF);
      h.lastTime = new Map();
      var muMax = 0, sigmaMax = 0;
      if (h.bUntil > 0) h.outSkills(h.bUntil - 1, false);
      for (var b = h.bUntil - 2; b >= 0; b--) {
        h.inSkills(b, false);
        for (var e = 0; e < h.batches[b].length; e++) {
          var s = h.upSkills(b, e);
          muMax = pmax(muMax, s[0]); sigmaMax = pmax(sigmaMax, s[1]);
        }
        h.outSkills(b, false);
      }
      h.lastMessage = null;
      h.lastTime = null;
      return [muMax, sigmaMax];
    }

    iteration() {
      var f = this.forwardPropagation();
      var bk = this.backwardPropagation();
      return [pmax(f[0], bk[0]), pmax(f[1], bk[1])];
    }

    /**
     * Runs forward/backward passes until the largest change is below epsilon
     * or `iterations` passes have run. Returns [step, iterationsRun].
     */
    convergence(iterations, epsilon, verbose) {
      if (iterations === undefined) iterations = 8;
      if (epsilon === undefined) epsilon = 0.00001;
      var log = verbose ? (typeof Logger !== 'undefined' ? function (s) { Logger.log(s); } : function (s) { console.log(s); }) : null;
      var i = 0, delta = INF, step = [INF, INF];
      this.unveilBatch();
      var rounds = 1 + this.batches.length - this.bUntil;
      for (var r = 0; r < rounds; r++) {
        i = 0; delta = INF;
        if (log) log('Batch = ' + this.bUntil);
        while (i < iterations && delta > epsilon) {
          step = this.iteration();
          delta = pmax(step[0], step[1]);
          i += 1;
          if (log) log('Iteration = ' + (i - 1) + ', step = ' + step);
        }
        this.unveilBatch();
      }
      return [step, i];
    }

    unveilBatch() {
      if (this.bUntil < this.batches.length) this.bUntil += 1;
    }

    /**
     * Skill over time for each player: {name: [[time, Gaussian], ...]}.
     *   who    - optional array of names to include
     *   online - return online estimates (only in online mode)
     */
    learningCurves(who, online) {
      var h = this, res = {};
      for (var b = 0; b < h.bskills.length; b++) {
        var time = h.btimes[b];
        h.bskills[b].forEach(function (skill, name) {
          if (!who || who.indexOf(name) !== -1) {
            var s = (h.online && online) ? skill.online : skill.posterior;
            if (!res.hasOwnProperty(name)) res[name] = [];
            res[name].push([time, s]);
          }
        });
      }
      return res;
    }

    /** Latest estimate for each player: {name: Gaussian}. */
    currentSkills() {
      var lc = this.learningCurves(), res = {};
      Object.keys(lc).forEach(function (name) { res[name] = lc[name][lc[name].length - 1][1]; });
      return res;
    }

    /** Log probability of all observed results under the model. */
    logEvidence() {
      var s = 0;
      this.bevidence.forEach(function (be) { be.forEach(function (ev) { if (ev) s += Math.log(ev); }); });
      return s;
    }

    /** Geometric mean of the per-game probability of the observed result. */
    geometricMean() {
      var n = 0;
      this.bevidence.forEach(function (be) { be.forEach(function (ev) { if (ev !== null) n += 1; }); });
      return Math.exp(this.logEvidence() / n);
    }
  }

  return {
    MU: MU, SIGMA: SIGMA, BETA: BETA, GAMMA: GAMMA,
    Gaussian: Gaussian, Player: Player, Game: Game, History: History,
    N01: N01, N00: N00, Ninf: Ninf, Nms: Nms,
    erfc: erfc, erfcinv: erfcinv, cdf: cdf, pdf: pdf, ppf: ppf, computeMargin: computeMargin
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TTT;
