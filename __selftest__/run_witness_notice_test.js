const assert = require('assert');
const fs = require('fs');
const path = require('path');

// The drafting bot's notice used to promise witness statements, which the app
// can't record. The wording must match what the bot actually receives.

const html = fs.readFileSync(path.resolve(__dirname, '..', 'public/index.html'), 'utf8');
assert.ok(!/employee statement, witness statements, and your logbook/.test(html), 'the bot notice must not promise witness statements');
assert.ok(/Witness statements can.t be recorded/.test(html), 'the notice should say witness statements are not recorded');
console.log('✓ The drafting bot notice describes only what the bot receives');

console.log('\nALL WITNESS NOTICE TESTS PASSED');
process.exit(0);
