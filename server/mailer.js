/**
 * ================================================================
 * AFSCME Council 31 — DFCS Grievance Tracker
 * Minimal SMTP client — zero npm dependencies.
 *
 * Implements just enough of the SMTP protocol to authenticate
 * with Gmail and send a plain-text email. This avoids pulling in
 * nodemailer or any other package, keeping the whole app
 * dependency-free for maximum deploy reliability.
 *
 * Gmail SMTP requires an APP PASSWORD, not your normal Gmail
 * password. To create one:
 *   1. Go to https://myaccount.google.com/security
 *   2. Turn on 2-Step Verification if it isn't on already
 *      (Gmail requires this before it will issue App Passwords)
 *   3. Go to https://myaccount.google.com/apppasswords
 *   4. Create a new App Password, name it "DFCS Tracker"
 *   5. Copy the 16-character password it gives you
 *   6. Set it as the GMAIL_APP_PASSWORD environment variable on Render
 *
 * Required environment variables on Render:
 *   GMAIL_USER          your Gmail address, e.g. you@gmail.com
 *   GMAIL_APP_PASSWORD   the 16-character App Password from step 5
 * ================================================================
 */

const tls = require("tls");
const crypto = require("crypto");

const SMTP_HOST = "smtp.gmail.com";
const SMTP_PORT = 465; // implicit TLS

/**
 * Reads one full SMTP response from the socket, which may consist
 * of multiple lines (e.g. a multi-line EHLO reply). SMTP multi-line
 * responses use "250-" for continuation lines and "250 " (space) for
 * the final line — we keep reading until we see a final line.
 *
 * Any extra bytes already received beyond the current response are
 * returned in `leftover` and a new readLine() call should query the
 * shared buffer instead of waiting on a fresh data event, otherwise
 * a fast-talking server (or local test server) can cause a deadlock.
 */
function makeLineReader(socket) {
  let buffer = "";
  let pending = [];
  let resolvers = [];

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    drain();
  });

  function drain() {
    while (true) {
      const idx = buffer.indexOf("\r\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx + 2);
      buffer = buffer.slice(idx + 2);
      if (resolvers.length) {
        // Someone is actively waiting — hand the line straight to them.
        const r = resolvers.shift();
        r(line);
      } else {
        // No one waiting yet — park the line until it's asked for.
        pending.push(line);
      }
    }
  }

  function readOneLine() {
    return new Promise((resolve) => {
      if (pending.length) {
        resolve(pending.shift());
        return;
      }
      resolvers.push(resolve);
    });
  }

  // Reads a full (possibly multi-line) SMTP response and returns
  // it as a single concatenated string, exactly like before.
  async function readResponse() {
    let full = "";
    while (true) {
      const line = await readOneLine();
      full += line;
      // Continuation lines look like "250-text"; final line looks like "250 text"
      const code = line.slice(0, 3);
      const sep = line.charAt(3);
      if (sep !== "-") break; // final line of this response
    }
    return full;
  }

  return { readResponse };
}

function sendCommand(socket, lineReader, command) {
  return new Promise((resolve, reject) => {
    socket.write(command + "\r\n", "utf8", (err) => {
      if (err) return reject(err);
      lineReader.readResponse().then(resolve).catch(reject);
    });
  });
}

function checkResponseCode(response, expectedPrefix) {
  if (!response.startsWith(expectedPrefix)) {
    throw new Error(`SMTP server returned unexpected response: ${response.trim()}`);
  }
}

/**
 * Sends a plain-text email via Gmail's SMTP server.
 * Returns { ok: true } on success, throws on any failure.
 *
 * `host`, `port`, and `useTLS` are overridable for local testing
 * against a fake SMTP server; production calls always use the
 * Gmail defaults and never need to pass them.
 */
function sendMail({ user, appPassword, to, subject, text, host, port, useTLS }) {
  const targetHost = host || SMTP_HOST;
  const targetPort = port || SMTP_PORT;
  const tlsEnabled = useTLS !== false;

  return new Promise((resolve, reject) => {
    const connectFn = tlsEnabled
      ? (cb) => tls.connect(targetPort, targetHost, { servername: targetHost }, cb)
      : (cb) => require("net").connect(targetPort, targetHost, cb);

    const socket = connectFn(async () => {
      const lineReader = makeLineReader(socket);
      try {
        let response = await lineReader.readResponse(); // server greeting
        checkResponseCode(response, "220");

        response = await sendCommand(socket, lineReader, `EHLO ${SMTP_HOST}`);
        checkResponseCode(response, "250");

        response = await sendCommand(socket, lineReader, "AUTH LOGIN");
        checkResponseCode(response, "334");

        const userB64 = Buffer.from(user, "utf8").toString("base64");
        response = await sendCommand(socket, lineReader, userB64);
        checkResponseCode(response, "334");

        const passB64 = Buffer.from(appPassword, "utf8").toString("base64");
        response = await sendCommand(socket, lineReader, passB64);
        checkResponseCode(response, "235"); // 235 = authentication successful

        response = await sendCommand(socket, lineReader, `MAIL FROM:<${user}>`);
        checkResponseCode(response, "250");

        response = await sendCommand(socket, lineReader, `RCPT TO:<${to}>`);
        checkResponseCode(response, "250");

        response = await sendCommand(socket, lineReader, "DATA");
        checkResponseCode(response, "354");

        // Escape lines that start with a lone "." per SMTP spec
        const safeBody = text.replace(/\r\n\.\r\n/g, "\r\n..\r\n");
        const headers =
          `From: ${user}\r\n` +
          `To: ${to}\r\n` +
          `Subject: ${subject}\r\n` +
          `Content-Type: text/plain; charset=utf-8\r\n` +
          `\r\n`;
        const fullMessage = headers + safeBody + "\r\n.";

        response = await sendCommand(socket, lineReader, fullMessage);
        checkResponseCode(response, "250");

        await sendCommand(socket, lineReader, "QUIT");
        socket.end();
        resolve({ ok: true });
      } catch (err) {
        socket.destroy();
        reject(err);
      }
    });

    socket.once("error", (err) => reject(err));

    // Safety timeout — never hang forever on a stalled connection
    socket.setTimeout(20000, () => {
      socket.destroy();
      reject(new Error("SMTP connection timed out"));
    });
  });
}

module.exports = { sendMail };
