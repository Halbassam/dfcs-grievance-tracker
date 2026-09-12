// Self-test: role-based access to the AI grievance-drafting bot.
// Pure permission-logic check — no DB, no network. Confirms admin and
// steward_plus can use the bot and plain steward cannot, matching the
// server-side guard on /api/grievance-draft/chat.
const assert = require('assert');
const path = require('path');

process.env.PORT = '0'; // ephemeral port so this doesn't collide with a real deployment
delete require.cache[path.resolve(__dirname, '../server/index.js')];
const { isAdmin, canUseBot } = require('../server/index.js');

let checks = 0;
function check(label, cond){
  checks++;
  if(!cond){ console.error(`FAIL: ${label}`); process.exitCode = 1; }
  else console.log(`ok - ${label}`);
}

check('admin can use the bot', canUseBot({ role: 'admin' }) === true);
check('steward_plus can use the bot', canUseBot({ role: 'steward_plus' }) === true);
check('plain steward cannot use the bot', canUseBot({ role: 'steward' }) === false);
check('no user (logged out) cannot use the bot', canUseBot(null) === false);
check('unknown/garbage role cannot use the bot', canUseBot({ role: 'something_else' }) === false);

check('isAdmin still true only for admin', isAdmin({ role: 'admin' }) === true);
check('isAdmin false for steward_plus (steward_plus is not a full admin)', isAdmin({ role: 'steward_plus' }) === false);
check('isAdmin false for steward', isAdmin({ role: 'steward' }) === false);

console.log(`\n${checks} checks run.`);
if (process.exitCode) {
  console.error('SELF-TEST FAILED');
} else {
  console.log('ALL SELF-TESTS PASSED');
}
process.exit(process.exitCode || 0);
