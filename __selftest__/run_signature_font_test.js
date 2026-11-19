const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The printed signature uses the handwriting font Ernie when the computer
// printing has it installed, and falls back to a script font otherwise. The
// app doesn't ship Ernie itself (it's a commercially licensed font).

const html = fs.readFileSync(path.resolve(__dirname, '..', 'public/index.html'), 'utf8');
const rule = (html.match(/#printArea \.gf-sig-script\{font-family:([^;]+);/) || [])[1] || '';
assert.ok(rule.startsWith("'Ernie'"), 'the signature should ask for Ernie first, got: ' + rule);
assert.ok(/cursive/.test(rule), 'the signature must still fall back to a generic script font');
console.log('✓ The printed signature asks for Ernie first, with script fallbacks');

console.log('\nALL SIGNATURE FONT TESTS PASSED');
process.exit(0);
