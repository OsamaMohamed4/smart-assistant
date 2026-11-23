// Deterministic price lookup for the WhatsApp agent.
//
// Pinpointing one unit's price among many near-identical units through the RAG
// knowledge base is unreliable: a follow-up like "كم سعر A-3" loses the project
// context, and the model can grab a sibling unit's price (A-3 vs B-3). This
// tool removes the guessing: given a project, it reads that project's page from
// the company's OWN website AT QUERY TIME and returns its units with EXACT
// current prices, pre-formatted. The agent is told to forward the result
// verbatim — the numbers come from the site's own data, never from the model.
//
// Tuned for the maheer.sa structure (Laravel + Inertia: props.data.realEstates
// for the listing, props.data.units for a project). A site that does not match
// yields a graceful fallback (project link + offer to raise a request), so the
// agent never states a made-up number.

const { isSafeUrl } = require('../../lib/ssrf');
const { embeddedData } = require('../../lib/site-crawler');

const TOOL_NAME = 'project_units';
const TIMEOUT_MS = 12000;
const UA = 'MasarBot/1.0 (+https://getmasar.sa)';
const CACHE_MS = 30 * 60 * 1000;           // project→slug map rarely changes
const cache = new Map();                   // origin -> { at, cards }

const siteOrigin = (company) => {
  const u = company?.settings?.kbSite?.url;
  if (!u) return null;
  try { return new URL(u).origin; } catch { return null; }
};

async function fetchData(url) {
  if (!isSafeUrl(url).ok) return null;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'ar,en;q=0.8' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return embeddedData(await res.text());
}

// Match keys: drop spaces/dashes/underscores, upper-case; and the plain number.
const norm = (s) => String(s || '').replace(/[\s\-_]/g, '').toUpperCase();
const digits = (s) => { const m = String(s || '').match(/\d+/); return m ? String(parseInt(m[0], 10)) : ''; };

// Every project card on the site's listing pages → { code, slug, region, type, status, price }.
async function listCards(origin) {
  const c = cache.get(origin);
  if (c && Date.now() - c.at < CACHE_MS) return c.cards;
  const cards = [];
  const seen = new Set();
  for (const path of ['/real-estates', '/real-estates?page=2', '/real-estates?page=3', '/real-estates?page=4']) {
    let props;
    try { props = await fetchData(origin + path); } catch { props = null; }
    const re = props?.data?.realEstates;
    const list = Array.isArray(re) ? re : (re?.data || []);
    if (!list.length) break;
    for (const card of list) {
      if (!card || !card.slug || seen.has(card.slug)) continue;
      seen.add(card.slug);
      cards.push({
        code: card.projectCode || card.project_code || '',
        slug: card.slug,
        region: card.region || '',
        type: card.typeText || card.type_text || card.category || '',
        status: card.statusText || card.status_text || card.status || '',
        price: card.price || '',
      });
    }
  }
  if (cards.length) cache.set(origin, { at: Date.now(), cards });
  return cards;
}

function matchCard(cards, query) {
  const q = norm(query);
  const qd = digits(query);
  return cards.find((c) => norm(c.code) === q)                               // M-17 / mhyr…
    || (qd && cards.find((c) => digits(c.code) === qd && /\d/.test(c.code))) // "17" / "مهير 17"
    || cards.find((c) => c.region && (norm(c.region).includes(q) || (q.length >= 3 && norm(c.region).includes(q)))) // حي
    || null;
}

function formatUnits(units) {
  const lines = [];
  for (const u of units) {
    const name = u.name_with_building || u.name || '';
    if (!name) continue;
    const price = u.priceBeforeTaxFormated
      || (u.price_before_tax ? Number(u.price_before_tax).toLocaleString('en-US') : '');
    const area = u.total_area || u.area || '';
    const status = u.status_text || u.statusText || u.status || '';
    lines.push(`• ${name}${area ? ` — ${area} م²` : ''}${price ? ` — ${price} ريال` : ' — السعر غير محدد'}${status ? ` — ${status}` : ''}`);
  }
  return lines;
}

// The project's three real links, built from the site's own data — never
// composed from a pattern (which is how the model used to invent dead links).
function buildLinks(origin, slug, re) {
  const out = [`رابط صفحة المشروع: ${origin}/real-estates/${slug}`];
  const b = String(re?.brochure || '').trim();
  if (b) out.push(`رابط البروشور: ${/^https?:\/\//i.test(b) ? b : origin + (b.startsWith('/') ? '' : '/') + b}`);
  const lat = re?.latitude, lng = re?.longitude;
  if (lat != null && lng != null && lat !== '' && lng !== '') out.push(`رابط قوقل ماب: https://www.google.com/maps?q=${lat},${lng}`);
  return out.join('\n');
}

