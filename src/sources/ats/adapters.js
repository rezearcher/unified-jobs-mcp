// Per-ATS adapters. Each adapter is isolated so maintenance (the moat) is clean:
// when one ATS changes its JSON shape, only its adapter changes. Every adapter
// returns an array of RAW platform records mapped into the unified job schema by
// normalize(). All endpoints are keyless public JSON (free COGS).

const UA = 'Mozilla/5.0 (compatible; GreyRidge-ATS-Feed/1.0)';

// Bounded-downside fetch controls. The board host is derived from caller input
// (a company slug/domain becomes a subdomain or Workday host), so a board that
// stalls mid-response (slow-loris) or streams an unbounded body must never hang a
// run forever or exhaust memory — that would turn a per-result job into unbounded
// compute, violating the convex-barbell "bounded, recoverable downside" law.
// Overridable via env so an operator can tune the bound and the regression test
// can drive the timeout low without waiting 30s.
const REQUEST_TIMEOUT_MS = Number(process.env.ATS_REQUEST_TIMEOUT_MS) || 30000; // parity w/ got-scraping adapters
const MAX_RESPONSE_BYTES = Number(process.env.ATS_MAX_RESPONSE_BYTES) || 25 * 1024 * 1024; // 25 MB hard ceiling

// Read a Response body as text under a hard byte ceiling, aborting the instant it
// is exceeded. Streams the body so a chunked response with no Content-Length (the
// slow-loris / unbounded-stream case) is bounded too, not just honest ones.
async function readCapped(res, url) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`response too large (${declared} bytes) for ${url}`);
  }
  if (!res.body || typeof res.body.getReader !== 'function') return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_RESPONSE_BYTES) {
        throw new Error(`response exceeded ${MAX_RESPONSE_BYTES} bytes for ${url}`);
      }
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch { /* stream already closed */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

// fetch() under a hard request timeout (covering both the headers AND the body
// read — the AbortController stays armed until the body is fully drained) with a
// capped, JSON-parsed body. Shared by every keyless adapter so the bound is uniform.
async function fetchJSON(url, opts = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      throw err;
    }
    return JSON.parse(await readCapped(res, url));
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms for ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function getJSON(url) {
  return fetchJSON(url, { headers: { Accept: 'application/json', 'User-Agent': UA } });
}

async function postJSON(url, body) {
  return fetchJSON(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': UA,
    },
    body: JSON.stringify(body),
  });
}

// Best-effort parse of Workday's relative "postedOn" text ("Posted Today",
// "Posted 5 Days Ago", "Posted 30+ Days Ago") into an ISO date, anchored to now.
function workdayPostedToISO(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  const now = Date.now();
  const DAY = 86400000;
  if (/today/.test(t)) return new Date(now).toISOString();
  if (/yesterday/.test(t)) return new Date(now - DAY).toISOString();
  const m = t.match(/(\d+)\+?\s*day/);
  if (m) return new Date(now - Number(m[1]) * DAY).toISOString();
  const mo = t.match(/(\d+)\+?\s*month/);
  if (mo) return new Date(now - Number(mo[1]) * 30 * DAY).toISOString();
  return null;
}

