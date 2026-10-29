# Unified Jobs MCP Server

A zero-dependency [Model Context Protocol](https://modelcontextprotocol.io) server that gives an AI
agent one thing no single-source jobs tool does: a **cross-source, deduplicated jobs feed**. It
queries applicant-tracking systems, the LinkedIn public guest search, and the Hacker News
_"Who is hiring?"_ thread, then collapses the **same role seen on several sources into one canonical
record** — with a `sources[]` array and a union of the richest salary, longest description, and
earliest post date. The agent gets a clean list instead of three overlapping ones plus a dedup
problem of its own.

- **No API key, no account, no login.** All data comes from keyless public endpoints.
- **Zero dependencies.** Hand-rolled spec-conformant JSON-RPC 2.0 over stdio — no SDK, no transitive
  package tree in your agent's trust boundary. Installs and boots instantly under `npx`.
- **Public postings only.** No member data, no PII beyond public job fields.

## Install

Claude Desktop (`claude_desktop_config.json`) / Cursor / Cline / Continue:

```json
{
  "mcpServers": {
    "unified-jobs": {
      "command": "npx",
      "args": ["-y", "github:rezearcher/unified-jobs-mcp"]
    }
  }
}
```

Or run it directly:

```bash
npx -y github:rezearcher/unified-jobs-mcp
```

## Tools

### `search_unified_jobs`
The cross-source feed. Pull one or more companies' ATS boards (`companies[]`), search LinkedIn
(`keywords` + `location`), and/or the current HN thread — in a single call — and get back **one
deduplicated list**. The same role on several sources merges into one record:

```jsonc
{
  "title": "Backend Software Engineer - Infrastructure",
  "company": "Palantir",
  "location": "United States",
  "salary": "$135,000 - $200,000 / yr",
  "posted_at": "2026-10-14T00:00:00.000Z",
  "sources": [
    { "source_platform": "lever",    "url": "https://jobs.lever.co/palantir/..." },
    { "source_platform": "linkedin", "url": "https://www.linkedin.com/jobs/view/..." }
  ],
  "primary_url": "https://jobs.lever.co/palantir/...",
  "merged": true
}
```

Every result set reports dedup stats: `raw_source_hits`, `canonical_jobs`, `cross_source_merges`,
`collapsed`, `per_source_hits`.

| field | notes |
|-------|-------|
| `companies` | ATS companies: bare slug (`"stripe"`), domain (`"stripe.com"`), or `"platform:token"` (`"lever:palantir"`, `"workday:tenant.wd5:Site"`). ATS + token auto-detected for slugs/domains. |
| `keywords`, `location` | LinkedIn search (and `keywords` also filters HN). |
| `sources` | subset of `["ats","linkedin","hn"]`. Default: all three. |
| `maxPerSource` | cap rows per source before merge (default 25, max 200). |
| `maxResults` | cap canonical records after merge (optional). |
| `remoteOnly`, `dedupe`, `includeDescription` | booleans; `dedupe` defaults on. |

### `search_hn_hiring`
Just the current month's Hacker News _"Ask HN: Who is hiring?"_ thread, normalized into the same
schema. The monthly thread id is **auto-discovered** (it rotates on the 1st of every month) and each
free-text post header is parsed into structured fields. Optional `query` / `remoteOnly` filters.

### `list_sources`
The source families, how to address ATS companies, and exactly how the cross-source dedup behaves.
No network call.

## Sources

| family | coverage | keyless |
|--------|----------|---------|
| **ats** | Greenhouse, Lever, Ashby, SmartRecruiters, Workday, Recruitee, Workable | ✅ |
| **linkedin** | public guest job search (keywords + location) | ✅ (rate-limited on cloud IPs → degrades open) |
| **hn** | _"Who is hiring?"_ current-month thread | ✅ |

Every source is wrapped so a single source failing (e.g. LinkedIn's guest endpoint rate-limiting a
cloud IP) **never fails the whole call** — you get the sources that did return. The hosted metered
version adds Indeed and rotating residential proxies for volume.

## How the dedup works

- **Canonical key:** `company | title | city`, with legal suffixes stripped but seniority and role
  qualifiers kept — so `Backend - Infrastructure` and `Backend - Defense` stay distinct.
- **Merge:** scalar fields are first-non-null in source-rank order; salary is taken whole from the
  single richest source (kept internally consistent); `posted_at` is the earliest; description is the
  longest; `sources[]` accumulates every origin.
- **Degrade open:** a row with no derivable key is emitted as its own record with `merged: false` —
  never silently dropped.

## Maintenance

A GitHub Actions smoke workflow runs a real MCP client handshake plus a live cross-source pull on
every push and daily. The ATS and HN families gate it; LinkedIn is advisory (cloud-IP rate limits).
A genuine upstream shape change fails the roundtrip and opens a tracking issue automatically — the
feed is kept working, not left to rot.

## License

MIT © Grey Ridge Signals Group LLC
