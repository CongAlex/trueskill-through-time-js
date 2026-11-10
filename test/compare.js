// Checks the JavaScript port against reference results from the Python package.
//   node test/compare.js
'use strict';
const fs = require('fs');
const path = require('path');
const TTT = require('../src/ttt.js');

const TOL = 1e-9;
const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'));

let failed = 0;
let worst = 0;

function relDiff(a, b) {
  if (a === b) return 0;
  if (!isFinite(a) || !isFinite(b)) return a === b ? 0 : Infinity;
  return Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b));
}

function compareNested(got, want, where, acc) {
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) throw new Error(where + ': shape mismatch');
    want.forEach((w, i) => compareNested(got[i], w, where + '[' + i + ']', acc));
  } else if (want !== null && typeof want === 'object') {
    const keys = Object.keys(want);
    if (Object.keys(got).length !== keys.length) throw new Error(where + ': key mismatch');
    keys.forEach(k => compareNested(got[k], want[k], where + '.' + k, acc));
  } else {
    const d = relDiff(got, want);
    if (d > acc.max) { acc.max = d; acc.where = where; acc.got = got; acc.want = want; }
  }
}

const g2a = g => [g.mu, g.sigma];
const toPlayer = p => new TTT.Player(new TTT.Gaussian(p[0], p[1]), p[2], p[3]);
const curves = (lc) => {
  const out = {};
  Object.keys(lc).forEach(k => { out[k] = lc[k].map(([t, s]) => [t, g2a(s)]); });
  return out;
};

function historyOptions(inp) {
  const o = Object.assign({}, inp.params || {});
  if (inp.results) o.results = inp.results;
  if (inp.times) o.times = inp.times;
  if (inp.weights) o.weights = inp.weights;
  if (inp.online) o.online = true;
  if (inp.priors) {
    o.priors = {};
    Object.keys(inp.priors).forEach(k => { o.priors[k] = toPlayer(inp.priors[k]); });
  }
  return o;
}

function run(c) {
  const inp = c.input;
  switch (c.kind) {
    case 'erfc': return inp.map(TTT.erfc);
    case 'erfcinv': return inp.map(TTT.erfcinv);
    case 'margin': return inp.map(([p, s]) => TTT.computeMargin(p, s));
    case 'game': {
      const teams = inp.teams.map(t => t.map(toPlayer));
      const g = new TTT.Game(teams, inp.result || [], inp.pDraw, inp.weights || [], inp.obs);
      return {
        evidence: g.evidence,
        likelihoods: g.likelihoods.map(t => t.map(g2a)),
        posteriors: g.posteriors().map(t => t.map(g2a)),
      };
    }
    case 'history': {
      const h = new TTT.History(inp.composition, historyOptions(inp));
      const [, its] = h.convergence(inp.iterations, inp.epsilon);
      return {
        logEvidence: h.logEvidence(),
        curves: curves(h.learningCurves()),
        onlineCurves: h.online ? curves(h.learningCurves(null, true)) : null,
        iterationsRun: its,
      };
    }
    case 'addHistory': {
      const h = new TTT.History(inp.first.composition, Object.assign({}, inp.params, inp.first));
      h.convergence();
      h.addHistory(inp.second.composition, inp.second);
      h.convergence();
      return { logEvidence: h.logEvidence(), curves: curves(h.learningCurves()), onlineCurves: null };
    }
    default: throw new Error('unknown kind ' + c.kind);
  }
}

console.log('Reference: ' + fixtures.version + '\n');
for (const c of fixtures.cases) {
  const acc = { max: 0 };
  let status;
  try {
    const t0 = Date.now();
    compareNested(run(c), c.output, 'out', acc);
    const ms = Date.now() - t0;
    status = acc.max <= TOL ? 'ok  ' : 'FAIL';
    if (acc.max > TOL) failed++;
    worst = Math.max(worst, acc.max);
    console.log(`${status} ${c.name.padEnd(28)} max rel diff ${acc.max.toExponential(2)}  (${ms} ms)` +
      (acc.max > TOL ? `\n     at ${acc.where}: got ${acc.got}, want ${acc.want}` : ''));
  } catch (e) {
    failed++;
    console.log(`FAIL ${c.name.padEnd(28)} ${e.stack}`);
  }
}

console.log(`\n${fixtures.cases.length - failed}/${fixtures.cases.length} passed, worst relative difference ${worst.toExponential(2)}`);
process.exit(failed ? 1 : 0);
