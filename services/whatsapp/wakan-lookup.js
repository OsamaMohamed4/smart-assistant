// Deterministic project / price / type lookup for wakan.sa.
//
// wakan.sa is ASP.NET server-rendered (no embedded JSON like maheer), so the
// Inertia-based project-lookup.js cannot read it. This module parses wakan's
// own server HTML at query time:
//
//   • /EstateProjects                      → the full directory: every project's
//                                            TYPE (أدوار / شقق / فلل / تاون هاوس),
//                                            code (وكن NNN), region (الحي) and
//                                            number of available units.
//   • /EstateProjects/Detail/{id}          → that project's units with EXACT
//                                            current prices, status and area,
//                                            plus the brochure and Google-Maps
//                                            links.
//
// It exposes the SAME tool name as the maheer lookup (`project_units`) so the
// WhatsApp prompt and the index.js dispatch stay uniform — a given company is
// either maheer or wakan, so only one lookup ever offers the tool.
//
// Why this exists: the agent used to answer wakan prices/types from the RAG
// knowledge base, which produced "no prices from the system" and wrong types
// (every project called شقق). The site's own HTML has both, exactly, so we read
// it directly and tell the agent to forward the result verbatim.

const { isSafeUrl } = require('../../lib/ssrf');

const TOOL_NAME = 'project_units';
const TIMEOUT_MS = 9000;
const UA = 'MasarBot/1.0 (+https://getmasar.sa)';
const DIR_CACHE_MS = 30 * 60 * 1000;   // directory (types/codes) rarely changes
const UNIT_CACHE_MS = 15 * 60 * 1000;  // prices change a little more often
const MAX_PARALLEL = 12;               // cap detail fetches per tool call

const dirCache = new Map();            // origin -> { at, projects }
const unitCache = new Map();           // id    -> { at, data }

const siteOrigin = (company) => {
  const u = company?.settings?.kbSite?.url;
  if (!u) return null;
  try { return new URL(u).origin; } catch { return null; }
};

async function fetchHtml(url) {
  if (!isSafeUrl(url).ok) return null;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml', 'accept-language': 'ar,en;q=0.8' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) return null;
  return res.text();
}

// ── Parsing ────────────────────────────────────────────────────────────────