const FALLBACK = 'تعذّر جلب الأسعار آلياً الآن. لا تذكر أي سعر من عندك؛ أرسل رابط المشروع إن توفّر واعرض رفع طلب اهتمام ليزوّد الفريق العميل بالتفاصيل الدقيقة.';

async function runTool(name, argsJson, { company }, deps) {
  if (name !== TOOL_NAME) return { result: null, unknown: true };
  const origin = siteOrigin(company);
  if (!origin) return { result: FALLBACK };
  let args; try { args = JSON.parse(argsJson || '{}'); } catch { args = {}; }
  const project = String(args.project || '').trim();
  if (!project) return { result: 'اطلب من العميل اسم أو كود المشروع أولاً.' };
  try {
    const cards = await listCards(origin);
    const card = matchCard(cards, project);
    if (!card) {
      return { result: `لم أجد مشروعاً مطابقاً لـ«${project}» في الموقع. لا تخترع سعراً ولا تنفِ وجوده — اعرض رفع طلب اهتمام ليتحقق الفريق.` };
    }
    const pageUrl = `${origin}/real-estates/${card.slug}`;
    const props = await fetchData(pageUrl);
    const u = props?.data?.units;
    const list = Array.isArray(u) ? u : (u?.data || []);
    const lines = formatUnits(list);
    const links = buildLinks(origin, card.slug, props?.data?.realEstate);
    const name = `مشروع ${card.code}${card.region ? ` — ${card.region}` : ''}`;
    if (!lines.length) {
      const base = card.price ? `يبدأ من ${card.price} ريال. ` : '';
      return { result: `${name}${card.status ? ` (${card.status})` : ''}. ${base}\n\nالروابط (أرسلها كما هي حرفياً، وممنوع تأليف أي رابط):\n${links}\nأرسل هذا للعميل كما هو، ولا تذكر سعر وحدة محددة من عندك.` };
    }
    const header = `أسعار وحدات ${name} (محدّثة الآن من موقع الشركة):`;
    return {
      result: `${header}\n${lines.join('\n')}\n\nالروابط (أرسلها كما هي حرفياً، وممنوع تأليف أي رابط):\n${links}\n\n⚠️ أرسل الأسعار والروابط للعميل كما هي حرفياً دون تغيير أي رقم أو رابط أو خلط بين الوحدات. إن سأل عن وحدة بعينها، انسخ سطرها بالضبط.`,
    };
  } catch (e) {
    deps?.logger?.warn?.('project_units lookup failed', { err: e.message, companyId: company?.id });
    return { result: FALLBACK };
  }
}

function toolFor() {
  return {
    type: 'function',
    function: {
      name: TOOL_NAME,
      description: 'يجلب وحدات المشروع بأسعارها الحالية الدقيقة (الكود، المساحة، السعر، الحالة) مباشرةً من موقع الشركة لحظة السؤال. استدعِ هذه الأداة وجوباً عند أي سؤال عن سعر وحدة أو أسعار مشروع أو توفّر وحداته، ولا تذكر أي سعر من ذاكرتك أو من المعرفة قبل استدعائها. بعد استدعائها أرسل ناتجها للعميل كما هو حرفياً دون تغيير أي رقم.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'كود المشروع (مثل M-17) أو اسمه أو حيّه، كما يُفهم من رسالة العميل أو سياق المحادثة' },
          unit: { type: 'string', description: 'كود الوحدة إن حدّده العميل مثل A-3 (اختياري)' },
        },
        required: ['project'],
      },
    },
  };
}

// Only sites this tool can actually read (Laravel + Inertia, as maheer.sa is)
// get the tool. Other sites — e.g. wakan.sa, which is server-rendered with no
// embedded JSON — would only ever get the "not found" fallback, so the tool is
// not offered there and those companies answer prices from their knowledge
// base. Extend via PROJECT_UNITS_HOSTS (comma-separated) as more sites qualify.
const SUPPORTED_HOSTS = String(process.env.PROJECT_UNITS_HOSTS || 'maheer.sa')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function supportsSite(company) {
  const o = siteOrigin(company);
  if (!o) return false;
  try {
    const host = new URL(o).hostname.replace(/^www\./, '').toLowerCase();
    return SUPPORTED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch { return false; }
}

const toolsFor = (company) => (supportsSite(company) ? [toolFor()] : []);

module.exports = { TOOL_NAME, toolsFor, toolFor, runTool, supportsSite };
