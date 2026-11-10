// Loads the Apps Script files the way Apps Script does (plain globals, no
// module system) and checks the library functions.
//   node test/appsscript.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const dir = path.join(__dirname, '..', 'appsscript');
const ctx = { Logger: { log() {} } };
vm.createContext(ctx);
for (const f of ['TTT.gs', 'exports.gs']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f });
}

const out = vm.runInContext(`(function () {
  var games = [
    { players: ['ann', 'bo', 'cy', 'di'], time: 0 },
    { players: ['bo', 'ann', 'di', 'cy'], time: 1 },
    { players: ['ann', 'cy', 'bo', 'di'], time: 1 },
    { players: ['di', 'ann', 'bo', 'cy'], ranks: [0, 1, 1, 3], time: 5 }
  ];
  var r = rateGames(games, { pDraw: 0.05 });
  // Same history through the raw API.
  var h = newHistory(
    games.map(function (g) { return g.players.map(function (p) { return [p]; }); }),
    { results: games.map(function (g) { return (g.ranks || [0, 1, 2, 3]).map(function (x) { return -x; }); }),
      times: games.map(function (g) { return g.time; }), pDraw: 0.05 });
  h.convergence();
  return { r: r, raw: h.currentSkills(), cons: conservative(r.ratings.ann) };
})()`, ctx);

assert.deepStrictEqual(Object.keys(out.r.ratings).sort(), ['ann', 'bo', 'cy', 'di']);
for (const id of Object.keys(out.r.ratings)) {
  assert.ok(Math.abs(out.r.ratings[id].mu - out.raw[id].mu) < 1e-12, 'mu matches raw API for ' + id);
  assert.ok(Math.abs(out.r.ratings[id].sigma - out.raw[id].sigma) < 1e-12, 'sigma matches raw API for ' + id);
}
assert.strictEqual(out.r.ratings.ann.games, 4);
assert.ok(out.r.ratings.ann.mu > out.r.ratings.cy.mu, 'the frequent winner is rated above the frequent loser');
assert.strictEqual(out.r.curves.ann.length, 3, 'one point per distinct time ann played');
assert.ok(isFinite(out.r.logEvidence) && out.r.logEvidence < 0);
assert.ok(Math.abs(out.cons - (out.r.ratings.ann.mu - 3 * out.r.ratings.ann.sigma)) < 1e-12);

// Ties without pDraw give a clear error.
assert.throws(() => vm.runInContext(
  `rateGames([{ players: ['a', 'b', 'c', 'd'], ranks: [0, 0, 2, 3] }])`, ctx), /pDraw/);

console.log('Apps Script library checks passed');
console.log(JSON.stringify(out.r.ratings, null, 2));
