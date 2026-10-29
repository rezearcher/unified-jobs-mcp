// HN "Who is hiring?" source orchestrator — the maintained, self-advancing moat made
// callable. Discovers the CURRENT monthly "Ask HN: Who is hiring?" thread (the id
// rotates on the 1st of every month — a buyer building this has to re-point every
// month AND re-parse the free-text header drift, which is exactly why they rent the
// maintained feed), fetches the comment tree, parses each loose human-written header
// into the same unified job schema the ATS adapters emit, and filters.
//
// Pure + injectable: discoverCurrentThread / fetchThreadItems take a fetchImpl, so the
// whole path is verifiable offline against a recorded fixture with plain `node`.

import { discoverCurrentThread, fetchThreadItems } from './fetch.js';
import { parseThread } from './parse.js';
import { normalizeCard } from './normalize.js';

function clampMax(v, def = 50, cap = 200) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), cap);
}

/**
 * Search the current HN "Who is hiring?" thread for normalized job postings.
 * @param {object} opts
 * @param {string} [opts.query]       case-insensitive substring over title/company/snippet
 * @param {boolean} [opts.remoteOnly] keep only posts classified remote
 * @param {number} [opts.maxResults]  cap rows returned (default 50, max 200)
 * @param {boolean} [opts.includeDescription] include the post snippet as description
 * @param {object} [deps]             { fetchImpl, thread, items } injection for tests
 * @returns {Promise<{thread:object, count:number, jobs:object[]}>}
 */
export async function searchHnHiring(opts = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch;
  const max = clampMax(opts.maxResults);
  const kw = String(opts.query || '').toLowerCase().trim();
  const wantRemote = opts.remoteOnly === true;

  const thread = deps.thread || await discoverCurrentThread({ fetchImpl });
  const item = deps.items || await fetchThreadItems(thread.id, { fetchImpl });
  const cards = parseThread(item);

  const jobs = [];
  for (const card of cards) {
    if (jobs.length >= max) break;
    if (wantRemote && card.remote !== true) continue;
    const row = normalizeCard(card, { includeDescription: !!opts.includeDescription });
    if (!row.title || !row.company) continue; // degrade open: never emit junk rows
    if (kw) {
      const hay = `${row.title} ${row.company} ${row.snippet || ''}`.toLowerCase();
      if (!hay.includes(kw)) continue;
    }
    jobs.push(row);
  }

  return {
    thread: { id: thread.id, title: thread.title, created_at: thread.created_at || null },
    count: jobs.length,
    jobs,
  };
}
