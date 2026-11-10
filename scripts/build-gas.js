// Copies src/ttt.js to appsscript/TTT.gs so the Apps Script copy stays in sync.
//   node scripts/build-gas.js
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'src', 'ttt.js'), 'utf8');
const header = '// Generated from src/ttt.js by scripts/build-gas.js. Edit src/ttt.js instead.\n';
fs.writeFileSync(path.join(root, 'appsscript', 'TTT.gs'), header + src);
console.log('Wrote appsscript/TTT.gs');