// Parse the many shapes a Workday target can arrive in into {host, tenant, site}.
//   "nvidia.wd5:NVIDIAExternalCareerSite"
//   "https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/..."
//   "nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite"
function parseWorkdayToken(token) {
  const raw = String(token || '').trim();
  if (!raw) return null;

  // Full / partial URL form
  if (/myworkdayjobs\.com/i.test(raw)) {
    const noProto = raw.replace(/^https?:\/\//i, '');
    const host = noProto.split('/')[0].toLowerCase();
    // SSRF guard: only genuine *.myworkdayjobs.com hosts may be fetched. The
    // substring test above matches any input *containing* "myworkdayjobs.com"
    // (even in a path or query), so without this the resolved host could be an
    // attacker-chosen server — e.g. "169.254.169.254/latest/myworkdayjobs.com".
    // Pin the host to the Workday domain before it is ever used to build a URL.
    if (!/(^|\.)myworkdayjobs\.com$/.test(host)) return null;
    const tenant = host.split('.')[0];
    const segs = noProto.split('/').slice(1).filter(Boolean);
    // site is the path segment before "/job" (skip a leading locale like "en-US")
    let site = null;
    for (const s of segs) {
      if (/^job$/i.test(s)) break;
      if (/^[a-z]{2}-[a-z]{2}$/i.test(s)) continue; // locale
      site = s;
      break;
    }
    if (host && tenant && site) return { host, tenant, site };
    return null;
  }

  // "tenant.wdN:site" compact form
  const m = raw.match(/^([a-z0-9-]+)\.(wd\d+):(.+)$/i);
  if (m) {
    const tenant = m[1].toLowerCase();
    const wd = m[2].toLowerCase();
    const site = m[3].trim();
    return { host: `${tenant}.${wd}.myworkdayjobs.com`, tenant, site };
  }
  return null;
}

function boolRemoteFromText(s) {
  if (!s) return null;
  return /\bremote\b/i.test(s) ? true : null;
}

function toISO(v) {
  if (v === null || v === undefined || v === '') return null;
  // epoch ms (number or numeric string) or an ISO/date string
  let d;
  if (typeof v === 'number') d = new Date(v);
  else if (/^\d{10,13}$/.test(String(v))) d = new Date(Number(v) * (String(v).length <= 10 ? 1000 : 1));
  else d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ---- Greenhouse ----------------------------------------------------------
async function greenhouse(token, { includeDescription }) {
  const data = await getJSON(
    `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs${includeDescription ? '?content=true' : ''}`
  );
  const jobs = data.jobs || [];
  return jobs.map((j) => ({
    id: String(j.id),
    title: j.title || null,
    department: (j.departments && j.departments[0] && j.departments[0].name) || null,
    team: null,
    location: (j.location && j.location.name) || null,
    remote: boolRemoteFromText(j.location && j.location.name),
    employment_type: null,
    url: j.absolute_url || null,
    posted_at: toISO(j.first_published || j.updated_at),
    updated_at: toISO(j.updated_at),
    salary: null,
    description_text: includeDescription && j.content ? stripHtml(j.content) : null,
    source_platform: 'greenhouse',
    source_token: token,
  }));
}

// ---- Lever ---------------------------------------------------------------
async function lever(token, { includeDescription }) {
  const jobs = await getJSON(`https://api.lever.co/v0/postings/${encodeURIComponent(token)}?mode=json`);
  return (Array.isArray(jobs) ? jobs : []).map((j) => {
    const c = j.categories || {};
    const wt = (j.workplaceType || '').toLowerCase();
    return {
      id: String(j.id),
      title: j.text || null,
      department: c.department || null,
      team: c.team || null,
      location: c.location || null,
      remote: wt === 'remote' ? true : wt === 'hybrid' ? true : boolRemoteFromText(c.location),
      employment_type: c.commitment || null,
      url: j.hostedUrl || j.applyUrl || null,
      posted_at: toISO(j.createdAt),
      updated_at: null,
      salary: (j.salaryRange && formatSalary(j.salaryRange.min, j.salaryRange.max, j.salaryRange.currency)) || null,
      description_text: includeDescription ? j.descriptionPlain || null : null,
      source_platform: 'lever',
      source_token: token,
    };
  });
}

// ---- Ashby ---------------------------------------------------------------
async function ashby(token, { includeDescription }) {
  const data = await getJSON(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}?includeCompensation=true`
  );
  const jobs = data.jobs || [];
  return jobs.map((j) => {
    const comp = j.compensation && j.compensation.compensationTierSummary;
    return {
      id: String(j.id),
      title: j.title || null,
      department: j.department || null,
      team: j.team || null,
      location: j.location || null,
      remote: typeof j.isRemote === 'boolean' ? j.isRemote : boolRemoteFromText(j.location),
      employment_type: j.employmentType || null,
      url: j.jobUrl || j.applyUrl || null,
      posted_at: toISO(j.publishedAt),
      updated_at: toISO(j.updatedAt),
      salary: comp || null,
      description_text: includeDescription ? j.descriptionPlain || null : null,
      source_platform: 'ashby',
      source_token: token,
    };
  });
}

// ---- SmartRecruiters (paginated) -----------------------------------------
async function smartrecruiters(token, { includeDescription, maxItems }) {
  const out = [];
  let offset = 0;
  const limit = 100;
  // cap pages so one huge board (e.g. 5000 jobs) can't run away; maxItems trims further
  for (let page = 0; page < 60; page += 1) {
    const data = await getJSON(
      `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings?limit=${limit}&offset=${offset}`
    );
    const content = data.content || [];
    for (const j of content) {
      const loc = j.location || {};
      const locStr = [loc.city, loc.region, loc.country].filter(Boolean).join(', ') || null;
      out.push({
        id: String(j.id),
        title: j.name || null,
        department: (j.department && j.department.label) || null,
        team: null,
        location: locStr,
        remote: loc.remote === true ? true : boolRemoteFromText(locStr),
        employment_type: (j.typeOfEmployment && j.typeOfEmployment.label) || null,
        url: j.ref ? `https://jobs.smartrecruiters.com/${token}/${j.id}` : null,
        posted_at: toISO(j.releasedDate),
        updated_at: toISO(j.actualDate),
        salary: null,
        description_text: null, // SR detail body needs a second call per job; skipped unless requested
        source_platform: 'smartrecruiters',
        source_token: token,
      });
      if (maxItems && out.length >= maxItems) return out;
    }
    offset += limit;
    if (offset >= (data.totalFound || 0) || content.length === 0) break;
  }
  return out;
}

