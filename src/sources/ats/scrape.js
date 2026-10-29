// Core orchestration: resolve each input company to (platform, token), fetch via
// the right adapter, normalize, dedupe. Pure — no Apify SDK — so it runs and is
// verifiable with plain `node` against live endpoints (see test/local_run.js).

import { ADAPTERS, PLATFORMS, DETECT_PLATFORMS } from './adapters.js';

// Turn a user entry into candidate {platform, token} resolutions.
//   "greenhouse:stripe"  -> explicit platform + token
//   "stripe.com"         -> domain -> slug candidates, probe all platforms
//   "stripe"             -> slug, probe all platforms
export function parseEntry(entry) {
  const raw = String(entry || '').trim();
  if (!raw) return { explicit: null, candidates: [] };

  const m = raw.match(/^([a-zA-Z]+):(.+)$/);
  if (m && PLATFORMS.includes(m[1].toLowerCase())) {
    return { explicit: { platform: m[1].toLowerCase(), token: m[2].trim() }, candidates: [] };
  }

  // A full *.myworkdayjobs.com careers URL is unambiguously Workday — route it
  // explicitly (the adapter parses tenant/wdN/site out of the URL itself). This
  // avoids the bare-domain auto-detect loop, which does not probe Workday.
  if (/myworkdayjobs\.com/i.test(raw)) {
    return { explicit: { platform: 'workday', token: raw }, candidates: [] };
  }

  // derive slug candidates from a domain or bare slug
  let host = raw.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
  const label = host.split('.')[0];
  const candidates = Array.from(new Set([host, label, label.replace(/[^a-z0-9]/gi, '')])).filter(Boolean);
  return { explicit: null, candidates };
}

// Auto-detect: try each candidate slug against each platform; first that yields
// >=1 job wins. Cheap (a handful of HEAD-weight JSON probes) and keyless.
async function detect(candidates, opts) {
  for (const token of candidates) {
    for (const platform of DETECT_PLATFORMS) {
      try {
        const jobs = await ADAPTERS[platform](token, { ...opts, maxItems: 1 });
        if (jobs && jobs.length > 0) return { platform, token };
      } catch (e) {
        if (e.status && e.status !== 404 && e.status !== 400) {
          // transient/non-404 — not a clean "wrong platform" signal; keep trying others
        }
      }
    }
  }
  return null;
}

// Scrape one resolved (platform, token).
async function scrapeOne(platform, token, opts) {
  const fn = ADAPTERS[platform];
  if (!fn) throw new Error(`unknown platform: ${platform}`);
  const jobs = await fn(token, opts);
  const max = opts.maxItemsPerCompany;
  return max ? jobs.slice(0, max) : jobs;
}

/**
 * @param {object} input
 * @param {string[]} input.companies  domains / slugs / "platform:token"
 * @param {number}  [input.maxItemsPerCompany]
 * @param {boolean} [input.includeDescription]
 * @param {(ev:object)=>void} [onLog]
 * @returns {Promise<{jobs:object[], resolutions:object[]}>}
 */
export async function scrape(input, onLog = () => {}) {
  const companies = Array.isArray(input.companies) ? input.companies : [];
  const opts = {
    includeDescription: !!input.includeDescription,
    maxItemsPerCompany: Number(input.maxItemsPerCompany) || undefined,
  };

  const jobs = [];
  const resolutions = [];
  const seen = new Set();

  for (const entry of companies) {
    const { explicit, candidates } = parseEntry(entry);
    let resolved = explicit;
    if (!resolved) {
      resolved = await detect(candidates, opts);
    }
    if (!resolved) {
      resolutions.push({ input: entry, resolved: null, error: 'no ATS detected' });
      onLog({ level: 'warn', msg: `no ATS detected for "${entry}"` });
      continue;
    }
    try {
      const rows = await scrapeOne(resolved.platform, resolved.token, opts);
      let added = 0;
      for (const r of rows) {
        const key = `${r.source_platform}:${r.source_token}:${r.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        // trim stray whitespace on string fields (e.g. Ashby leading spaces)
        for (const f of ['title', 'location', 'department', 'team', 'employment_type']) {
          if (typeof r[f] === 'string') r[f] = r[f].trim() || null;
        }
        r.company = resolved.token;
        jobs.push(r);
        added += 1;
      }
      resolutions.push({ input: entry, resolved, count: added });
      onLog({ level: 'info', msg: `${entry} -> ${resolved.platform}/${resolved.token}: ${added} jobs` });
    } catch (e) {
      resolutions.push({ input: entry, resolved, error: String(e.message || e) });
      onLog({ level: 'warn', msg: `error for ${entry} (${resolved.platform}/${resolved.token}): ${e.message || e}` });
    }
  }

  return { jobs, resolutions };
}
