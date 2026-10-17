// Where this platform lives on the internet, from configuration only.
//
// Links that leave the server (a password-reset e-mail, an invoice) are built
// from here and NEVER from the request's Host header: a forged Host would
// otherwise put a valid reset token inside a link to someone else's site.
//
//   PUBLIC_BASE_URL  this server, for machine callbacks (falls back to the
//                    Railway domain)
//   CANONICAL_HOST   the address people use, once the company's own domain is
//                    live (getmasar.sa, no www); page views elsewhere move to it
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
).replace(/\/+$/, '');

const CANONICAL_HOST = String(process.env.CANONICAL_HOST || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/\/.*$/, '');

/** The base URL for links people open, or null when none is configured. */
function publicSiteUrl() {
  return CANONICAL_HOST ? `https://${CANONICAL_HOST}` : (PUBLIC_BASE_URL || null);
}

module.exports = { PUBLIC_BASE_URL, CANONICAL_HOST, publicSiteUrl };
