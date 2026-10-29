// Pure normalization core for the LinkedIn public-jobs actor. No network, no Apify
// SDK — so it runs and is fully verifiable with plain `node` (see test/local_run.js).
// This is the rot-prone moat: LinkedIn changes its guest-card markup, its criteria
// labels and its salary strings over time; keeping the mapping isolated here means
// upkeep touches one file.
//
// Output shape mirrors the multi-ATS + Indeed actors' unified job schema
// field-for-field (id, title, department, team, location, remote, employment_type,
// url, posted_at, updated_at, salary, salary_min/max/currency/period,
// description_text, description_html, snippet, job_key, source_platform,
// source_token, company) so a buyer can merge all three actors' datasets identically.

// ---- salary -------------------------------------------------------------
// LinkedIn renders compensation as free text, e.g.
//   "$123,500.00/yr - $150,000.00/yr"   "$55.00/hr"   "€60,000/yr - €80,000/yr"
//   "From $80,000/yr"                    "Base pay range $120K/yr - $150K/yr"
// Parse into {min, max, currency, period, raw}. Never throw on an odd string.
const CUR = { '$': 'USD', '£': 'GBP', '€': 'EUR', 'C$': 'CAD', 'A$': 'AUD', '₹': 'INR' };
// LinkedIn uses compact "/yr /mo /wk /hr /day" markers as well as full words.
const PERIOD = [
  [/\/\s*yr\b|\ba?\s*year\b|\bannual|\bannum|\bp\.?a\.?\b/i, 'year'],
  [/\/\s*mo\b|\ba?\s*month\b|\bmonthly\b/i, 'month'],
  [/\/\s*wk\b|\ba?\s*week\b|\bweekly\b/i, 'week'],
  [/\/\s*day\b|\bdaily\b|\bper diem\b/i, 'day'],
  [/\/\s*hr\b|\ban?\s*hour\b|\bhourly\b|\bp\/h\b/i, 'hour'],
];

export function parseSalary(text) {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw) return null;

  // currency: longest-token match first (C$/A$ before $)
  let currency = null;
  for (const sym of ['C$', 'A$', '$', '£', '€', '₹']) {
    if (raw.includes(sym)) { currency = CUR[sym]; break; }
  }
  if (!currency && /\bUSD\b/i.test(raw)) currency = 'USD';
  if (!currency && /\bGBP\b/i.test(raw)) currency = 'GBP';
  if (!currency && /\bEUR\b/i.test(raw)) currency = 'EUR';

  // numbers: 123,500.00 / 80000 / 55 / 150K
  const nums = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(n)) continue;
    const suf = (m[2] || '').toLowerCase();
    if (suf === 'k') n *= 1000;
    else if (suf === 'm') n *= 1000000;
    nums.push(n);
  }
  if (nums.length === 0) return null;

  let period = null;
  for (const [rx, p] of PERIOD) { if (rx.test(raw)) { period = p; break; } }

  let min = null; let max = null;
  if (/\bup to\b/i.test(raw)) { max = nums[0]; }
  else if (/\bfrom\b|\bstarting\b|\bat least\b/i.test(raw)) { min = nums[0]; }
  else if (nums.length >= 2) { min = nums[0]; max = nums[1]; }
  else { min = nums[0]; max = nums[0]; }

  return { min, max, currency, period, raw };
}

// Human-readable salary string for the shared `salary` field (matches the sibling
// actors' formatSalary style: "USD123500 - USD150000 / year").
export function formatSalary(sal) {
  if (!sal) return null;
  const c = sal.currency || '';
  const per = sal.period ? ` / ${sal.period}` : '';
  if (sal.min != null && sal.max != null && sal.min !== sal.max) return `${c}${sal.min} - ${c}${sal.max}${per}`.trim();
  const one = sal.min != null ? sal.min : sal.max;
  return one != null ? `${c}${one}${per}`.trim() : null;
}

// ---- remote -------------------------------------------------------------
export function boolRemoteFromText(s) {
  if (!s) return null;
  return /\bremote\b|\bwork from home\b|\bwfh\b/i.test(String(s)) ? true : null;
}

// Map a LinkedIn workplace-type / location string to a remote flag. LinkedIn
// encodes remote either in the location text ("United States (Remote)") or via
// the f_WT=2 search filter; the card itself only carries the text.
export function remoteFromCard(card) {
  if (card.workplaceType) {
    const w = String(card.workplaceType).toLowerCase();
    if (/remote/.test(w)) return true;
    if (/on-?site|hybrid/.test(w)) return false;
  }
  return boolRemoteFromText(card.location) || boolRemoteFromText(card.title);
}

