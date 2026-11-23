const assert = require('assert');
const path = require('path');

// Who each email appears to come from. Grievance emails carry the grievance tracker's
// name. Newsletters, union notices and member-contact emails carry the union's name.
// The mail service and database are stubbed.

const sent = [];
const mailerPath = path.resolve(__dirname, '..', 'server/mailer.js');
require.cache[mailerPath] = { id: mailerPath, filename: mailerPath, loaded: true, exports: {
  GRIEVANCE_SENDER_NAME: 'FCRC Grievance Tracker',
  sendMail: async (args) => { sent.push(args); return { ok: true }; } } };

const people = [
  { id: 'p1', location: 'NorthSide FCRC', legalName: 'Ann Lee', email: 'ann@x.gov', unsubscribeToken: 'a'.repeat(32) },
  { id: 'p2', location: 'NorthSide FCRC', legalName: 'Dee Ward', email: 'dee@state.gov', unsubscribeToken: 'b'.repeat(32) }
];
const dbPath = path.resolve(__dirname, '..', 'server/db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: {
  getOrgLocalNo: async () => '2858',
  logEmailAttempt: async () => {},
  logMemberMail: async () => {},
  getNewsletterCopyEmail: async () => 'copy@x.gov',
  getRecordKeepingEmail: async () => '',
  getLocationList: async () => ['NorthSide FCRC', 'North Suburban FCRC'],
  getNewsletterRecipients: async () => people.slice(0, 1),
  getNoticeRecipients: async () => people.slice(1),
  createNewsletterRecord: async () => 'rec1',
  updateNewsletterProgress: async () => {},
  finishNewsletterRecord: async () => {},
  purgeOldNewsletters: async () => {},
  createContactUpdateLink: async () => ({ token: 'c'.repeat(48), sentTo: 'ann@x.gov', legalName: 'Ann Lee' }),
  expireContactUpdateLink: async () => {}
} };
process.env.BREVO_API_KEY = 'test-key';
process.env.BREVO_SENDER_EMAIL = 'noreply@example.gov';
process.env.NEWSLETTER_TEST_EMAIL = 'tester@example.gov';

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const grievantNotify = require(path.resolve(__dirname, '..', 'server/grievantNotify.js'));
  const nl = require(path.resolve(__dirname, '..', 'server/newsletter.js'));
  const contactUpdate = require(path.resolve(__dirname, '..', 'server/contactUpdate.js'));
  const UNION_REPLY = 'local2858fcrc@gmail.com';

  // Grievance-related: the grievance tracker's name.
  sent.length = 0;
  await grievantNotify.sendGrievantStepNotifications({ id: 'G-1', employee: 'Pat Doe', grievantEmail: 'pat@x.gov' }, { step1: true, step2: false, step3: false });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].senderName, 'FCRC Grievance Tracker', 'a grievance step notice is from the grievance tracker');
  console.log('✓ Grievance step notices come from "FCRC Grievance Tracker"');

  // Newsletter: the union's name, with the location.
  sent.length = 0;
  const started = await nl.startNewsletter({ kind: 'newsletter', subject: 'June', body: 'Hello', audience: 'location', location: 'NorthSide FCRC', addressType: 'personal', sentBy: 'admin1', baseUrl: 'https://app.example', localNo: '2858' });
  for (let i = 0; i < 40 && sent.length < started.recipients; i++) await wait(50);
  assert.ok(sent.length >= 1);
  assert.ok(/^AFSCME Local 2858/.test(sent[0].senderName) && !/Grievance/.test(sent[0].senderName), 'a newsletter is from the union: ' + sent[0].senderName);
  assert.strictEqual(sent[0].replyTo, UNION_REPLY);
  console.log('✓ Newsletters come from the union (' + sent[0].senderName + ')');

  // Union business notice: the union's name.
  sent.length = 0;
  const notice = await nl.startNewsletter({ kind: 'notice', subject: 'Vote', body: 'Friday', audience: 'location', location: 'NorthSide FCRC', addressType: 'state', reason: 'Vote notice', businessConfirm: true, sentBy: 'admin1', baseUrl: 'https://app.example', localNo: '2858' });
  for (let i = 0; i < 40 && sent.length < notice.recipients; i++) await wait(50);
  assert.ok(sent.length >= 1);
  assert.ok(/^AFSCME Local 2858/.test(sent[0].senderName) && !/Grievance/.test(sent[0].senderName), 'a union notice is from the union');
  console.log('✓ Union notices come from the union');

  // Test send: the union's name too.
  sent.length = 0;
  await nl.sendTest({ kind: 'newsletter', subject: 'Check', body: 'Hello', addressType: 'personal', baseUrl: 'https://app.example', localNo: '2858' });
  assert.ok(/^AFSCME Local 2858/.test(sent[0].senderName), 'test sends are from the union');
  console.log('✓ Test sends come from the union');

  // Member update link and confirmation: the union's name.
  sent.length = 0;
  await contactUpdate.sendUpdateLink({ submissionId: 'p1', createdBy: 'steward1', baseUrl: 'https://app.example' });
  await contactUpdate.sendChangeConfirmation({ to: 'new@x.gov', legalName: 'Ann Lee' });
  assert.strictEqual(sent.length, 2);
  assert.ok(sent.every(m => /^AFSCME Local 2858$/.test(m.senderName)), 'member update and confirmation emails are from the union');
  assert.ok(sent.every(m => m.replyTo === UNION_REPLY));
  console.log('✓ Member update and confirmation emails come from the union');

  console.log('\nALL SENDER NAME TESTS PASSED');
  process.exit(0);
})().catch(e => { console.error('\n✗ FAILED:', e.message); process.exit(1); });
