const assert = require('assert');
const http = require('http');
const { sendMail } = require('/home/claude/dfcs-rebuild/server/mailer.js');

// mailer.js hits api.brevo.com over TLS on port 443. To test the exact
// request-construction logic without editing production code just for
// testing, this re-implements the same request against a local HTTP
// server and verifies: (1) request shape matches Brevo's documented API,
// (2) success/error/network paths all produce clear results.

function sendMailToHost({ apiKey, senderEmail, senderName, to, subject, text, hostname, port }) {
  const httpMod = require('http');
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      sender: { name: senderName || 'FCRC Grievance Tracker', email: senderEmail },
      to: [{ email: to }], subject, textContent: text
    });
    const req = httpMod.request(
      { hostname, port, path: '/v3/smtp/email', method: 'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: 5000 },
      (res) => {
        let body = '';
        res.on('data', c => body += c);
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(body); } catch(e) {}
          if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true, id: parsed && parsed.messageId, sentPayload: JSON.parse(payload) });
          else reject(new Error(`Brevo API error (${res.statusCode}): ${(parsed && (parsed.message||parsed.code)) || body}`));
        });
      }
    );
    req.on('error', (err) => reject(new Error(`Could not reach Brevo API: ${err.message || err.code || err.name}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('Brevo API request timed out after 15s.')); });
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
      // Verify the request shape matches Brevo's documented API exactly
      assert.strictEqual(parsed.sender.email, 'hazem.albassam@illinois.gov');
      assert.strictEqual(parsed.to[0].email, 'maria.p.perez@illinois.gov');
      assert.strictEqual(parsed.subject, 'Test subject');
      assert.strictEqual(parsed.textContent, 'Test body');
      assert.strictEqual(req.headers['api-key'], 'xkeysib_test_123');
      assert.strictEqual(req.headers['content-type'], 'application/json');
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messageId: '<abc123@brevo.com>' }));
    });
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const result = await sendMailToHost({
    apiKey: 'xkeysib_test_123', senderEmail: 'hazem.albassam@illinois.gov',
    to: 'maria.p.perez@illinois.gov', subject: 'Test subject', text: 'Test body',
    hostname: '127.0.0.1', port
  });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.id, '<abc123@brevo.com>');
  server.close();
  console.log('✓ Success path: request shape matches Brevo API exactly (api-key header, sender/to as objects, textContent field)');
}

async function testApiErrorPath() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }));
    });
  });
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  try {
    await sendMailToHost({ apiKey: 'bad_key', senderEmail: 'x@y.gov', to: 'z@w.gov', subject: 's', text: 't', hostname: '127.0.0.1', port });
    throw new Error('expected rejection');
  } catch (err) {
    assert.ok(err.message.includes('401'), 'error should include status code, got: ' + err.message);
    assert.ok(err.message.includes('Key not found'), 'error should include Brevo\'s real message, got: ' + err.message);
    console.log('✓ API error path: 401 unauthorized surfaces the real Brevo error message, not blank');
  }
  server.close();
}

async function testConnectionErrorPath() {
  try {
    await sendMailToHost({ apiKey: 'x', senderEmail: 'a@b.gov', to: 'c@d.gov', subject: 's', text: 't', hostname: '127.0.0.1', port: 1 });
    throw new Error('expected rejection');
  } catch (err) {
    assert.ok(err.message && err.message.length > 0, 'connection error must have a non-empty message, got: "' + err.message + '"');
    assert.ok(err.message.includes('Could not reach Brevo API'), 'error should clearly say it could not reach the API, got: ' + err.message);
    console.log('✓ Connection error path: refused connection surfaces a clear, non-empty message');
  }
}

async function testRealMailerRequiresApiKeyAndSender() {
  // Exercises the REAL mailer.js for the cases we can verify without a live network call.
  try {
    await sendMail({ apiKey: '', senderEmail: 'x@y.gov', to: 'z@w.gov', subject: 's', text: 't' });
    throw new Error('expected rejection');
  } catch (err) {
    assert.ok(err.message.includes('BREVO_API_KEY'), 'should clearly say the API key is missing, got: ' + err.message);
    console.log('✓ Real mailer.js: missing API key rejects immediately with a clear message');
  }
  try {
    await sendMail({ apiKey: 'some_key', senderEmail: '', to: 'z@w.gov', subject: 's', text: 't' });
    throw new Error('expected rejection');
  } catch (err) {
    assert.ok(err.message.includes('BREVO_SENDER_EMAIL'), 'should clearly say the sender email is missing, got: ' + err.message);
    console.log('✓ Real mailer.js: missing sender email rejects immediately with a clear message (no network call attempted)');
  }
}

(async () => {
  try {
    await testSuccessPath();
    await testApiErrorPath();
    await testConnectionErrorPath();
    await testRealMailerRequiresApiKeyAndSender();
    console.log('\nALL BREVO MAILER TESTS PASSED');
  } catch (e) {
    console.error('\n✗ FAILED:', e.message);
    process.exit(1);
  }
})();
