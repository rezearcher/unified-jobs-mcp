// The flagship capability: cross-source DEDUP + field-union MERGE. No incumbent on
// the rail does this — every jobs actor is single-source. The same role posted on
// LinkedIn + Indeed + the company's own ATS collapses here to ONE canonical record
// carrying a sources[] array and the UNION of the richest fields from each source.
//
// Pure (no network, no Apify SDK) so it is fully verifiable with plain `node`
// (see test/local_run.js). This is also the rot-prone moat made explicit: title /
// company / location normalization is exactly what drifts, and keeping it isolated
// here means a buyer rents our maintained dedup instead of building + maintaining a
// fuzzy matcher across 3+ independently-changing schemas.
//
// Design bias (NORTH_STAR): DEGRADE OPEN, never silently drop. If normalization
// cannot produce a confident key (empty company OR empty title), the record is NOT
// merged — it is emitted on its own with merged=false so nothing vanishes.

import { createHash } from 'node:crypto';

// ---- normalization ------------------------------------------------------

// Legal-entity suffixes that differ across sources for the same employer
// ("Stripe" vs "Stripe, Inc." vs "Stripe Inc"). Stripped for the match key only;
// the human-facing company field keeps whichever source value we pick.
const COMPANY_SUFFIX = /\b(inc|incorporated|llc|l\.l\.c|ltd|limited|plc|gmbh|g\.m\.b\.h|corp|corporation|co|company|holdings|group|labs|technologies|technology|software|sa|ag|srl|bv|nv|oy|ab|as|pte|pty)\b/g;

