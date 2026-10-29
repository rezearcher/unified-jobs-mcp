// Pure normalization for the HN "Who is hiring?" source. No network, no Apify SDK —
// fully verifiable with plain `node`. Output shape mirrors the ATS + LinkedIn + Indeed
// sources' unified job schema field-for-field so a single HN post for "Stripe —
// Backend Engineer" DEDUP-MERGES with Stripe's own ATS posting in dedup.js.

// ---- salary ---------------------------------------------------------------
// HN comp strings seen in-thread: "$170k to $230k Base + Equity", "$120K-$160K",
// "€60,000 - €80,000", "$55/hr". Parse into {min,max,currency,period,raw}; never throw.
const CUR = { $: 'USD', '£': 'GBP', '€': 'EUR', 'C$': 'CAD', 'A$': 'AUD', '₹': 'INR' };
const PERIOD = [
  [/\/\s*yr\b|\ba?\s*year\b|\bannual|\bannum|\bp\.?a\.?\b/i, 'year'],
  [/\/\s*mo\b|\ba?\s*month\b|\bmonthly\b/i, 'month'],
  [/\/\s*hr\b|\ban?\s*hour\b|\bhourly\b|\bp\/h\b/i, 'hour'],
];

// A string is only treated as comp if it carries a currency symbol, a k/m-suffixed
// number, or an explicit pay keyword — so a stray "12,000 people" / a zip code / a
// year never becomes a bogus salary.
const COMP_SIGNAL = /[$£€₹]|\b\d+\s?[kKmM]\b|\b(salary|comp|compensation|equity|base|pay|wage|stipend|\/\s?hr|\/\s?yr|per hour|per year|annum)\b/i;

export function parseSalary(text) {
  if (!text || typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw || !COMP_SIGNAL.test(raw)) return null;

  let currency = null;
  for (const sym of ['C$', 'A$', '$', '£', '€', '₹']) { if (raw.includes(sym)) { currency = CUR[sym]; break; } }
  if (!currency && /\bUSD\b/i.test(raw)) currency = 'USD';
  if (!currency && /\bGBP\b/i.test(raw)) currency = 'GBP';
  if (!currency && /\bEUR\b/i.test(raw)) currency = 'EUR';

  const nums = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*([kKmM])?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (isNaN(n)) continue;
    const suf = (m[2] || '').toLowerCase();
    if (suf === 'k') n *= 1000; else if (suf === 'm') n *= 1000000;
    // ignore stray small numbers that are clearly not comp (e.g. "401k" edge, years)
    if (n < 1000 && !/\/\s*hr|hour/i.test(raw)) continue;
    nums.push(n);
  }
  if (nums.length === 0) return null;

  let period = null;
  for (const [rx, p] of PERIOD) { if (rx.test(raw)) { period = p; break; } }
  if (!period) period = 'year';

  let min = null; let max = null;
  if (/\bup to\b/i.test(raw)) max = nums[0];
  else if (nums.length >= 2) { min = nums[0]; max = nums[1]; }
  else { min = nums[0]; max = nums[0]; }

  // Plausibility clamp — HN comp free-text frequently captures a stray number (an
  // employee count, a year, a "401k"). Reject figures outside a sane band for the
  // period so we emit a clean salary or none, never a bogus one.
  const band = period === 'hour' ? [5, 2000] : period === 'month' ? [800, 200000] : [12000, 2000000];
  const inBand = (n) => n == null || (n >= band[0] && n <= band[1]);
  if (!inBand(min) || !inBand(max)) return null;

  return { min, max, currency: currency || 'USD', period, raw };
}

export function formatSalary(sal) {
  if (!sal) return null;
  const c = sal.currency || '';
  const per = sal.period ? ` / ${sal.period}` : '';
  if (sal.min != null && sal.max != null && sal.min !== sal.max) return `${c}${sal.min} - ${c}${sal.max}${per}`.trim();
  const one = sal.min != null ? sal.min : sal.max;
  return one != null ? `${c}${one}${per}`.trim() : null;
}

// ---- dedup ----------------------------------------------------------------
// The comment id is the stable per-post identity on HN.
export function dedupKey(card) {
  if (card.id) return `hn:${card.id}`;
  return `hn:${card.url || card.company || JSON.stringify(card)}`;
}

// ---- unified mapping ------------------------------------------------------
export function normalizeCard(card, { includeDescription = false } = {}) {
  const sal = parseSalary(card.salaryText);
  const posted_at = card.created_at ? new Date(card.created_at).toISOString() : null;
  const url = card.url || (card.id ? `https://news.ycombinator.com/item?id=${card.id}` : null);

  return {
    id: card.id ? String(card.id) : (url || card.company || null),
    title: card.title || null,
    department: null,
    team: null,
    location: card.location || (card.remote === true ? 'Remote' : null),
    remote: card.remote,
    employment_type: card.employment_type || null,
    url,
    posted_at,
    updated_at: posted_at,
    salary: formatSalary(sal),
    salary_min: sal ? sal.min : null,
    salary_max: sal ? sal.max : null,
    salary_currency: sal ? sal.currency : null,
    salary_period: sal ? sal.period : null,
    description_text: includeDescription ? (card.snippet || null) : (card.snippet || null),
    description_html: null,
    snippet: card.snippet || null,
    job_key: card.id || null,
    source_platform: 'hn',
    source_token: card.company || null,
    company: card.company || null,
    // HN-specific provenance
    hn_author: card.author || null,
    hn_url: card.id ? `https://news.ycombinator.com/item?id=${card.id}` : null,
    workplace: card.workplace || null,
  };
}
