// Extract job records from LinkedIn public guest-jobs HTML. This is the piece that
// ROTS: LinkedIn periodically reshapes its guest job-card markup and renames the
// criteria labels. Keeping extraction isolated here is the maintenance moat
// (NORTH_STAR law 2) — a markup change touches only this file. Pure string ->
// objects; no network.
//
// Two public surfaces:
//   /jobs-guest/jobs/api/seeMoreJobPostings/search  -> a <ul> of <li> job cards
//   /jobs-guest/jobs/api/jobPosting/<id>            -> one job's full detail
// Both return server-rendered HTML fragments (NOT JSON) for unauthenticated,
// public postings only.

import { normalizeCard, stripHtml } from './normalize.js';

const clean = (s) => (s == null ? null : stripHtml(s));

// First capture group of `re` against `src`, trimmed, or null.
function cap(src, re) {
  const m = re.exec(src);
  return m ? m[1].trim() : null;
}

// Inner HTML of the <tag> element whose opening tag contains `className`, honoring
// nested same-tag pairs so JD markup with nested <div>s survives. We anchor on the
// OPENING tag that carries the class (not the class position, which sits inside the
// attribute) so a nested child element is never mistaken for the container.
function innerHtmlByClass(html, className, tag) {
  const openRe = new RegExp(`<${tag}\\b[^>]*\\b${className}\\b[^>]*>`, 'i');
  const m = openRe.exec(html);
  if (!m) return null;
  return balanceFrom(html, m.index + m[0].length, tag);
}

// Balance <tag>/</tag> starting just after an opening tag at `start`.
function balanceFrom(html, start, tag) {
  const lc = html.toLowerCase();
  const openStr = `<${tag.toLowerCase()}`;
  const closeStr = `</${tag.toLowerCase()}>`;
  let depth = 1;
  let i = start;
  while (i < html.length && depth > 0) {
    const nextOpen = lc.indexOf(openStr, i);
    const nextClose = lc.indexOf(closeStr, i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) { depth += 1; i = nextOpen + openStr.length; }
    else { depth -= 1; if (depth === 0) return html.slice(start, nextClose); i = nextClose + closeStr.length; }
  }
  return null;
}

// ---- search results -----------------------------------------------------
// Parse ONE <li> job-card block into a raw card object (tolerant of whitespace
// and attribute reordering). Returns null if it carries no job id.
export function parseCard(block) {
  if (!block) return null;
  const jobId = cap(block, /data-entity-urn="urn:li:jobPosting:(\d+)"/i)
    || cap(block, /data-entity-urn="urn:li:jobPosting:([^"]+)"/i);

  let url = cap(block, /class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/i)
    || cap(block, /href="(https:\/\/[^"]*\/jobs\/view\/[^"]+)"/i);
  if (url) url = url.replace(/&amp;/g, '&');

  const title = clean(cap(block, /class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)<\/h3>/i));

  // company sits inside the subtitle, usually wrapped in an <a>; fall back to the
  // raw subtitle text if the anchor markup drifts.
  const subtitle = cap(block, /class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/h4>/i);
  const company = subtitle ? clean(cap(subtitle, /<a[^>]*>([\s\S]*?)<\/a>/i) || subtitle) : null;

  const location = clean(cap(block, /class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)<\/span>/i));

  // <time ... datetime="2026-10-08">3 weeks ago</time>
  const datetime = cap(block, /class="[^"]*job-search-card__listdate[^"]*"[^>]*datetime="([^"]+)"/i);
  const timeBlock = cap(block, /(<time[^>]*job-search-card__listdate[\s\S]*?<\/time>)/i)
    || cap(block, /(<time[\s\S]*?<\/time>)/i);
  const relativeTime = timeBlock ? clean(timeBlock.replace(/<[^>]+>/g, ' ')) : null;

  const salaryText = clean(cap(block, /class="[^"]*job-search-card__salary-info[^"]*"[^>]*>([\s\S]*?)<\/span>/i));

  if (!jobId && !url && !title) return null;
  return { jobId, url, title, company, location, datetime, relativeTime, salaryText };
}

// Parse a seeMoreJobPostings search fragment into normalized unified-schema jobs.
export function parseSearch(html, opts = {}) {
  if (!html) return [];
  // Each result is wrapped in a <li>; splitting on <li> is robust to the surrounding
  // <ul> class churn. The first chunk before the first <li> is preamble.
  const chunks = html.split(/<li\b[^>]*>/i).slice(1);
  const out = [];
  for (const chunk of chunks) {
    const card = parseCard(chunk);
    if (card && (card.jobId || card.url)) out.push(normalizeCard(card, opts));
  }
  return out;
}

// ---- job detail ---------------------------------------------------------
// Parse the criteria list (Seniority level / Employment type / Job function /
// Industries) into a {label: value} map, iterating per criteria <li> so a nested
// span inside the value does not misalign pairs.
export function parseCriteria(html) {
  const out = {};
  const re = /class="[^"]*description__job-criteria-item[^"]*"[^>]*>([\s\S]*?)<\/li>/ig;
  let m;
  while ((m = re.exec(html)) !== null) {
    const item = m[1];
    const label = clean(cap(item, /description__job-criteria-subheader[^>]*>([\s\S]*?)<\/h3>/i));
    const value = clean(cap(item, /description__job-criteria-text[^>]*>([\s\S]*?)<\/span>/i));
    if (label && value) out[label] = value;
  }
  return Object.keys(out).length ? out : null;
}

// Parse a /jobs-guest/jobs/api/jobPosting/<id> fragment into detail fields.
export function parseJobDetail(html) {
  if (!html) return null;
  const descriptionHtml = innerHtmlByClass(html, 'show-more-less-html__markup', 'div') || null;

  const rawSalary = innerHtmlByClass(html, 'compensation__salary', 'div')
    || innerHtmlByClass(html, 'compensation__salary', 'span');
  const salaryText = clean(rawSalary);

  const criteria = parseCriteria(html);
  const employmentType = criteria
    ? (Object.entries(criteria).find(([k]) => /employment type/i.test(k)) || [])[1] || null
    : null;

  if (!descriptionHtml && !criteria && !salaryText) return null;
  return {
    descriptionHtml: descriptionHtml ? descriptionHtml.trim() : null,
    description_text: descriptionHtml ? stripHtml(descriptionHtml) : null,
    salaryText,
    employmentType,
    criteria,
  };
}
