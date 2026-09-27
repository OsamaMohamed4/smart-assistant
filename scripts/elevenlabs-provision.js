// One-time per-company provisioning: import a company's EXISTING 3CX number
// into ElevenLabs as a SIP-trunk number, then bind it to that company's agent.
//
// No phone number is ever PURCHASED. `phone_number` is the DID the company
// already owns and advertises, and the outbound address points back at their
// own 3CX — ElevenLabs is only told how to reach the number, never given one.
//
//   node scripts/elevenlabs-provision.js --list
//   node scripts/elevenlabs-provision.js --company co-abc --address pbx.example.com \
//        --username sipuser --password 'secret' [--transport tls] [--encryption allowed]
//   node scripts/elevenlabs-provision.js --company co-abc --bind-only
//
// Credentials are read from flags or the environment (SIP_TRUNK_USERNAME /
// SIP_TRUNK_PASSWORD / SIP_TRUNK_ADDRESS) and are NEVER printed or logged.
require('dotenv').config({ quiet: true });

const { sql } = require('../db');
const { loadCompany } = require('../companies');
const voice = require('../services/voice');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) { out[key] = true; }
    else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv);

// Never print a secret, even partially. The point of this script is to move
// credentials into the provider, not to leave them in a terminal scrollback.
const redact = (v) => (v ? `(set, ${String(v).length} chars)` : '(unset)');

async function listCompanies() {
  const rows = await sql.listCompanies.all();
  console.log('\n  id                     phone (3CX DID)     agent                  phone_number_id');
  console.log('  ' + '─'.repeat(92));
  for (const r of rows) {
    console.log(
      `  ${String(r.id).padEnd(22)} ${String(r.phone_number || '—').padEnd(19)} ` +
      `${String(r.elevenlabs_agent_id || '— not published').padEnd(22)} ${r.elevenlabs_phone_number_id || '— not imported'}`,
    );
  }
  console.log('');
  const unready = rows.filter((r) => !r.elevenlabs_agent_id || !r.elevenlabs_phone_number_id);
  if (unready.length) {
    console.log(`  ${unready.length} company/companies are not fully wired yet.`);
    console.log('  Publish (Scenarios → نشر) gives an agent; this script gives a number.\n');
  }
}