// ---- Workday CXS (POST, paginated) ---------------------------------------
// Keyless public jobs endpoint used by every *.myworkdayjobs.com careers site.
// Token form: "tenant.wdN:site" or a full careers URL (see parseWorkdayToken).
async function workday(token, { includeDescription, maxItems }) {
  const wd = parseWorkdayToken(token);
  if (!wd) {
    // Not a resolvable Workday target (e.g. a bare slug from auto-detect) —
    // return empty cleanly so detect()/scrape never throw on it.
    return [];
  }
  const { host, tenant, site } = wd;
  const base = `https://${host}/wday/cxs/${tenant}/${site}`;
  const out = [];
  let offset = 0;
  const limit = 20; // Workday CXS hard-caps page size at 20
  // cap pages so a 2000-job board can't run away; maxItems trims further
  for (let page = 0; page < 100; page += 1) {
    const data = await postJSON(`${base}/jobs`, {
      appliedFacets: {},
      limit,
      offset,
      searchText: '',
    });
    const postings = data.jobPostings || [];
    const total = typeof data.total === 'number' ? data.total : 0;
    for (const j of postings) {
      const ext = j.externalPath || '';
      let description_text = null;
      let employment_type = null;
      let posted_at = workdayPostedToISO(j.postedOn);
      // The list payload is thin; the keyless GET detail endpoint carries the real
      // posted date, employment type, and description. Only hit it on request.
      if (includeDescription && ext) {
        // externalPath already begins with "/job/...", so append it to base directly
        const info = await getJSON(`${base}${ext}`).then((d) => d.jobPostingInfo).catch(() => null);
        if (info) {
          if (info.jobDescription) description_text = stripHtml(info.jobDescription);
          if (info.timeType) employment_type = info.timeType;
          if (info.startDate) posted_at = toISO(info.startDate) || posted_at;
        }
      }
      out.push({
        id: String((j.bulletFields && j.bulletFields[0]) || ext || j.title),
        title: j.title || null,
        department: null, // not present in list payload
        team: null,
        location: j.locationsText || null,
        remote: boolRemoteFromText(j.locationsText),
        employment_type,
        url: ext ? `https://${host}/${site}${ext}` : null,
        posted_at,
        posted_at_raw: j.postedOn || null,
        updated_at: null,
        salary: null,
        description_text,
        source_platform: 'workday',
        source_token: `${tenant}.${host.split('.')[1]}:${site}`,
      });
      if (maxItems && out.length >= maxItems) return out;
    }
    offset += limit;
    if (postings.length === 0 || offset >= total) break;
  }
  return out;
}

