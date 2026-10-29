#!/usr/bin/env node
// Grey Ridge unified-jobs-mcp — a zero-dependency Model Context Protocol server
// exposing the one thing no single-source jobs tool offers an agent: a CROSS-SOURCE
// deduplicated, field-unioned jobs feed. It queries applicant-tracking systems
// (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Recruitee, Workable), the
// LinkedIn public guest search, and the Hacker News "Who is hiring?" thread, then
// collapses the same role seen on several sources into ONE canonical record with a
// sources[] array and a union of the richest salary / description / earliest post
// date. The agent gets one clean list instead of three overlapping ones plus a dedup
// problem of its own.
//
// Transport: MCP stdio — newline-delimited JSON-RPC 2.0 on stdin/stdout, per the
// Model Context Protocol spec. No SDK, no dependencies: it installs and boots
// instantly under `npx` and drags in no transitive package surface (the thing an
// agent tool should least of all carry). See test/roundtrip.mjs for a real client
// handshake against live data.
//
// All data comes from keyless public endpoints via the vendored cores in ./src — the
// same maintained layer behind the Grey Ridge jobs feed. SCOPE: public postings only,
// no login, no member data.

import { scrape as atsScrape } from './src/sources/ats/scrape.js';
import { PLATFORMS } from './src/sources/ats/adapters.js';
import { parseSearch as liParseSearch } from './src/sources/linkedin/parse.js';
import { searchHnHiring } from './src/sources/hn/index.js';
import { dedupe, dedupStats } from './src/dedup.js';
import { createInterface } from 'node:readline';

const SERVER_INFO = { name: 'greyridge-unified-jobs-mcp', version: '0.1.0' };
const DEFAULT_PROTOCOL = '2025-06-18';
const SUPPORTED_PROTOCOLS = new Set(['2025-06-18', '2025-03-26', '2024-11-05']);

const ALL_SOURCES = ['ats', 'linkedin', 'hn'];

// ---- zero-dep LinkedIn guest search (native fetch; no got-scraping) --------
// Mirrors the keyless path in the public unified-jobs CLI: the LinkedIn guest
// endpoint rate-limits cloud IPs, so a block degrades open (we return what the other
// sources gave) rather than failing the whole call — the hosted Apify actor adds
// rotating residential proxies for volume.
const LI_GUEST = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
function liSearchUrl({ keywords, location, start = 0 }) {
  const p = new URLSearchParams();
  if (keywords) p.set('keywords', keywords);
  if (location) p.set('location', location);
  if (start) p.set('start', String(start));
  return `${LI_GUEST}?${p.toString()}`;
}
async function linkedinSearch({ keywords, location }, max, onLog) {
  const out = [];
  const seen = new Set();
  const PAGE = 10;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  for (let page = 0; page * PAGE < max + PAGE && out.length < max; page += 1) {
    const url = liSearchUrl({ keywords, location, start: page * PAGE });
    let res;
    try { res = await fetch(url, { headers }); }
    catch (e) { onLog(`linkedin fetch error: ${e.message}`); break; }
    if (!res.ok) { onLog(`linkedin HTTP ${res.status} (guest endpoint rate-limits cloud IPs; use the hosted actor for volume)`); break; }
    const html = await res.text();
    const jobs = liParseSearch(html);
    if (jobs.length === 0) break;
    for (const j of jobs) {
      if (out.length >= max) break;
      const k = j.job_key || j.url;
      if (seen.has(k)) continue;
      seen.add(k);
      j.source_family = 'linkedin';
      j.source_platform = j.source_platform || 'linkedin';
      out.push(j);
    }
  }
  return out;
}

// ---- tool definitions -----------------------------------------------------