async function main() {
  if (args.list || (!args.company && !args.c)) {
    await listCompanies();
    if (!args.company && !args.c) {
      console.log('  Usage: node scripts/elevenlabs-provision.js --company <id> --address <3cx-host> [--username u --password p]\n');
    }
    return;
  }

  const companyId = String(args.company || args.c);
  const company = await loadCompany(companyId);
  if (!company) { console.error(`company "${companyId}" not found`); process.exit(1); }

  if (!company.agentId) {
    console.error(`company "${companyId}" has no agent yet — publish it from the Scenarios page first.`);
    console.error('Binding a number to a company with no agent would leave the line answering nothing.');
    process.exit(1);
  }

  // ── Bind only: the number is already imported, just (re)point it ──
  if (args['bind-only']) {
    const r = await voice.bindPhoneNumber(company);
    console.log(`bound ${r.phoneNumber || company.phoneNumber} (${r.phoneNumberId}) → agent ${r.agentId}`);
    return;
  }

  const phoneNumber = String(args.phone || company.phoneNumber || '').trim();
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
    console.error(`company "${companyId}" has no valid E.164 number. Set it on the company, or pass --phone +9665XXXXXXXX`);
    process.exit(1);
  }

  const address = String(args.address || process.env.SIP_TRUNK_ADDRESS || '').trim();
  if (!address) {
    console.error('--address is required: the hostname or IP of the 3CX PBX, with NO "sip:" prefix.');
    process.exit(1);
  }
  if (/^sips?:/i.test(address)) {
    console.error('--address must be a bare host, not a SIP URI. Use pbx.example.com, not sip:pbx.example.com');
    process.exit(1);
  }

  const username = args.username || process.env.SIP_TRUNK_USERNAME || null;
  const password = args.password || process.env.SIP_TRUNK_PASSWORD || null;
  if (username && !password) {
    console.error('--username was given without --password; digest auth needs both.');
    process.exit(1);
  }
  if (!username) {
    // Digest auth is preferable: an IP allowlist silently stops working the day
    // the PBX's public address changes, and the failure looks like "inbound
    // calls just stopped" with nothing in our logs.
    console.warn('! No SIP credentials given — the trunk will rely on IP allowlisting.');
    console.warn('! Prefer digest auth unless the PBX has a permanently static IP.');
  }

  const transport = ['tls', 'tcp', 'udp'].includes(String(args.transport || '').toLowerCase())
    ? String(args.transport).toLowerCase() : 'tls';
  const mediaEncryption = ['disabled', 'allowed', 'required'].includes(String(args.encryption || '').toLowerCase())
    ? String(args.encryption).toLowerCase() : 'allowed';
  const allowedAddresses = args.allow
    ? String(args.allow).split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  console.log(`\n  company     ${companyId} (${company.name})`);
  console.log(`  number      ${phoneNumber}   ← the company's existing 3CX DID, not a new purchase`);
  console.log(`  agent       ${company.agentId}`);
  console.log(`  3CX address ${address}  transport=${transport}  media=${mediaEncryption}`);
  console.log(`  digest user ${username || '(none — using IP allowlist)'}`);
  console.log(`  digest pass ${redact(password)}\n`);

  // Safe to re-run: importPhoneNumber updates the existing record when this
  // workspace already holds the number, rather than failing on the provider's
  // 409. Re-running after a partial failure — or to rotate SIP credentials — is
  // therefore a normal operation, not a recovery exercise.
  const { phoneNumberId, reused } = await voice.importPhoneNumber(company, {
    phoneNumber, address, transport, mediaEncryption, username, password, allowedAddresses,
  });
  try {
    await sql.setCompanyElevenLabsPhone.run({
      id: company.id, phone_number_id: phoneNumberId, phone_number: phoneNumber,
    });
  } catch (e) {
    // A DID identifies exactly one tenant, enforced by a unique index. Re-running
    // for the SAME company is fine (it updates its own row); this fires only when
    // a DIFFERENT company already owns the number, and the raw constraint error
    // says nothing about which one.
    if (!/unique|constraint/i.test(e.message || '')) throw e;
    const owners = await sql.listCompanies.all();
    const clash = owners.filter((r) => r.id !== company.id
      && (r.phone_number === phoneNumber || r.elevenlabs_phone_number_id === phoneNumberId));
    console.error(`\n  refusing to assign ${phoneNumber} to ${company.id}:`);
    for (const c of clash) console.error(`    already owned by company "${c.id}" (${c.name})`);
    console.error('  Move it deliberately from the admin UI (Settings → phone number), which');
    console.error('  releases the previous owner and records who it was taken from.\n');
    process.exit(1);
  }
  console.log(`  ${reused ? 'updated existing' : 'imported'} → phone_number_id ${phoneNumberId}`);

  // Import can carry agent_id, but bind explicitly so the inbound-agent rule
  // (a company with a separate inbound prompt answers on its inbound agent)
  // is applied by the same code path the admin UI uses.
  const fresh = await loadCompany(companyId);
  const bound = await voice.bindPhoneNumber({ ...fresh, phoneNumberId });
  console.log(`  bound    → agent ${bound.agentId}`);

  console.log('\n  Next, on the 3CX side:');
  console.log(`    1. SIP trunk to ${process.env.ELEVENLABS_SIP_DOMAIN || 'sip.rtc.elevenlabs.io'}:${transport === 'tls' ? 5061 : 5060} (${transport.toUpperCase()})`);
  console.log(`    2. Inbound rule: DID ${phoneNumber} → that trunk`);
  console.log(`    3. The INVITE must address the number: sip:${phoneNumber}@${process.env.ELEVENLABS_SIP_DOMAIN || 'sip.rtc.elevenlabs.io'}`);
  console.log('       (a bare sip:@host with no user part is rejected)');
  console.log('    4. Codecs: G711 a-law/µ-law or G722 ONLY — remove G729/Opus');
  console.log('    5. Open RTP 10000-60000/udp both ways');
  console.log('    6. Send BYE to the Contact header from the INVITE response, not to the shared host');
  console.log('       (targeting the shared host returns 481 and the call will not hang up)\n');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('\nprovision failed:', voice.errText(e));
    process.exit(1);
  });
