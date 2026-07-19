// SSRF guard for operator-supplied outbound URLs (settings.webhookUrl).
//
// A tenant can set any URL and the server will POST full call payloads to it —
// transcripts, phone numbers, recording links. Without this check that URL can
// point at loopback, the Railway private network, or cloud metadata endpoints,
// turning our own server into a proxy for reading internal services.
//
// Two layers, because either alone is bypassable:
//   1. isSafeUrl()      — cheap syntactic check at WRITE time (settings PATCH),
//                         so the operator gets an immediate, explainable error.
//   2. assertSafeUrl()  — resolves DNS at SEND time, because a hostname that
//                         looked public at write time can later resolve to
//                         127.0.0.1 (DNS rebinding), and because a redirect
//                         chain can land somewhere private.
const dns = require('node:dns').promises;
const net = require('node:net');

// Blocked IPv4 ranges, as [network, maskBits].
const V4_BLOCKS = [
  ['0.0.0.0', 8],        // "this" network
  ['10.0.0.0', 8],       // RFC1918 private
  ['100.64.0.0', 10],    // CGNAT — Railway/Fly internal meshes live here
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local + cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],    // RFC1918 private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.168.0.0', 16],   // RFC1918 private
  ['198.18.0.0', 15],    // benchmarking
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved
];

const v4ToInt = (ip) => ip.split('.').reduce((n, o) => (n << 8 >>> 0) + Number(o), 0) >>> 0;

function isPrivateV4(ip) {
  const addr = v4ToInt(ip);
  return V4_BLOCKS.some(([net_, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (addr & mask) >>> 0 === (v4ToInt(net_) & mask) >>> 0;
  });
}

function isPrivateV6(ip) {
  const a = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (a === '::' || a === '::1') return true;              // unspecified / loopback
  if (a.startsWith('fe80')) return true;                   // link-local
  if (/^f[cd]/.test(a)) return true;                       // unique-local fc00::/7
  // IPv4-mapped (::ffff:127.0.0.1) — judge by the embedded v4 address.
  const m = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (m) return isPrivateV4(m[1]);
  return false;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (net.isIPv6(ip)) return isPrivateV6(ip);
  return true;                                             // unparseable → refuse
}

// Syntactic check — no DNS. Safe to call on user input in a request handler.
// Returns { ok: true } or { ok: false, reason }.
function isSafeUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return { ok: false, reason: 'رابط غير صالح' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: 'يجب أن يبدأ الرابط بـ http أو https' };
  }
  // Non-standard ports are the usual way to reach an internal admin service.
  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443) {
    return { ok: false, reason: 'يُسمح فقط بالمنفذ 80 أو 443' };
  }
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    return { ok: false, reason: 'العناوين الداخلية غير مسموح بها' };
  }
  // A literal IP can be judged immediately; a hostname waits for send-time DNS.
  if (net.isIP(host) && isPrivateAddress(host)) {
    return { ok: false, reason: 'العناوين الداخلية غير مسموح بها' };
  }
  return { ok: true };
}

// Send-time check: resolves the hostname and refuses if ANY answer is private.
// Throws on failure so callers can treat it like any other delivery error.
async function assertSafeUrl(raw) {
  const syntactic = isSafeUrl(raw);
  if (!syntactic.ok) throw new Error(`blocked url: ${syntactic.reason}`);
  const host = new URL(String(raw)).hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return true;                         // already validated above
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (e) {
    throw new Error(`blocked url: dns lookup failed (${e.code || e.message})`);
  }
  if (!addrs.length) throw new Error('blocked url: host does not resolve');
  for (const { address } of addrs) {
    if (isPrivateAddress(address)) {
      throw new Error(`blocked url: resolves to a private address (${address})`);
    }
  }
  return true;
}

module.exports = { isSafeUrl, assertSafeUrl, isPrivateAddress };
