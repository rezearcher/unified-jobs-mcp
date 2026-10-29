// HN "Who is hiring?" free-text PARSER — the rot-prone moat made explicit. Each job
// post is a human-written comment with a loose, by-convention header line, e.g.
//   "Shepherd (Series B) | ONSITE | San Francisco, CA & New York City, NY ..."
//   "PrairieLearn (Remote US) — Full-Stack Software Engineer — TypeScript / Postgres"
//   "Sidekick Labs | Senior SWE | REMOTE (US Timezones) | Full-time | $170k to $230k"
// There is NO schema: delimiters vary (| vs em/en dash), field order varies, and the
// conventions drift month to month. Keeping that heuristic mapping isolated HERE means
// upkeep touches one file — which is the whole reason a buyer rents a maintained feed
// instead of writing + babysitting this regex pile themselves.

// ---- HTML -> text, keeping the first real apply/company link --------------
// HN comment HTML is <p>-separated with <a href="...">...</a> links and HTML
// entities (&#x2F; = /, &gt; etc.). We pull the first external http(s) link as the
// canonical URL, then flatten to text for header parsing.
const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&#x27;': "'", '&#x2F;': '/', '&#x2f;': '/', '&nbsp;': ' ',
};
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;|&lt;|&gt;|&quot;|&#39;|&#x27;|&#x2F;|&#x2f;|&nbsp;/g, (m) => ENTITIES[m] || m);
}

export function extractFirstUrl(html) {
  if (!html) return null;
  const m = String(html).match(/href="(https?:\/\/[^"]+)"/i);
  if (m) return decodeEntities(m[1]).split('?')[0];
  // fall back to a bare URL in the text
  const bare = decodeEntities(String(html).replace(/<[^>]+>/g, ' ')).match(/https?:\/\/[^\s)]+/i);
  return bare ? bare[0].replace(/[.,)]+$/, '').split('?')[0] : null;
}

export function htmlToText(html) {
  if (!html) return '';
  // <p> boundaries become paragraph breaks so the first line stays the header.
  const withBreaks = String(html).replace(/<p>/gi, '\n').replace(/<\/p>/gi, '\n');
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, ' '))
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// ---- field classifiers ----------------------------------------------------
const REMOTE_RE = /\bremote\b|\bwfh\b|\bwork from home\b|\bdistributed\b|\banywhere\b/i;
const ONSITE_RE = /\bon-?site\b|\bin-?office\b|\bin person\b/i;
const HYBRID_RE = /\bhybrid\b/i;
const SALARY_RE = /[$£€]\s?\d|\b\d{2,3}\s?[kK]\b|\bsalary\b|\bcomp(?:ensation)?\b|\bequity\b|\bbase\b/i;
const INTERN_RE = /\bintern(ship)?\b/i;
const FULLTIME_RE = /\bfull[\s-]?time\b|\bft\b/i;
const PARTTIME_RE = /\bpart[\s-]?time\b|\bcontract\b|\bfreelance\b/i;
// A field that is ONLY a URL or bare domain (no prose) is not a role title.
const URLISH_RE = /^\s*(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?\s*(?:\([^)]*\))?\s*$/i;
// A field that is ONLY an employment term is not a role title.
const EMPLOYMENT_ONLY_RE = /^\s*(?:full[\s-]?time|part[\s-]?time|contract|freelance|intern(?:ship)?|permanent|temporary|ft|pt|w2|c2c|1099)\s*$/i;
// Role-word signal: a field containing any of these is almost certainly the title,
// even if it also trips a looser classifier.
const ROLE_RE = /engineer|developer|scientist|manager|designer|\blead\b|director|architect|analyst|devops|\bsre\b|researcher|staff|senior|principal|founding|product|programmer|administrator|consultant|specialist|\bops\b|marketer|recruiter|\bhead of\b|\bvp\b|cto|ceo|intern/i;
// A location-ish field: has a comma-city, a US state code, a country word, or the
// word "remote"/a geographic qualifier. Deliberately loose; firstLocationToken in
// dedup.js does the final canonicalization.
const PLACE_RE = /,|\b[A-Z]{2}\b|\bUSA?\b|\bUK\b|\bEU\b|\bEurope\b|\bremote\b|\bcanada\b|\bgermany\b|\bindia\b|\btimezones?\b/i;

function classifyWorkplace(fields) {
  const blob = fields.join(' | ');
  const remote = REMOTE_RE.test(blob) ? true : (ONSITE_RE.test(blob) || HYBRID_RE.test(blob) ? false : null);
  let workplace = null;
  if (HYBRID_RE.test(blob)) workplace = 'hybrid';
  else if (REMOTE_RE.test(blob)) workplace = 'remote';
  else if (ONSITE_RE.test(blob)) workplace = 'onsite';
  return { remote, workplace };
}