// The directory: one entry per project card on /EstateProjects.
function parseDirectory(html) {
  const chunks = String(html || '').split(/class="property-box/);
  const map = new Map();
  for (let i = 1; i < chunks.length; i++) {
    const c = chunks[i].slice(0, 2500);
    const id = (c.match(/\/EstateProjects\/Detail\/(\d+)/) || [])[1];
    if (!id || map.has(id)) continue; // the layout prints each card twice (responsive)
    const type = (c.match(/font-roboto"[^>]*>\s*([^<]+?)\s*</) || [])[1] || '';
    const code = ((c.match(/<h3[^>]*>\s*(وكن[^<]+?)\s*<\/h3>/) || [])[1] || '').replace(/\s+/g, ' ').trim();
    const region = ((c.match(/(الرياض\s*,?\s*[^<\n]{1,30})/) || [])[1] || '').replace(/\s+/g, ' ').trim();
    const avail = parseInt((c.match(/متاح[^0-9]{0,12}(\d+)/) || [])[1] || '0', 10);
    const units = parseInt((c.match(/وحدة[^0-9]{0,12}(\d+)/) || [])[1] || '0', 10);
    map.set(id, { id, type: type.trim(), code, region, avail, units });
  }
  return [...map.values()];
}

// A project's units + links from /EstateProjects/Detail/{id}.
function parseUnits(html) {
  const units = [];
  let bld = '';
  const re = /(<h3[^>]*>\s*مباني\s*([^<]+?)\s*<\/h3>)|(<a[^>]*class="[^"]*\btoggle\b[^"]*"[^>]*>([\s\S]*?)<\/a>)|(<h4[^>]*>\s*المساحة\s*\(\s*([\d.]+))/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[2] != null) { bld = m[2].trim(); continue; }
    if (m[4] != null) {
      const block = m[4].replace(/<svg[\s\S]*?<\/svg>/gi, ' '); // svg path coords are digits — drop them
      const price = (block.match(/<strong[^>]*myDIV[^>]*>\s*([\d][\d.,]*)/) || [])[1];
      if (!price) continue; // reserved / sold units carry no price
      const num = (block.match(/(\d+)\s*<strong[^>]*myDIV/) || [])[1] || '';
      const status = (block.match(/(للبيع|محجوز|مباع|تم البيع)/) || [])[1] || '';
      // apartment buildings are labelled "مباني شقق" — drop a type-word prefix,
      // keep A/B/C building letters.
      const prefix = /^(شقق|شقة|فلل|فيلا|أدوار|دور|تاون)/.test(bld) ? '' : bld;
      units.push({ code: (prefix + num).trim() || num, price: +String(price).replace(/[^\d]/g, ''), status, area: null });
      continue;
    }
    if (m[6] != null && units.length && units[units.length - 1].area == null) units[units.length - 1].area = +m[6];
  }
  const hrefs = [...String(html || '').matchAll(/href="([^"]+)"/g)].map((x) => x[1]);
  const brochure = hrefs.find((h) => /drive\.google|\.pdf($|\?)/i.test(h)) || '';
  const maps = hrefs.find((h) => /maps\.app\.goo\.gl|goo\.gl\/maps|google\.[^/]+\/maps/i.test(h)) || '';
  return { units, brochure, maps };
}

// ── Caching loaders ──────────────────────────────────────────────────────────

async function loadDirectory(origin) {
  const c = dirCache.get(origin);
  if (c && Date.now() - c.at < DIR_CACHE_MS) return c.projects;
  const html = await fetchHtml(`${origin}/EstateProjects`);
  const projects = parseDirectory(html);
  if (projects.length) dirCache.set(origin, { at: Date.now(), projects });
  return projects;
}

async function loadUnits(origin, id) {
  const c = unitCache.get(id);
  if (c && Date.now() - c.at < UNIT_CACHE_MS) return c.data;
  const html = await fetchHtml(`${origin}/EstateProjects/Detail/${id}`);
  const data = parseUnits(html || '');
  unitCache.set(id, { at: Date.now(), data });
  return data;
}

// ── Matching ─────────────────────────────────────────────────────────────────

const norm = (s) => String(s || '').replace(/[\s\-_]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').toUpperCase();
const codeNum = (s) => { const m = String(s || '').match(/\d+/); return m ? String(parseInt(m[0], 10)) : ''; };

// Which type word (if any) the customer's text refers to.
function queryType(q) {
  const n = norm(q);
  if (/تاون|تاونهاوس|TOWN/.test(n)) return 'تاون هاوس';
  if (/ادوار|دور|FLOOR/.test(n)) return 'أدوار';
  if (/شقق|شقه|APART/.test(n)) return 'شقق';
  if (/فلل|فيلا|فله|VILLA/.test(n)) return 'فلل';
  return '';
}
const sameType = (projType, want) => want && norm(projType).includes(norm(want));

// Return the projects a query refers to. Prefers an exact code (+type) match;
// otherwise a type and/or region filter; may return several.
function matchProjects(projects, query) {
  const qn = norm(query);
  const qnum = codeNum(query);
  const qtype = queryType(query);

  // 1) exact code match (optionally narrowed by type when a number is shared,
  //    e.g. وكن 047 exists as both أدوار and تاون هاوس).
  if (qnum) {
    let byNum = projects.filter((p) => codeNum(p.code) === qnum);
    if (qtype) { const t = byNum.filter((p) => sameType(p.type, qtype)); if (t.length) byNum = t; }
    if (byNum.length) return byNum;
  }
  // 2) type-only query → all projects of that type.
  if (qtype && !qnum) {
    const t = projects.filter((p) => sameType(p.type, qtype));
    if (t.length) return t;
  }
  // 3) region (حي) match, optionally narrowed by type.
  if (query && query.replace(/\s/g, '').length >= 3) {
    let byReg = projects.filter((p) => p.region && norm(p.region).includes(qn));
    if (qtype) { const t = byReg.filter((p) => sameType(p.type, qtype)); if (t.length) byReg = t; }
    if (byReg.length) return byReg;
  }
  return [];
}

// ── Formatting ────────────────────────────────────────────────────────────────

const money = (n) => Number(n).toLocaleString('en-US');
const projName = (p) => `${p.code}${p.type ? ` — ${p.type}` : ''}${p.region ? ` — ${p.region}` : ''}`;

function linkBlock(origin, p, data) {
  const out = [`رابط صفحة المشروع: ${origin}/EstateProjects/Detail/${p.id}`];
  if (data.brochure) out.push(`رابط البروشور: ${data.brochure}`);
  if (data.maps) out.push(`رابط قوقل ماب: ${data.maps}`);
  return out.join('\n');
}

function formatOneProject(origin, p, data) {
  const sale = data.units.filter((u) => u.status === 'للبيع');
  if (!sale.length) {
    return `مشروع ${projName(p)}: لا توجد وحدات متاحة للبيع حالياً (مباع بالكامل أو محجوز). لا تذكر أي سعر من عندك؛ اعرض رفع طلب اهتمام ليبلّغ الفريق العميل عند توفّر وحدات.\nرابط صفحة المشروع: ${origin}/EstateProjects/Detail/${p.id}`;
  }
  const lines = sale.map((u) =>
    `• ${u.code}${u.area ? ` — ${u.area} م²` : ''} — ${money(u.price)} ريال — ${u.status}`);
  return `أسعار وحدات مشروع ${projName(p)} (محدّثة الآن من موقع الشركة):\n${lines.join('\n')}\n\nالروابط (أرسلها كما هي حرفياً، وممنوع تأليف أي رابط):\n${linkBlock(origin, p, data)}\n\n⚠️ أرسل الأسعار والروابط للعميل كما هي حرفياً دون تغيير أي رقم أو رابط، ولا تخلط بين الوحدات. إن سأل عن وحدة بعينها انسخ سطرها بالضبط.`;
}

function formatProjectList(origin, rows) {
  const lines = rows.map(({ p, data }) => {
    const sale = data.units.filter((u) => u.status === 'للبيع');
    if (!sale.length) return `• ${projName(p)} — لا توجد وحدات متاحة حالياً`;
    const min = Math.min(...sale.map((u) => u.price));
    return `• ${p.code} — ${p.region || ''} — ${sale.length} وحدة متاحة — تبدأ من ${money(min)} ريال — ${origin}/EstateProjects/Detail/${p.id}`;
  });
  return lines.join('\n');
}

const FALLBACK = 'تعذّر جلب بيانات المشاريع آلياً الآن. لا تذكر أي سعر أو نوع من عندك؛ اعرض رفع طلب اهتمام ليزوّد الفريق العميل بالتفاصيل الدقيقة.';

// ── Tool entry ────────────────────────────────────────────────────────────────

async function runTool(name, argsJson, { company }, deps) {
  if (name !== TOOL_NAME) return { result: null, unknown: true };
  const origin = siteOrigin(company);
  if (!origin) return { result: FALLBACK };
  let args; try { args = JSON.parse(argsJson || '{}'); } catch { args = {}; }
  const project = String(args.project || '').trim();
  try {
    const projects = await loadDirectory(origin);
    if (!projects.length) return { result: FALLBACK };

    // No project given → show the directory of what's available, by type, so the
    // agent can orient the customer (types are exact; no invented prices).
    if (!project) {
      const active = projects.filter((p) => p.avail > 0);
      const byType = {};
      for (const p of active) (byType[p.type] = byType[p.type] || []).push(p);
      const sections = Object.entries(byType).map(([t, ps]) =>
        `${t} (${ps.length}): ${ps.map((p) => `${p.code}${p.region ? ` ${p.region.replace('الرياض, ', '')}` : ''}`).join('، ')}`);
      return { result: `المشاريع المتاحة حالياً في وكن حسب النوع:\n${sections.join('\n')}\n\nلعرض أسعار مشروع أو نوع معيّن اسأل عنه بالاسم أو الكود أو الحي. لا تذكر أي سعر من عندك قبل استدعاء الأداة.` };
    }

    let matched = matchProjects(projects, project);
    if (!matched.length) {
      return { result: `لم أجد مشروعاً مطابقاً لـ«${project}» في موقع وكن. لا تخترع نوعاً أو سعراً ولا تنفِ وجوده — اعرض رفع طلب اهتمام ليتحقق الفريق.` };
    }

    // Prefer projects that actually have units to sell; if all matched are
    // sold out, keep them so we can say so.
    const active = matched.filter((p) => p.avail > 0);
    const work = (active.length ? active : matched).slice(0, MAX_PARALLEL);

    const rows = await Promise.all(work.map(async (p) => {
      try { return { p, data: await loadUnits(origin, p.id) }; }
      catch { return { p, data: { units: [], brochure: '', maps: '' } }; }
    }));

    if (rows.length === 1) {
      return { result: formatOneProject(origin, rows[0].p, rows[0].data) };
    }

    const more = matched.length > work.length ? `\n\n(وهناك ${matched.length - work.length} مشروع إضافي — اطلب حياً أو كوداً أدق لعرضها.)` : '';
    const header = `مشاريع مطابقة لطلب العميل (أسعار محدّثة الآن من الموقع):`;
    return {
      result: `${header}\n${formatProjectList(origin, rows)}${more}\n\nلعرض كل وحدات مشروع معيّن وأسعارها بالتفصيل اسأل عنه بالكود أو الحي. أرسل هذا للعميل كما هو حرفياً، ولا تذكر أي سعر أو نوع من عندك.`,
    };
  } catch (e) {
    deps?.logger?.warn?.('wakan project_units lookup failed', { err: e.message, companyId: company?.id });
    return { result: FALLBACK };
  }
}

function toolFor() {
  return {
    type: 'function',
    function: {
      name: TOOL_NAME,
      description: 'يجلب مشاريع وكن وأنواعها (أدوار/شقق/فلل/تاون هاوس) ووحداتها بأسعارها الحالية الدقيقة وحالتها، وروابطها الرسمية (صفحة المشروع، والبروشور، وموقع قوقل ماب) مباشرةً من موقع الشركة لحظة السؤال. استدعِ هذه الأداة وجوباً عند أي سؤال عن نوع مشروع أو سعره أو وحداته أو توفّرها أو عن المشاريع المتاحة، وكذلك عند أي طلب لرابط مشروع أو بروشوره أو موقعه/لوكيشنه على الخريطة. ولا تذكر أي نوع أو سعر أو رابط من ذاكرتك أو من رسائل سابقة قبل استدعائها، وممنوع تأليف رابط لوكن من الكود. بعد استدعائها أرسل ناتجها (الأسعار والروابط) للعميل كما هو حرفياً دون تغيير أو تأليف أي رقم أو رابط.',
      parameters: {
        type: 'object',
        properties: {
          project: { type: 'string', description: 'كود المشروع (مثل «وكن 44» أو «44») أو نوعه (أدوار/شقق/فلل/تاون هاوس) أو حيّه (مثل العارض/النرجس)، كما يُفهم من رسالة العميل أو سياق المحادثة. اتركه فارغاً لعرض كل المشاريع المتاحة حسب النوع.' },
          unit: { type: 'string', description: 'كود الوحدة إن حدّده العميل مثل A1 أو 101 (اختياري)' },
        },
        required: ['project'],
      },
    },
  };
}

// Offered only for wakan hosts (server-rendered). Extend via WAKAN_UNITS_HOSTS.
const SUPPORTED_HOSTS = String(process.env.WAKAN_UNITS_HOSTS || 'wakan.sa')
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
