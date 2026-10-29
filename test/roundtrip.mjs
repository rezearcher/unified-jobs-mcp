#!/usr/bin/env node
// Real MCP client handshake against ./server.mjs over stdio: initialize ->
// notifications/initialized -> ping -> tools/list -> tools/call (list_sources, then a
// LIVE search_unified_jobs across ATS + HN, plus search_hn_hiring). Asserts
// spec-conformant framing and live cross-source data.
//
// GATING sources are ATS (greenhouse:stripe) and HN "Who is hiring?" — both keyless
// and reliable from a cloud runner. LinkedIn is ADVISORY: its guest endpoint
// rate-limits cloud IPs, so the test never gates on a LinkedIn row (degrade-open).
//
// Run: node test/roundtrip.mjs   (exit 0 = pass, non-zero = fail)

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, '..', 'server.mjs');

const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

const pending = new Map();
let nextId = 1;
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { console.error('NON-JSON line from server:', t); process.exit(1); }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

function rpc(method, params, { notify = false } = {}) {
  if (notify) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    return Promise.resolve(null);
  }
  const id = nextId++;
  const p = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout on ${method}`)); } }, 40000);
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return p;
}

let failures = 0;
function assert(cond, label) {
  if (cond) { console.log(`  PASS ${label}`); }
  else { console.log(`  FAIL ${label}`); failures++; }
}

function parseToolJSON(res) {
  const txt = res?.result?.content?.[0]?.text;
  try { return JSON.parse(txt); } catch { return { __raw: txt }; }
}

(async () => {
  // 1. initialize
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'roundtrip-test', version: '0' },
  });
  assert(init.result?.protocolVersion === '2025-06-18', 'initialize echoes supported protocolVersion');
  assert(init.result?.serverInfo?.name === 'greyridge-unified-jobs-mcp', 'initialize returns serverInfo');
  assert(!!init.result?.capabilities?.tools, 'initialize advertises tools capability');

  // 2. initialized notification (no reply expected)
  await rpc('notifications/initialized', {}, { notify: true });

  // 3. ping
  const pong = await rpc('ping', {});
  assert(pong.result && typeof pong.result === 'object', 'ping -> empty result');

  // 4. tools/list
  const list = await rpc('tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name).sort();
  assert(JSON.stringify(names) === JSON.stringify(['list_sources', 'search_hn_hiring', 'search_unified_jobs']), 'tools/list returns 3 tools');
  assert((list.result.tools || []).every((t) => t.inputSchema?.type === 'object'), 'every tool has an object inputSchema');

  // 5. list_sources (offline)
  const src = parseToolJSON(await rpc('tools/call', { name: 'list_sources', arguments: {} }));
  const fams = (src.sources || []).map((s) => s.family).sort();
  assert(JSON.stringify(fams) === JSON.stringify(['ats', 'hn', 'linkedin']), 'list_sources -> 3 families (ats, hn, linkedin)');
  assert(src.dedup?.default_on === true && typeof src.dedup?.canonical_key === 'string', 'list_sources describes dedup behavior');
  const ats = (src.sources || []).find((s) => s.family === 'ats');
  assert(Array.isArray(ats?.platforms) && ats.platforms.includes('greenhouse'), 'ats family lists platforms incl greenhouse');

  // 6. search_unified_jobs LIVE — ATS canary (greenhouse:stripe). Deterministic + fast.
  const ats1 = parseToolJSON(await rpc('tools/call', { name: 'search_unified_jobs', arguments: { companies: ['greenhouse:stripe'], sources: ['ats'], maxPerSource: 5 } }));
  assert(ats1.count >= 1, `search_unified_jobs(ats greenhouse:stripe) -> ${ats1.count} canonical jobs`);
  const r0 = (ats1.jobs || [])[0] || {};
  assert(!!r0.title && Array.isArray(r0.sources) && r0.sources.length >= 1 && r0.sources[0].source_platform === 'greenhouse', 'canonical record has title + sources[] with source_platform');
  assert(typeof ats1.stats?.cross_source_merges === 'number' && ats1.stats.raw_source_hits >= ats1.count, 'result carries dedup stats (raw_source_hits >= canonical_jobs)');
  assert(ats1.source_counts?.ats >= 1, 'source_counts reports ats hits');

  // 7. search_unified_jobs LIVE — cross-source ATS + HN in one call (merged feed).
  // HN is keyword-filtered to keep it small; the two sources rarely merge the SAME
  // role, so we assert the unified-feed SHAPE + that both source families contributed,
  // not a guaranteed cross_source_merge (which needs the same role on both sources).
  const multi = parseToolJSON(await rpc('tools/call', { name: 'search_unified_jobs', arguments: { companies: ['greenhouse:stripe'], keywords: 'engineer', sources: ['ats', 'hn'], maxPerSource: 8 } }));
  assert(multi.count >= 2, `search_unified_jobs(ats+hn) -> ${multi.count} canonical jobs`);
  assert(multi.source_counts?.ats >= 1 && multi.source_counts?.hn >= 1, `both families contributed (ats=${multi.source_counts?.ats}, hn=${multi.source_counts?.hn})`);
  assert((multi.jobs || []).every((r) => Array.isArray(r.sources) && r.sources.length >= 1), 'every canonical record carries a non-empty sources[]');
  assert((multi.query?.sources || []).join(',') === 'ats,hn', 'query echoes the requested source subset');

  // 8. search_hn_hiring LIVE — standalone current-month thread tool
  const hn = parseToolJSON(await rpc('tools/call', { name: 'search_hn_hiring', arguments: { query: 'engineer', maxResults: 10 } }));
  assert(hn.count >= 1, `search_hn_hiring(query=engineer) -> ${hn.count} live posts`);
  assert(!!hn.thread?.id && /who is hiring/i.test(hn.thread?.title || ''), `resolved current HN thread (${hn.thread?.title || '?'})`);
  const hj = (hn.jobs || [])[0] || {};
  assert(!!hj.title && !!hj.company && !!hj.url && hj.source_platform === 'hn', 'live HN post has title+company+url+source_platform=hn');

  // 9. error path: unknown method -> JSON-RPC -32601
  const bad = await rpc('does/not/exist', {});
  assert(bad.error?.code === -32601, 'unknown method -> -32601');

  // 10. tool error surfaces as isError tool result, not protocol error
  const toolErr = await rpc('tools/call', { name: 'search_unified_jobs', arguments: { sources: ['ats'] } });
  assert(toolErr.result?.isError === true, 'no companies/keywords + ats-only -> isError tool result');

  child.stdin.end();
  console.log(failures === 0 ? `\nALL PASS (${nextId - 1} roundtrips)` : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('harness error:', e); process.exit(1); });
