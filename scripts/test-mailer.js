// Outgoing mail through Microsoft Graph (the route kept open when Exchange
// Online refuses SMTP passwords): token once, then sendMail as the mailbox.
// A local fake stands in for login.microsoftonline.com and Graph.
//
//   node --test scripts/test-mailer.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const seen = [];
let sendStatus = 202;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body });
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj ? JSON.stringify(obj) : ''); };
    if (req.url === '/tenant-1/oauth2/v2.0/token') return json(200, { access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' });
    if (req.url.startsWith('/v1.0/users/')) {
      if (sendStatus !== 202) return json(sendStatus, { error: { code: 'ErrorAccessDenied', message: 'Access is denied. Check credentials and try again.' } });
      return json(202, null);
    }
    json(404, {});
  });
});

let mailer;
before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  Object.assign(process.env, {
    MS_TENANT_ID: 'tenant-1', MS_CLIENT_ID: 'client-1', MS_CLIENT_SECRET: 'secret-1',
    MS_LOGIN_BASE: base, MS_GRAPH_BASE: base, SMTP_USER: 'info@getmasar.sa',
  });
  mailer = require('../lib/mailer');
  mailer._reset();
});
after(() => fake.close());

test('with an Entra app configured, mail goes through Graph as the mailbox', async () => {
  assert.equal(mailer.transportName(), 'graph');
  const r = await mailer.sendMail({ to: 'Billing@Maheer.sa', subject: 'فاتورة', html: '<b>153.00</b>' });
  assert.deepEqual(r, { ok: true, transport: 'graph', id: null });
  const token = seen.find((s) => s.url.endsWith('/token'));
  assert.match(token.body, /grant_type=client_credentials/);
  assert.match(token.body, /scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/);
  const send = seen.find((s) => s.url.startsWith('/v1.0/users/'));
  assert.equal(send.url, '/v1.0/users/info%40getmasar.sa/sendMail');
  assert.equal(send.auth, 'Bearer tok-1');
  const msg = JSON.parse(send.body).message;
  assert.deepEqual(msg.toRecipients, [{ emailAddress: { address: 'billing@maheer.sa' } }]);
  assert.equal(msg.body.contentType, 'HTML');
});

test('the token is reused until it nears expiry', async () => {
  const before = seen.filter((s) => s.url.endsWith('/token')).length;
  await mailer.sendMail({ to: 'a@b.sa', subject: 'x', text: 'y' });
  assert.equal(seen.filter((s) => s.url.endsWith('/token')).length, before);
});

test('a refusal comes back as a result, not an exception', async () => {
  sendStatus = 403;
  try {
    const r = await mailer.sendMail({ to: 'a@b.sa', subject: 'x', text: 'y' });
    assert.equal(r.ok, false);
    assert.match(r.error, /Access is denied/);
  } finally { sendStatus = 202; }
});

test('nobody valid to send to is said plainly', async () => {
  const r = await mailer.sendMail({ to: ['not an address'], subject: 'x', text: 'y' });
  assert.equal(r.ok, false);
  assert.match(r.error, /مستلم/);
});
