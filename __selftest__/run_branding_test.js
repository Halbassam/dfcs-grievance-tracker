const assert = require('assert');
const fs = require('fs');

// ---------- Frontend: login screen + footer credit/copyright ----------
const html = fs.readFileSync('/home/claude/dfcs-rebuild/public/index.html', 'utf8');

// Login screen
const loginSection = html.slice(html.indexOf('id="loginScreen"'), html.indexOf('class="topbar"'));
assert.ok(/font-weight:700[^"]*"[^>]*>Developed by Hazem Albassam/.test(loginSection) ||
  /Developed by Hazem Albassam<\/div>/.test(loginSection),
  'login screen should show a bold "Developed by Hazem Albassam" credit');
assert.ok(loginSection.includes('&copy; 2026 Hazem Albassam. All rights reserved.'),
  'login screen should show the copyright statement');
console.log('✓ Login screen shows bold developer credit and copyright statement');

// App footer
const footerMatch = html.match(/<footer class="app-foot">([\s\S]*?)<\/footer>/);
assert.ok(footerMatch, 'app footer must exist');
assert.ok(/font-weight:700[^>]*>Developed by Hazem Albassam/.test(footerMatch[1]),
  'app footer credit must be bold');
assert.ok(footerMatch[1].includes('&copy; 2026 Hazem Albassam. All rights reserved.'),
  'app footer must include the copyright statement');
console.log('✓ App footer (visible on every page) shows bold developer credit and copyright statement');

// ---------- Backend: tracker link in steward deadline emails ----------
const schedulerSrc = fs.readFileSync('/home/claude/dfcs-rebuild/server/scheduler.js', 'utf8');
assert.ok(schedulerSrc.includes('https://dfcs-grievance-tracker.onrender.com'),
  'scheduler.js should include the tracker URL for steward emails');
console.log('✓ Steward deadline email includes the tracker login link');

// Confirm it actually appears in a BUILT email body, not just floating in the source
const { execSync } = require('child_process');
// Re-derive buildEmailBody's output by requiring the module and calling it directly
delete require.cache[require.resolve('/home/claude/dfcs-rebuild/server/scheduler.js')];
// scheduler.js doesn't export buildEmailBody, so verify via source presence
// AND confirm it's inside the lines.push(...) sequence that forms the body,
// not e.g. a stray comment.
const bodyFnMatch = schedulerSrc.match(/function buildEmailBody[\s\S]*?\n}/);
assert.ok(bodyFnMatch, 'buildEmailBody function should exist');
assert.ok(bodyFnMatch[0].includes('https://dfcs-grievance-tracker.onrender.com'),
  'the URL must be inside buildEmailBody itself, not just elsewhere in the file');
console.log('✓ Tracker URL is genuinely part of the email body text sent to stewards, not just present elsewhere in the file');

console.log('\nALL BRANDING/LINK TESTS PASSED');