const TOOLS = [
  {
    name: 'search_unified_jobs',
    description:
      'Cross-source job search that returns ONE deduplicated, field-unioned feed across applicant-tracking ' +
      'systems (Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Recruitee, Workable), the LinkedIn public ' +
      'guest search, and the Hacker News "Who is hiring?" thread. The SAME role posted on several sources is ' +
      'merged into one canonical record with a sources[] array and a union of the richest salary / longest ' +
      'description / earliest posted_at — so you get a clean list, not three overlapping ones to dedupe yourself. ' +
      'Provide companies[] to pull their ATS boards, and/or keywords(+location) to search LinkedIn; HN returns ' +
      'the whole current thread (optionally keyword-filtered). At least one of companies[] or keywords is ' +
      'required unless hn is in sources. Returns canonical records plus dedup stats (cross_source_merges).',
    inputSchema: {
      type: 'object',
      properties: {
        companies: {
          type: 'array',
          items: { type: 'string' },
          description: 'ATS companies as bare slug ("stripe"), domain ("stripe.com"), or "platform:token" ("lever:palantir", "workday:tenant.wd5:Site"). Auto-detected for slugs/domains.',
        },
        keywords: {
          type: 'string',
          description: 'Search query for LinkedIn and the HN keyword filter (e.g. "backend engineer", "rust").',
        },
        location: {
          type: 'string',
          description: 'Location filter for the LinkedIn search (e.g. "United States", "Berlin").',
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: ALL_SOURCES },
          description: 'Subset of ["ats","linkedin","hn"] to query. Default: all three.',
        },
        maxPerSource: {
          type: 'integer',
          description: 'Cap rows pulled from each source before merge (default 25, max 200).',
          default: 25,
        },
        maxResults: {
          type: 'integer',
          description: 'Cap canonical records returned after merge (optional).',
        },
        remoteOnly: {
          type: 'boolean',
          description: 'Keep only postings classified as remote. Default false.',
          default: false,
        },
        dedupe: {
          type: 'boolean',
          description: 'Merge the same role across sources into one record. Default true. Set false to emit every source hit 1:1.',
          default: true,
        },
        includeDescription: {
          type: 'boolean',
          description: 'Include full/long description text where a source provides it (heavier payload). Default false.',
          default: false,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_hn_hiring',
    description:
      'Search the CURRENT month\'s Hacker News "Ask HN: Who is hiring?" thread for live job postings, normalized ' +
      'into the same unified schema as search_unified_jobs. The monthly thread id is auto-discovered (it rotates ' +
      'on the 1st of every month) and each free-text post header is parsed into structured fields. No company ' +
      'list needed — this is the whole thread, optionally keyword / remote filtered. source_platform is "hn".',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Case-insensitive substring over title + company + snippet (e.g. "rust", "senior backend"). Omit for all posts.' },
        remoteOnly: { type: 'boolean', description: 'Keep only postings classified as remote. Default false.', default: false },
        maxResults: { type: 'integer', description: 'Cap postings returned (default 50, max 200).', default: 50 },
        includeDescription: { type: 'boolean', description: 'Include the post body snippet as the description. Default false.', default: false },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_sources',
    description:
      'List the job sources this server merges across, how to address ATS companies, and how the cross-source ' +
      'dedup/merge behaves (canonical key, field union, degrade-open). No network call.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

// ---- tool handlers ---------------------------------------------------------

function clampMax(v, def = 25) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), 200);
}

function pickSources(arg) {
  if (!Array.isArray(arg) || arg.length === 0) return [...ALL_SOURCES];
  const want = arg.map((s) => String(s).toLowerCase()).filter((s) => ALL_SOURCES.includes(s));
  return want.length ? [...new Set(want)] : [...ALL_SOURCES];
}

async function toolSearchUnifiedJobs(args) {
  const companies = Array.isArray(args?.companies) ? args.companies.filter((c) => typeof c === 'string' && c.trim()) : [];
  const keywords = typeof args?.keywords === 'string' ? args.keywords.trim() : '';
  const location = typeof args?.location === 'string' ? args.location.trim() : '';
  const sources = pickSources(args?.sources);
  const maxPerSource = clampMax(args?.maxPerSource, 25);
  const remoteOnly = !!args?.remoteOnly;
  const includeDescription = !!args?.includeDescription;
  const doDedupe = args?.dedupe !== false;
  const logs = [];
  const onLog = (m) => logs.push(typeof m === 'string' ? m : (m?.msg || JSON.stringify(m)));

  const wantAts = sources.includes('ats') && companies.length > 0;
  const wantLi = sources.includes('linkedin') && (keywords || location);
  const wantHn = sources.includes('hn');

  if (!wantAts && !wantLi && !wantHn) {
    throw new Error('provide companies[] (for ATS), keywords(+location) (for LinkedIn), or include "hn" in sources');
  }

  const errors = {};
  const source_counts = { ats: 0, linkedin: 0, hn: 0 };

  const tasks = [
    // ATS
    (async () => {
      if (!wantAts) return [];
      try {
        const { jobs } = await atsScrape({ companies, maxItemsPerCompany: maxPerSource, includeDescription }, (e) => onLog({ source: 'ats', ...e }));
        for (const j of jobs) j.source_family = 'ats';
        source_counts.ats = jobs.length;
        return jobs;
      } catch (e) { errors.ats = String(e.message || e); onLog(`ats failed: ${e.message}`); return []; }
    })(),
    // LinkedIn (keyless guest; degrades open on cloud-IP rate limit)
    (async () => {
      if (!wantLi) return [];
      try {
        const jobs = await linkedinSearch({ keywords, location }, maxPerSource, onLog);
        source_counts.linkedin = jobs.length;
        return jobs;
      } catch (e) { errors.linkedin = String(e.message || e); onLog(`linkedin failed: ${e.message}`); return []; }
    })(),
    // HN "Who is hiring?" (keyless whole-thread)
    (async () => {
      if (!wantHn) return [];
      try {
        const { jobs } = await searchHnHiring({ query: keywords || undefined, remoteOnly, maxResults: maxPerSource, includeDescription });
        for (const j of jobs) { j.source_family = 'hn'; j.source_platform = j.source_platform || 'hn'; }
        source_counts.hn = jobs.length;
        return jobs;
      } catch (e) { errors.hn = String(e.message || e); onLog(`hn failed: ${e.message}`); return []; }
    })(),
  ];

  const [atsJobs, liJobs, hnJobs] = await Promise.all(tasks);

  // remoteOnly also filters ATS/LinkedIn rows (HN already filtered inside searchHnHiring)
  let pool = [...atsJobs, ...liJobs, ...hnJobs];
  if (remoteOnly) pool = pool.filter((j) => j.source_family === 'hn' ? true : j.remote === true);

  let records = dedupe(pool, { dedupe: doDedupe });
  if (args?.maxResults && records.length > Number(args.maxResults)) records = records.slice(0, Number(args.maxResults));
  const stats = dedupStats(pool.length, records);

  return {
    query: { companies, keywords: keywords || null, location: location || null, sources, maxPerSource, remoteOnly, dedupe: doDedupe, includeDescription },
    source_counts,
    stats,
    errors,
    count: records.length,
    jobs: records,
  };
}

async function toolSearchHnHiring(args) {
  const opts = {
    query: typeof args?.query === 'string' ? args.query : undefined,
    remoteOnly: !!args?.remoteOnly,
    maxResults: args?.maxResults,
    includeDescription: !!args?.includeDescription,
  };
  const { thread, count, jobs } = await searchHnHiring(opts);
  return {
    query: {
      query: opts.query ?? null,
      remoteOnly: opts.remoteOnly,
      maxResults: Number(args?.maxResults) > 0 ? Math.min(Math.floor(Number(args.maxResults)), 200) : 50,
      includeDescription: opts.includeDescription,
    },
    source: 'hackernews-whoishiring',
    thread,
    count,
    jobs,
  };
}

function toolListSources() {
  return {
    sources: [
      { family: 'ats', platforms: PLATFORMS, addressing: 'bare slug "stripe", domain "stripe.com", or "platform:token" (e.g. lever:palantir, workday:tenant.wd5:Site). Auto-detected for slugs/domains.', keyless: true },
      { family: 'linkedin', note: 'LinkedIn public guest job search by keywords+location. Guest endpoint rate-limits cloud IPs; degrades open. Public postings only, no login/member data.', keyless: true },
      { family: 'hn', note: 'Hacker News "Who is hiring?" current-month thread, auto-discovered + parsed into the unified schema. Zero config — returns a feed from an empty input.', keyless: true },
    ],
    dedup: {
      default_on: true,
      canonical_key: 'company | title | city (legal suffix stripped; seniority + role qualifier KEPT so "Backend - Infra" and "Backend - Defense" stay distinct)',
      merge: 'first-non-null scalar fields in source-rank order; salary taken whole from the single richest source; earliest posted_at; longest description; sources[] accumulates every origin (source_platform, url, posted_at).',
      degrade_open: 'rows with no derivable key are emitted as their own records with merged=false — never silently dropped.',
      stats: 'each result set reports raw_source_hits, canonical_jobs, cross_source_merges, collapsed, per_source_hits.',
    },
    schema: ['title', 'company', 'company_domain', 'location', 'remote', 'employment_type', 'department', 'seniority_level', 'salary(min/max/currency/period)', 'posted_at(ISO)', 'description_text', 'sources[]', 'primary_url', 'merged'],
    scope: 'public postings only; no login, no member data, no PII beyond public job fields.',
    note: 'The free hosted no-account surfaces (this MCP server + the unified-jobs CLI) cover keyless ATS+LinkedIn+HN. The metered Apify actor adds Indeed + rotating residential proxies + per-result billing.',
  };
}

async function dispatchTool(name, args) {
  switch (name) {
    case 'search_unified_jobs': return toolSearchUnifiedJobs(args);
    case 'search_hn_hiring': return toolSearchHnHiring(args);
    case 'list_sources': return toolListSources();
    default: throw new Error(`unknown tool: ${name}`);
  }
}

// ---- JSON-RPC / MCP plumbing ----------------------------------------------

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function result(id, res) { send({ jsonrpc: '2.0', id, result: res }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== null && msg.id !== undefined;
  if (!isRequest) return; // notifications — never reply

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL;
      result(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'Cross-source jobs feed. Call list_sources to see coverage and dedup behavior, search_unified_jobs to ' +
          'pull a merged feed across ATS boards + LinkedIn + Hacker News (the same role across sources collapses ' +
          'into one canonical record with a sources[] array), and search_hn_hiring for just the current HN thread.',
      });
      return;
    }
    case 'ping':
      result(id, {});
      return;
    case 'tools/list':
      result(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments || {};
      try {
        const data = await dispatchTool(name, args);
        result(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        result(id, { content: [{ type: 'text', text: `error: ${e?.message || String(e)}` }], isError: true });
      }
      return;
    }
    default:
      error(id, -32601, `method not found: ${method}`);
  }
}

function main() {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let inFlight = 0;
  let closed = false;
  const maybeExit = () => { if (closed && inFlight === 0) process.exit(0); };

  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let msg;
    try { msg = JSON.parse(text); }
    catch { error(null, -32700, 'parse error'); return; }
    inFlight += 1;
    handle(msg)
      .catch((e) => { if (msg && msg.id !== undefined && msg.id !== null) error(msg.id, -32603, `internal error: ${e?.message || e}`); })
      .finally(() => { inFlight -= 1; maybeExit(); });
  });
  rl.on('close', () => { closed = true; maybeExit(); });
}

main();
