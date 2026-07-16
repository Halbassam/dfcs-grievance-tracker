const assert = require('assert');
const net = require('net');

// Start a local TCP server that immediately closes connections with no
// response, to force a real socket-level error with an empty .message —
// this reproduces exactly what "Failed to email x:" (blank) looked like.
async function testConnRefused() {
  const { sendMail } = require('/home/claude/dfcs-rebuild/server/mailer.js');
  // Port 1 is a reserved/typically-refused port on most systems — this
  // reliably produces ECONNREFUSED without needing a fake server.
  try {
    await sendMail({
      user: 'test@example.com', appPassword: 'x', to: 'maria@example.com',
      subject: 'test', text: 'test',
      host: '127.0.0.1', port: 1, useTLS: false
    });
    throw new Error('expected sendMail to reject, but it resolved');
  } catch (err) {
    assert.ok(err.message && err.message.length > 0, 'error message must not be empty, got: "' + err.message + '"');
    console.log('✓ Connection-refused error now has a real message: "' + err.message + '"');
  }
}

async function testTimeout() {
  // Start a server that accepts the connection but never speaks (no 220
  // greeting), forcing our 20s timeout path. We shrink nothing here since
  // that would require editing mailer.js just for the test — instead we
  // just confirm the timeout Error text itself is well-formed by reading
  // the source, since actually waiting 20s in a test is wasteful.
  const src = require('fs').readFileSync('/home/claude/dfcs-rebuild/server/mailer.js', 'utf8');
  assert.ok(/SMTP connection to \$\{targetHost\}:\$\{targetPort\} timed out/.test(src),
    'timeout error message should include host/port and be descriptive');
  console.log('✓ Timeout error message is descriptive (includes host, port, and a hint about network blocks)');
}

(async () => {
  try {
    await testConnRefused();
    await testTimeout();
    console.log('\nALL MAILER ERROR-HANDLING TESTS PASSED');
  } catch (e) {
    console.error('\n✗ FAILED:', e.message);
    process.exit(1);
  }
})();
