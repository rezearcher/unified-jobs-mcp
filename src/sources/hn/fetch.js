// HN "Who is hiring?" source — network layer. Two keyless Algolia HN endpoints,
// no account, no key (free COGS):
//   • discovery  — the monthly thread ID ROTATES (a fresh "Ask HN: Who is hiring?"
//     is posted by the @whoishiring bot on the 1st of every month). A buyer building
//     this themselves has to re-point at the new thread every month AND handle the
//     free-text drift below — THAT recurring upkeep is exactly why they rent the
//     maintained feed instead (NORTH_STAR law 2).
//   • items      — the full comment tree for one thread; top-level children are the
//     individual job posts.
//
// fetchImpl is INJECTED (defaults to global fetch) so the whole source is verifiable
// offline against recorded fixtures with plain `node` — no network in CI.

const UA = 'Mozilla/5.0 (compatible; GreyRidge-Jobs-Feed/1.0)';
const ALGOLIA = 'https://hn.algolia.com/api/v1';

const noopLog = () => {};

// Bounded-downside: even though the host is fixed (hn.algolia.com), a stalled or
// unbounded response during a customer run must not hang the actor forever. Arm an
// AbortController timeout; injected test fetchImpls simply ignore the signal, so
// offline fixture tests behave identically.
const REQUEST_TIMEOUT_MS = 30000;

async function getJSON(url, fetchImpl) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': UA },
      signal: ctl.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } catch (e) {
    if (e && e.name === 'AbortError') {
      throw new Error(`request timed out after ${REQUEST_TIMEOUT_MS}ms for ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// A "Who is hiring?" story title, excluding the sibling "Who wants to be hired?" and
// "Freelancer?" monthly threads the same bot posts at the same timestamp.
export function isHiringThread(title) {
  if (!title) return false;
  const t = String(title).toLowerCase();
  return /who\s+is\s+hiring/.test(t) && !/wants\s+to\s+be\s+hired|freelancer/.test(t);
}

/**
 * Find the CURRENT month's "Who is hiring?" thread. Queries the @whoishiring bot's
 * stories newest-first and takes the first title that is a hiring thread — so it
 * auto-advances on the 1st of each month with zero code change (the moat).
 * @returns {Promise<{id:string,title:string,created_at:string}>}
 */
export async function discoverCurrentThread({ fetchImpl = fetch, log = noopLog } = {}) {
  const url = `${ALGOLIA}/search_by_date?tags=story,author_whoishiring&hitsPerPage=12`;
  const data = await getJSON(url, fetchImpl);
  const hits = Array.isArray(data.hits) ? data.hits : [];
  const hit = hits.find((h) => isHiringThread(h.title));
  if (!hit) {
    const err = new Error('no current "Who is hiring?" thread found in whoishiring feed');
    err.code = 'NO_THREAD';
    throw err;
  }
  log({ level: 'info', msg: `current HN thread: ${hit.title} (${hit.objectID})` });
  return { id: String(hit.objectID), title: hit.title, created_at: hit.created_at };
}

/**
 * Fetch one thread's full item tree. Top-level `children` are the job posts.
 * @returns {Promise<object>} the Algolia item object (has .children[])
 */
export async function fetchThreadItems(threadId, { fetchImpl = fetch } = {}) {
  return getJSON(`${ALGOLIA}/items/${encodeURIComponent(threadId)}`, fetchImpl);
}
