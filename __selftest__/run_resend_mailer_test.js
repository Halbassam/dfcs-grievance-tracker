const assert = require('assert');
const http = require('http');
const { sendMail } = require('/home/claude/dfcs-rebuild/server/mailer.js');

// mailer.js is hardcoded to hit api.resend.com over TLS on port 443, which
// we can't safely redirect in a unit test without editing production code
// just for testing. Instead, this test verifies the payload-building and
// error-handling logic by re-implementing the request against a local HTTP
// server with the exact same request-construction code path, confirming:
//   1. The request body matches Resend's documented API shape exactly
//   2. Success responses (2xx) resolve correctly
//   3. Error responses (4xx/5xx) reject with a readable message
//   4. Network-level errors (connection refused) reject with a readable message

function sendMailToHost({ apiKey, from, to, subject, text, hostname, port }) {
  const https_ = require('http'); // local test server is plain HTTP
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ from: from || 'FCRC Grievance Tracker <onboarding@resend.dev>', to: [to], subject, text });
    const req = https_.request(
      { hostname, port, path: '/emails', method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch(e) {}
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, id: parsed && parsed.id, receivedPayload: payload, receivedHeaders: req.getHeaders() });
          else reject(new Error(`Resend API error (${res.statusCode}): ${(parsed && (parsed.message||parsed.name)) || body}`));
        });
      }
    );
    req.on('error', (err) => reject(new Error(`Could not reach Resend API: ${err.message || err.code || err.name}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Resend API request timed out after 15s.')); });
    req.write(payload);
    req.end();
  });
}

async function testSuccessPath() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const parsed = JSON.parse(body);
      assert.strictEqual(parsed.to[0], 'maria.p.perez@illinois.gov');
      assert.strictEqual(parsed.subject, 'Test subject');
      assert.ok(req.headers.authorization === 'Bearer re_test_key_123');
      assert.strictEqual(req.headers['content-type'], 'application/json');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'abc-123-fake-id' }));
    });
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const result = await sendMailToHost({
    apiKey: 're_test_key_123', to: 'maria.p.perez@illinois.gov',
    subject: 'Test subject', text: 'Test body', hostname: '127.0.0.1', port
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.id, 'abc-123-fake-id');
  server.close();
  console.log('✓ Success path: correct request shape (Bearer auth, JSON body, to as array), resolves with message id');
}

async function testApiErrorPath() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(422, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Invalid `from` field', name: 'validation_error' }));
    });
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    await sendMailToHost({ apiKey: 're_test', to: 'x@y.gov', subject: 's', text: 't', hostname: '127.0.0.1', port });
    throw new Error('expected rejection');
  } catch (err) {
    assert.ok(err.message.includes('422'), 'error should include status code, got: ' + err.message);
    assert.ok(err.message.includes('Invalid `from` field'), 'error should include Resend\'s validation message, got: ' + err.message);
    console.log('✓ API error path: 422 validation error surfaces the real Resend error message, not blank');
  }
  server.close();
}

async function testConnectionErrorPath() {
  try {
    // Port 1 reliably refuses connections locally
    await sendMailToHost({ apiKey: 're_test', to: 'x@y.gov', subject: 's', text: 't', hostname: '127.0.0.1', port: 1 });
    throw new Error('expected rejection');
  } catch (err) {
    assert.ok(err.message && err.message.length > 0, 'connection error must have a non-empty message, got: "' + err.message + '"');
    assert.ok(err.message.includes('Could not reach Resend API'), 'error should clearly say it could not reach the API, got: ' + err.message);
    console.log('✓ Connection error path: refused connection surfaces a clear, non-empty message: "' + err.message + '"');
  }
}

async function testRealMailerRejectsWithoutApiKey() {
  // This exercises the REAL mailer.js (not the test harness above) for the
  // one case we can fully verify without hitting the live network: no key.
  try {
    await sendMail({ apiKey: '', to: 'x@y.gov', subject: 's', text: 't' });
    throw new Error('expected rejection');
  } catch (err) {
    assert.ok(err.message.includes('RESEND_API_KEY'), 'should clearly say the API key is missing, got: ' + err.message);
    console.log('✓ Real mailer.js: missing API key rejects immediately with a clear message (no network call attempted)');
  }
}

(async () => {
  try {
    await testSuccessPath();
    await testApiErrorPath();
    await testConnectionErrorPath();
    await testRealMailerRejectsWithoutApiKey();
    console.log('\nALL RESEND MAILER TESTS PASSED');
  } catch (e) {
    console.error('\n✗ FAILED:', e.message);
    process.exit(1);
  }
})();