function employmentFromText(blob) {
  if (INTERN_RE.test(blob)) return 'Intern';
  if (PARTTIME_RE.test(blob)) return 'Part-time/Contract';
  if (FULLTIME_RE.test(blob)) return 'Full-time';
  return null;
}

// Split the header line on the dominant delimiter. Prefer "|" when present (the
// strongest convention); otherwise split on a spaced em/en dash. Returns trimmed,
// non-empty fields.
export function splitHeader(line) {
  if (!line) return [];
  let parts;
  if (line.includes('|')) parts = line.split('|');
  else if (/\s[—–]\s/.test(line)) parts = line.split(/\s[—–]\s/);
  else parts = [line];
  return parts.map((p) => p.trim()).filter(Boolean);
}

// Company field often carries a trailing/leading URL or a "(Series B)" tag — keep
// the human name, drop the noise.
export function cleanCompany(field) {
  if (!field) return null;
  let c = field.replace(/https?:\/\/[^\s|]+/gi, ' '); // strip inline url
  c = c.replace(/\s{2,}/g, ' ').trim();
  // a trailing parenthetical stage tag ("(Series B)", "(YC S21)") is noise for the name
  c = c.replace(/\s*\((?:yc\b|series\b|seed\b)[^)]*\)\s*$/i, '').trim();
  return c || null;
}

/**
 * Parse ONE top-level HN comment into a raw job card (or null if it is clearly not a
 * job post — e.g. a meta/"please follow the format" comment with no header shape).
 * @param {object} comment  Algolia item child: { id, author, text, created_at }
 * @returns {object|null}
 */
export function parseComment(comment) {
  if (!comment || !comment.text) return null;
  const text = htmlToText(comment.text);
  if (!text) return null;
  const firstLine = text.split('\n')[0].trim();
  if (!firstLine) return null;

  const fields = splitHeader(firstLine);
  // A real post has either a delimited header (>=2 fields) OR a dash/pipe somewhere
  // in the first line; a bare prose sentence with none is almost always a meta reply.
  if (fields.length < 2) return null;

  const company = cleanCompany(fields[0]);
  if (!company || company.length > 80) return null; // runaway = not a header

  const rest = fields.slice(1);
  const { remote, workplace } = classifyWorkplace(fields);

  // Role/title = the first remaining field that is NOT a workplace tag, salary, pure
  // location, a bare URL/domain, or an employment-term-only field. A field carrying a
  // role word wins immediately. Falls back progressively so we never emit a URL, a
  // "Full-time", or a null as the title.
  const notTitle = (f) => URLISH_RE.test(f) || EMPLOYMENT_ONLY_RE.test(f)
    || REMOTE_RE.test(f) || ONSITE_RE.test(f) || HYBRID_RE.test(f) || SALARY_RE.test(f);
  let title = rest.find((f) => ROLE_RE.test(f) && !URLISH_RE.test(f))
    || rest.find((f) => !notTitle(f) && !(PLACE_RE.test(f) && !ROLE_RE.test(f)))
    || rest.find((f) => !notTitle(f))
    || null;
  if (title) {
    title = title.replace(/^https?:\/\/\S+\s*/i, '').replace(/^role\s*:\s*/i, ''); // drop a leading url / "Role:" label
    title = title.replace(/\s{2,}/g, ' ').trim().slice(0, 140);
  }
  if (!title || URLISH_RE.test(title) || EMPLOYMENT_ONLY_RE.test(title)) return null; // no real role => skip

  // Location = first field that looks like a place and is NOT the chosen title.
  let location = null;
  for (const f of rest) {
    if (f === title) continue;
    if (PLACE_RE.test(f) && !SALARY_RE.test(f)) { location = f.replace(/\s{2,}/g, ' ').trim(); break; }
  }

  // Salary = first field that looks like comp.
  let salaryText = null;
  for (const f of rest) { if (SALARY_RE.test(f)) { salaryText = f.trim(); break; } }

  const employment_type = employmentFromText(firstLine);
  const url = extractFirstUrl(comment.text);

  return {
    id: comment.id != null ? String(comment.id) : null,
    company,
    title,
    location,
    remote,
    workplace,
    salaryText,
    employment_type,
    url,
    author: comment.author || null,
    created_at: comment.created_at || null,
    snippet: text.slice(0, 500),
  };
}

/**
 * Parse a thread item tree's top-level children into raw job cards. Non-job comments
 * are skipped (degrade open — never throw on one odd post).
 */
export function parseThread(threadItem) {
  const children = (threadItem && Array.isArray(threadItem.children)) ? threadItem.children : [];
  const out = [];
  for (const c of children) {
    try {
      const card = parseComment(c);
      if (card) out.push(card);
    } catch { /* skip a single malformed post, keep the rest */ }
  }
  return out;
}