// ---- dates --------------------------------------------------------------
// LinkedIn cards carry a <time datetime="2026-10-08"> (the authoritative date) and
// a relative string ("3 weeks ago"). Prefer the datetime; fall back to relative.
export function toISO(v) {
  if (v === null || v === undefined || v === '') return null;
  let d;
  if (typeof v === 'number') d = new Date(v < 1e12 ? v * 1000 : v);
  else if (/^\d{10,13}$/.test(String(v))) {
    const n = Number(v);
    d = new Date(String(v).length <= 10 ? n * 1000 : n);
  } else d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

export function relativeToISO(text, now = Date.now()) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const DAY = 86400000;
  if (/just now|just posted|posted today|^today/.test(t)) return new Date(now).toISOString();
  if (/yesterday/.test(t)) return new Date(now - DAY).toISOString();
  const mm = t.match(/(\d+)\+?\s*minute/);
  if (mm) return new Date(now - Number(mm[1]) * 60000).toISOString();
  const mh = t.match(/(\d+)\+?\s*hour/);
  if (mh) return new Date(now - Number(mh[1]) * 3600000).toISOString();
  const md = t.match(/(\d+)\+?\s*day/);
  if (md) return new Date(now - Number(md[1]) * DAY).toISOString();
  const mw = t.match(/(\d+)\+?\s*week/);
  if (mw) return new Date(now - Number(mw[1]) * 7 * DAY).toISOString();
  const mo = t.match(/(\d+)\+?\s*month/);
  if (mo) return new Date(now - Number(mo[1]) * 30 * DAY).toISOString();
  return null;
}

// ---- html ---------------------------------------------------------------
export function stripHtml(html) {
  if (!html) return null;
  return String(html)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- dedup --------------------------------------------------------------
// LinkedIn's numeric jobPosting id is the stable identity.
export function dedupKey(job) {
  if (job.job_key) return `linkedin:${job.job_key}`;
  return `linkedin:${job.url || job.title || JSON.stringify(job)}`;
}

// ---- criteria mapping ---------------------------------------------------
// The detail page exposes a criteria list: Seniority level, Employment type,
// Job function, Industries. Map the label->value pairs onto our schema.
export function applyCriteria(target, criteria) {
  if (!criteria) return target;
  for (const [label, value] of Object.entries(criteria)) {
    const l = label.toLowerCase();
    if (/employment type/.test(l) && value) target.employment_type = target.employment_type || value;
    else if (/seniority/.test(l) && value) target.seniority_level = value;
    else if (/job function/.test(l) && value) target.department = target.department || value;
    else if (/industr/.test(l) && value) target.industries = value;
  }
  return target;
}

// ---- unified mapping ----------------------------------------------------
// Map one raw LinkedIn search card (from parse.js) into the unified schema.
export function normalizeCard(card, { includeDescription = false } = {}) {
  const id = card.jobId || card.id || null;
  const title = card.title || null;
  const company = card.company || null;
  const location = card.location || null;

  const sal = parseSalary(card.salaryText);
  const remote = remoteFromCard(card);

  // canonical public job URL (strip tracking query params)
  let url = card.url || (id ? `https://www.linkedin.com/jobs/view/${id}` : null);
  if (url) url = url.split('?')[0];

  const posted_at = toISO(card.datetime) || relativeToISO(card.relativeTime);
  const descHtml = includeDescription ? (card.descriptionHtml || null) : null;
  const snippet = card.snippet ? stripHtml(card.snippet) : null;

  const out = {
    id: id ? String(id) : (url || title || null),
    title,
    department: null,
    team: null,
    location,
    remote,
    employment_type: card.employmentType || null,
    url,
    posted_at,
    updated_at: posted_at,
    salary: formatSalary(sal),
    salary_min: sal ? sal.min : null,
    salary_max: sal ? sal.max : null,
    salary_currency: sal ? sal.currency : null,
    salary_period: sal ? sal.period : null,
    description_text: descHtml ? stripHtml(descHtml) : (snippet || null),
    description_html: descHtml || null,
    snippet,
    job_key: id || null,
    source_platform: 'linkedin',
    source_token: company || null,
    company,
  };
  if (card.criteria) applyCriteria(out, card.criteria);
  return out;
}
