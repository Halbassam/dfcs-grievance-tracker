const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The printed signature uses Ernie when the printing computer has it, then
// Caveat (a free handwriting font loaded from Google Fonts), then a generic
// script font. The app doesn't ship Ernie itself (commercially licensed).

const html = fs.readFileSync(path.resolve(__dirname, '..', 'public/index.html'), 'utf8');
const rule = (html.match(/#printArea \.gf-sig-script\{font-family:([^;]+);/) || [])[1] || '';
assert.ok(rule.startsWith("'Ernie'"), 'the signature should ask for Ernie first, got: ' + rule);
assert.ok(/'Caveat'/.test(rule), 'the free closest match (Caveat) must be the fallback after Ernie');
assert.ok(/cursive/.test(rule), 'the signature must still fall back to a generic script font');
assert.ok(/fonts\.googleapis\.com\/css2\?family=Caveat/.test(html), 'Caveat must be loaded from Google Fonts');
console.log('✓ The printed signature asks for Ernie, then Caveat (loaded from Google Fonts), then script fallbacks');

console.log('\nALL SIGNATURE FONT TESTS PASSED');
process.exit(0);
