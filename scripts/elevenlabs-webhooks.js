// Register (or re-point) the two ElevenLabs webhooks this server answers.
//
//   node scripts/elevenlabs-webhooks.js --url https://<host>
//   node scripts/elevenlabs-webhooks.js --url https://<host> --recreate
//   node scripts/elevenlabs-webhooks.js --show
//
// Exists as a script because a local tunnel's hostname changes every restart,
// and every change has to be applied in TWO places that fail differently:
//
//   post-call  → a workspace webhook resource (HMAC-signed, secret issued once
//                at creation and never retrievable again)
//   initiation → convai settings (NOT signed — authenticated by a constant
//                header, because that is the only mechanism its config carries)
//
// Verified against the live API on 2026-09-19. Prints the values to put in
// .env; never prints the API key.
require('dotenv').config({ quiet: true });
const crypto = require('crypto');

const API_BASE = (process.env.ELEVENLABS_API_BASE || 'https://api.elevenlabs.io').replace(/\/+$/, '');
const POST_CALL_NAME = 'smart-assistant:post-call';
// Must match INIT_TOKEN_HEADER in services/voice/elevenlabs.js.
const INIT_HEADER = 'x-elevenlabs-init-token';
// 'audio' is deliberately absent: post_call_audio payloads exceed the 2 MB
// request-body limit this server accepts, so enabling it would make every
// delivery fail with a 413.
const POST_CALL_EVENTS = ['transcript', 'call_initiation_failure'];

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}
const args = parseArgs(process.argv);

function apiKey() {
  const k = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!k) { console.error('ELEVENLABS_API_KEY is not set'); process.exit(1); }
  return k;
}

async function api(method, path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'xi-api-key': apiKey(), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  if (!res.ok) {
    const d = json?.detail;
    const msg = Array.isArray(d)
      ? d.map((e) => `${(e.loc || []).join('.')}: ${e.msg}`).join('; ')
      : (d?.message || text);
    throw new Error(`[${res.status}] ${String(msg).slice(0, 400)}`);
  }
  return json;
}

// The secret is returned ONLY at creation, so it can never be recovered for an
// existing webhook — hence --recreate rather than a silent reuse that would
// leave .env holding a stale value.
const nameOf = (w) => w?.name || w?.settings?.name || '';

async function showCurrent() {
  const list = await api('GET', '/v1/workspace/webhooks');
  const settings = await api('GET', '/v1/convai/settings');
  console.log('\n  workspace webhooks:');
  for (const w of (list?.webhooks || [])) {
    console.log(`    ${w.webhook_id || w.id}  ${nameOf(w) || '(unnamed)'}  ${w.webhook_url || w.settings?.webhook_url || ''}`);
  }
  if (!(list?.webhooks || []).length) console.log('    (none)');
  console.log('\n  convai settings:');
  console.log(`    post_call_webhook_id : ${settings?.webhooks?.post_call_webhook_id || '(unset)'}`);
  console.log(`    events               : ${JSON.stringify(settings?.webhooks?.events || [])}`);
  console.log(`    send_audio           : ${settings?.webhooks?.send_audio}`);
  const init = settings?.conversation_initiation_client_data_webhook;
  console.log(`    init webhook url     : ${init?.url || '(unset)'}`);
  console.log(`    init header names    : ${init ? JSON.stringify(Object.keys(init.request_headers || {})) : '(unset)'}`);
  console.log('');
}

async function main() {
  if (args.show) return showCurrent();

  const base = String(args.url || process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(base)) {
    console.error('--url must be the public HTTPS base URL of this server (no trailing slash).');
    console.error('ElevenLabs cannot reach http:// or localhost — use the tunnel hostname.');
    process.exit(1);
  }

  const postCallUrl = `${base}/webhook/elevenlabs`;
  const initUrl     = `${base}/webhook/elevenlabs/init`;

  // ── 1. post-call webhook ────────────────────────────────────────
  const list = await api('GET', '/v1/workspace/webhooks');
  const existing = (list?.webhooks || []).find((w) => nameOf(w) === POST_CALL_NAME);

  let webhookId = existing?.webhook_id || existing?.id || null;
  let webhookSecret = null;

  if (existing && args.recreate) {
    await api('DELETE', `/v1/workspace/webhooks/${webhookId}`);
    console.log(`  deleted previous post-call webhook ${webhookId}`);
    webhookId = null;
  }

  if (!webhookId) {
    const created = await api('POST', '/v1/workspace/webhooks', {
      name: POST_CALL_NAME,
      settings: { auth_type: 'hmac', name: POST_CALL_NAME, webhook_url: postCallUrl },
    });
    webhookId     = created.webhook_id;
    webhookSecret = created.webhook_secret;
    console.log(`  created post-call webhook ${webhookId}`);
  } else {
    console.log(`  reusing post-call webhook ${webhookId} (its secret cannot be re-read)`);
    console.log('  if the URL changed, re-run with --recreate to get a fresh secret and URL');
  }

  // ── 2. bind it, and choose which events are delivered ───────────
  await api('PATCH', '/v1/convai/settings', {
    webhooks: {
      post_call_webhook_id: webhookId,
      events: POST_CALL_EVENTS,
      send_audio: false,
    },
  });
  console.log(`  bound post-call webhook → events ${JSON.stringify(POST_CALL_EVENTS)}, send_audio=false`);

  // ── 3. initiation webhook ───────────────────────────────────────
  // A DEDICATED token by default. Deriving it from ELEVENLABS_WEBHOOK_SECRET
  // would silently break the moment the post-call secret is rotated, and that
  // failure is invisible: calls still connect, they just lose company context.
  const initToken = (process.env.ELEVENLABS_INIT_WEBHOOK_SECRET || '').trim()
    || crypto.randomBytes(32).toString('hex');

  await api('PATCH', '/v1/convai/settings', {
    conversation_initiation_client_data_webhook: {
      url: initUrl,
      request_headers: { [INIT_HEADER]: initToken },
    },
  });
  console.log(`  set initiation webhook → ${initUrl}`);
  console.log(`  auth header            → ${INIT_HEADER}`);

  // ── 4. what to put in .env ──────────────────────────────────────
  console.log('\n  ─── put these in .env, then restart the server ───\n');
  if (webhookSecret) {
    console.log(`ELEVENLABS_WEBHOOK_SECRET=${webhookSecret}`);
  } else {
    console.log('ELEVENLABS_WEBHOOK_SECRET=  (unchanged — keep the value you already have)');
  }
  console.log(`ELEVENLABS_INIT_WEBHOOK_SECRET=${initToken}`);
  console.log(`PUBLIC_BASE_URL=${base}`);
  console.log('');
  await showCurrent();
}

main().catch((e) => { console.error('\nwebhook setup failed:', e.message); process.exit(1); });