export function normalizeCompany(s) {
  if (s == null) return '';
  return String(s)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[.,/#!$%^*;:{}=\-_`~()]/g, ' ')
    .replace(COMPANY_SUFFIX, ' ')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// Title normalization is deliberately conservative — we would rather UNDER-merge
// (emit two records for what is really one role) than FALSE-merge (collapse two
// genuinely different roles into one, losing a posting). So we lowercase, strip only
// a trailing parenthetical / bracket chunk (a req-id or "(Remote)" —
// "Software Engineer (Remote, US)" / "Backend Engineer [REQ-1234]"), then drop
// punctuation and collapse whitespace. We intentionally do NOT:
//   • strip seniority words (senior/staff/principal) — they distinguish roles;
//   • strip a trailing " - <tail>" — that tail is as often a role qualifier
//     ("Backend Engineer - Application Development" vs "- Defense") as a location,
//     and stripping it collapsed 4 distinct openings in live testing. Location is
//     already a separate key component, so we don't need to guess here.
export function normalizeTitle(s) {
  if (s == null) return '';
  let t = String(s).toLowerCase();
  t = t.replace(/\s*[([{][^)\]}]*[)\]}]\s*$/g, ' '); // trailing (...) / [...] / {...}
  t = t.replace(/[.,/#!$%^*;:{}=_`~]/g, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return t.replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
}

// First meaningful location token: the CITY, or a neutral "remote" bucket when the
// posting is remote/country-level with no concrete city. "San Francisco, CA, USA"
// -> "sanfrancisco"; "Remote - US" / "United States (Remote)" -> "remote". Used as a
// tie-breaker so the SAME title at the SAME company in DIFFERENT cities does not
// merge — but a concrete city in the TEXT wins over the remote flag, so the same
// role listed as "San Francisco (Remote)" on one source and "San Francisco" on
// another still merges. Empty / unknown location does NOT block a merge (contributes "").
const REMOTE_RE = /\bremote\b|\bwork from home\b|\bwfh\b|\banywhere\b|\bdistributed\b/;
const COUNTRY_WORDS = new Set([
  'unitedstates', 'usa', 'us', 'unitedkingdom', 'uk', 'canada', 'germany', 'france',
  'india', 'remote', 'anywhere', 'global', 'worldwide', 'europe', 'emea', 'apac', 'americas',
]);
export function firstLocationToken(loc, remoteFlag) {
  const s = loc == null ? '' : String(loc).toLowerCase().trim();
  const first = (s.split(/[,/|•·()\-–—]/)[0] || '').replace(/[^a-z0-9]+/g, '').trim();
  if (!first || COUNTRY_WORDS.has(first) || REMOTE_RE.test(first)) {
    if (remoteFlag === true || REMOTE_RE.test(s)) return 'remote';
    return '';
  }
  return first;
}

// ---- canonical key ------------------------------------------------------
// slug(company) | slug(title) | locationToken. Returns null when company OR title
// normalizes empty — the "do not merge, degrade open" signal.
export function canonicalKey(job) {
  const c = normalizeCompany(job.company || job.source_token);
  const t = normalizeTitle(job.title);
  if (!c || !t) return null;
  const l = firstLocationToken(job.location, job.remote);
  return `${c}|${t}|${l}`;
}

function shortHash(str) {
  return createHash('sha1').update(str).digest('hex').slice(0, 16);
}

// ---- field union --------------------------------------------------------

// company's own ATS is the most canonical posting; ATS specific platforms map to
// the "ats" family. Ranking decides which source becomes the base record / primary_url.
// HN posts are self-reported free text (lowest authority for canonical fields), so
// it ranks below the structured sources — but it still contributes a sources[] entry
// and its unique fields (hn_author, apply url) on a merge.
const SOURCE_RANK = { ats: 0, linkedin: 1, indeed: 2, hn: 3 };
const ATS_PLATFORMS = new Set(['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workday', 'recruitee', 'workable']);
function familyOf(j) {
  if (j.source_family) return j.source_family;
  const p = j.source_platform;
  if (ATS_PLATFORMS.has(p)) return 'ats';
  return p;
}
function rankOf(j) { return SOURCE_RANK[familyOf(j)] ?? 9; }

function earliestISO(a, b) {
  if (!a) return b; if (!b) return a;
  return (new Date(a) <= new Date(b)) ? a : b;
}
function longer(a, b) {
  if (!a) return b; if (!b) return a;
  return (String(a).length >= String(b).length) ? a : b;
}
function salaryScore(j) {
  // explicit min AND max beats one-sided beats none
  if (j.salary_min != null && j.salary_max != null) return 3;
  if (j.salary_min != null || j.salary_max != null) return 2;
  if (j.salary) return 1;
  return 0;
}

// Merge a group of raw unified-schema jobs (all sharing one canonical key) into a
// single flagship record. Field UNION with documented priority: salary from the
// source with the most explicit figures, description from the longest, posted_at the
// earliest seen, primary_url from the highest-ranked source (ATS > LinkedIn > Indeed).
export function mergeGroup(jobs, key) {
  // pick a "base" record = highest-ranked source, then richest
  const sorted = [...jobs].sort((a, b) => {
    const r = rankOf(a) - rankOf(b);
    if (r !== 0) return r;
    return salaryScore(b) - salaryScore(a);
  });
  const base = sorted[0];

  const out = {
    id: shortHash(key),
    title: null,
    company: null,
    company_domain: null,
    location: null,
    remote: null,
    employment_type: null,
    department: null,
    team: null,
    seniority_level: null,
    industries: null,
    salary: null,
    salary_min: null,
    salary_max: null,
    salary_currency: null,
    salary_period: null,
    salary_raw: null,
    posted_at: null,
    description_text: null,
    description_html: null,
    sources: [],
    primary_url: null,
    merged: jobs.length > 1,
    scraped_at: new Date().toISOString(),
  };

  let bestSalaryScore = -1;
  for (const j of sorted) {
    // scalar "first non-null wins" fields, in source-rank order (sorted already)
    out.title = out.title || j.title;
    out.company = out.company || j.company || j.source_token;
    out.company_domain = out.company_domain || j.company_domain || null;
    out.location = out.location || j.location;
    out.employment_type = out.employment_type || j.employment_type;
    out.department = out.department || j.department;
    out.team = out.team || j.team;
    out.seniority_level = out.seniority_level || j.seniority_level || null;
    out.industries = out.industries || j.industries || null;

    if (j.remote === true) out.remote = true;
    else if (out.remote == null && j.remote === false) out.remote = false;

    // salary: take the whole set from the single richest source (keeps min/max/
    // currency/period internally consistent rather than mixing sources)
    const sc = salaryScore(j);
    if (sc > bestSalaryScore) {
      bestSalaryScore = sc;
      out.salary = j.salary || null;
      out.salary_min = j.salary_min ?? null;
      out.salary_max = j.salary_max ?? null;
      out.salary_currency = j.salary_currency ?? null;
      out.salary_period = j.salary_period ?? null;
      out.salary_raw = j.salary_raw || j.salary || null;
    }

    out.posted_at = earliestISO(out.posted_at, j.posted_at);
    out.description_text = longer(out.description_text, j.description_text);
    out.description_html = longer(out.description_html, j.description_html);

    out.sources.push({
      source_platform: j.source_platform || null,
      source_job_key: j.job_key || j.id || null,
      url: j.url || null,
      posted_at: j.posted_at || null,
      company: j.company || j.source_token || null,
      location: j.location || null,
    });
  }

  out.primary_url = base.url || (out.sources.find((s) => s.url) || {}).url || null;
  return out;
}

// ---- top-level dedupe ---------------------------------------------------
/**
 * Collapse raw unified-schema jobs from every source into canonical records.
 * @param {object[]} jobs  unified-schema rows (source_platform set on each)
 * @param {object}   [opts]
 * @param {boolean}  [opts.dedupe=true]  when false, every row is emitted 1:1 (still
 *                   wrapped in the flagship shape with a single-entry sources[]).
 * @returns {object[]} canonical records, deterministic order (merged groups first
 *                     by size then key, then unmergeable singletons).
 */
export function dedupe(jobs, { dedupe: on = true } = {}) {
  const groups = new Map();
  const singletons = []; // null-key: degrade-open, never dropped

  let n = 0;
  for (const j of jobs || []) {
    if (!j) continue;
    const key = on ? canonicalKey(j) : null;
    if (!key) {
      // synthesize a unique key so it survives as its own record
      const uniq = `__nokey__${n++}__${j.source_platform || ''}:${j.job_key || j.id || Math.random()}`;
      singletons.push([uniq, [j]]);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(j);
  }

  const out = [];
  for (const [key, grp] of groups) out.push(mergeGroup(grp, key));
  for (const [key, grp] of singletons) {
    const rec = mergeGroup(grp, key);
    rec.merged = false;
    out.push(rec);
  }

  // deterministic: bigger merges first (most valuable), then by canonical title/company
  out.sort((a, b) => (b.sources.length - a.sources.length)
    || String(a.company).localeCompare(String(b.company))
    || String(a.title).localeCompare(String(b.title)));
  return out;
}

// Diagnostics for the run summary: how much the dedup actually collapsed.
export function dedupStats(rawCount, records) {
  const multi = records.filter((r) => r.sources.length > 1);
  const bySrc = {};
  for (const r of records) for (const s of r.sources) bySrc[s.source_platform] = (bySrc[s.source_platform] || 0) + 1;
  return {
    raw_source_hits: rawCount,
    canonical_jobs: records.length,
    cross_source_merges: multi.length,
    collapsed: rawCount - records.length,
    per_source_hits: bySrc,
  };
}