// ---- Recruitee (careers-site public JSON) --------------------------------
// Keyless GET at https://{token}.recruitee.com/api/offers/ — the public careers
// feed every Recruitee-hosted board exposes. "offers" covers jobs + talent pools;
// we keep only published job offers. No pagination (returns the full set).
async function recruitee(token, { includeDescription, maxItems }) {
  const data = await getJSON(`https://${encodeURIComponent(token)}.recruitee.com/api/offers/`);
  const offers = Array.isArray(data.offers) ? data.offers : [];
  const out = [];
  for (const o of offers) {
    // careers API returns talent pools too (kind==='talent_pool'); keep only
    // published job offers.
    if (o.status && o.status !== 'published') continue;
    if (o.kind && o.kind !== 'job') continue;
    const sal = o.salary || {};
    out.push({
      id: String(o.id),
      title: o.title || null,
      department: o.department || null,
      team: null,
      location: o.location || [o.city, o.country].filter(Boolean).join(', ') || null,
      remote: o.remote === true ? true : o.hybrid === true ? true : boolRemoteFromText(o.location),
      employment_type: cleanEnum(o.employment_type_code),
      url: o.careers_url || o.careers_apply_url || null,
      posted_at: toISO(o.published_at),
      updated_at: toISO(o.updated_at),
      salary: formatSalary(sal.min, sal.max, sal.currency),
      description_text: includeDescription ? stripHtml(o.description) : null,
      source_platform: 'recruitee',
      source_token: token,
    });
    if (maxItems && out.length >= maxItems) break;
  }
  return out;
}

// ---- Workable (public embed widget API) ----------------------------------
// Keyless GET at https://apply.workable.com/api/v1/widget/accounts/{token} —
// returns every published job in one shot (no pagination), with readable fields
// (url, employment_type, published_on, telecommuting). Description lives on the
// per-job detail GET (/api/v1/accounts/{token}/jobs/{shortcode}), fetched only
// when requested. (The v3 jobs POST exists too but its cursor pagination is
// flaky — the widget feed is the stable source.)
async function workable(token, { includeDescription, maxItems }) {
  const data = await getJSON(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}`);
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const out = [];
  for (const j of jobs) {
    if (j.state && String(j.state).toLowerCase() === 'draft') continue;
    const locStr = [j.city, j.state, j.country].filter(Boolean).join(', ') || null;
    let description_text = null;
    if (includeDescription && j.shortcode) {
      const info = await getJSON(
        `https://apply.workable.com/api/v1/accounts/${encodeURIComponent(token)}/jobs/${j.shortcode}`
      ).catch(() => null);
      if (info && info.description) description_text = stripHtml(info.description);
    }
    out.push({
      id: String(j.shortcode || j.code || j.title),
      title: j.title || null,
      department: j.department || null,
      team: null,
      location: locStr,
      remote: j.telecommuting === true ? true : boolRemoteFromText(locStr),
      employment_type: j.employment_type || null,
      url: j.url || j.shortlink || null,
      posted_at: toISO(j.published_on),
      updated_at: toISO(j.created_at),
      salary: null,
      description_text,
      source_platform: 'workable',
      source_token: token,
    });
    if (maxItems && out.length >= maxItems) break;
  }
  return out;
}

// ---- BambooHR (public careers JSON) --------------------------------------
// Keyless GET at https://{slug}.bamboohr.com/careers/list — the public careers
// feed every BambooHR-hosted board exposes ({meta:{totalCount}, result:[...]}).
// BambooHR is the US SMB long tail (17k+ companies) that the Greenhouse/Lever
// enterprise/startup adapters miss — complementary coverage, not redundant.
// The list payload is thin (no post date / description / salary); the keyless
// per-job detail GET (/careers/{id}/detail -> result.jobOpening) carries the
// real datePosted, employment type, country and full description, fetched only
// when includeDescription is set. Token is a bare company slug.
async function bamboohr(token, { includeDescription, maxItems }) {
  const slug = String(token || '').trim().toLowerCase();
  // SSRF/host-injection guard: the slug becomes a subdomain, so pin it to a
  // genuine BambooHR tenant label (alnum + hyphen) before building any URL —
  // never let "evil.com/x" or an IP slip into the host (cf. parseWorkdayToken).
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return [];
  const base = `https://${slug}.bamboohr.com`;
  const data = await getJSON(`${base}/careers/list`);
  const result = Array.isArray(data && data.result) ? data.result : [];
  const out = [];
  for (const j of result) {
    const loc = j.location || {};
    const ats = j.atsLocation || {};
    const locStr =
      [loc.city, loc.state].filter(Boolean).join(', ') ||
      [ats.city, ats.state || ats.province, ats.country].filter(Boolean).join(', ') ||
      null;
    let posted_at = null;
    let employment_type = j.employmentStatusLabel || j.employmentType || null;
    let salary = null;
    let description_text = null;
    let remote = j.isRemote === true ? true : boolRemoteFromText(locStr);
    if (includeDescription) {
      const info = await getJSON(`${base}/careers/${encodeURIComponent(j.id)}/detail`)
        .then((d) => d && d.result && d.result.jobOpening)
        .catch(() => null);
      if (info) {
        if (info.datePosted) posted_at = toISO(info.datePosted);
        if (info.employmentStatusLabel) employment_type = info.employmentStatusLabel;
        if (info.compensation) salary = String(info.compensation);
        if (info.jobDescription || info.description) {
          description_text = stripHtml(info.jobDescription || info.description);
        }
        if (remote !== true && info.locationType && String(info.locationType) === '2') remote = true;
      }
    }
    out.push({
      id: String(j.id),
      title: j.jobOpeningName || null,
      department: j.departmentLabel || null,
      team: null,
      location: locStr,
      remote,
      employment_type,
      url: `${base}/careers/${encodeURIComponent(j.id)}`,
      posted_at,
      updated_at: null,
      salary,
      description_text,
      source_platform: 'bamboohr',
      source_token: slug,
    });
    if (maxItems && out.length >= maxItems) break;
  }
  return out;
}

// Normalize an ATS enum code ("fulltime_fixed_term", "full") into a readable
// label: split on _/-, title-case words. Returns null for empty.
function cleanEnum(code) {
  if (!code) return null;
  return String(code)
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || null;
}

function stripHtml(html) {
  if (!html) return null;
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatSalary(min, max, cur) {
  if (!min && !max) return null;
  const c = cur || '';
  if (min && max) return `${c}${min} - ${c}${max}`.trim();
  return `${c}${min || max}`.trim();
}

export { parseWorkdayToken, fetchJSON }; // exported for the SSRF-guard + fetch-bounds regression tests
export const ADAPTERS = { greenhouse, lever, ashby, smartrecruiters, workday, recruitee, workable, bamboohr };
export const PLATFORMS = Object.keys(ADAPTERS);
// Platforms probed during bare-domain/slug auto-detect. Workday is explicit-only
// (its target needs tenant.wdN:site, not a slug) so it is excluded from the probe
// loop to avoid a wasteful POST per candidate; it still resolves via "workday:..".
// Recruitee (keyless GET) and Workable (keyless POST) take a plain company slug,
// so both join the probe loop. BambooHR (keyless GET on {slug}.bamboohr.com)
// takes a plain slug too — probed LAST so an established-platform match wins
// first and a company that happens to have a stale/empty BambooHR board (which
// returns 0 jobs, so it never false-wins anyway) can't shadow its real board.
export const DETECT_PLATFORMS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'recruitee', 'workable', 'bamboohr'];
