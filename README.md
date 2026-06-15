# Open Brain — Setup

A personal [Open Brain](https://github.com/NateBJones-Projects/OB1) deployment: a
persistent thought store + knowledge graph on Supabase, with a set of MCP
extensions that build structured, queryable household and professional data on
top of it.

This repo holds the **deployable Supabase project** — the Edge Function MCP
servers, the database schema docs, and the SQL jobs. The shared brain
infrastructure it's built on lives upstream in [OB1](https://github.com/NateBJones-Projects/OB1).

## What's in here

| Path | What it is |
|---|---|
| `supabase/functions/` | Edge Function MCP servers (see table below) |
| `supabase/config.toml` | Supabase project config |
| `sql/entity_drain.sql` | Nightly `pg_cron` job that drains the entity-extraction queue |
| `docs/ARCHITECTURE.md` | End-to-end data flow (thought → knowledge graph, household scheduling) |
| `docs/SCHEMA.md` | Full database ERD |

### MCP servers

| Function | Purpose |
|---|---|
| `open-brain-mcp` | Capture and search thoughts |
| `entity-extraction-worker` | Drains the extraction queue, calls an LLM, populates entities + edges |
| `family-calendar-mcp` | Household roster, locations, events, scheduling |
| `household-knowledge-mcp` | Household items + vendors |
| `professional-crm-mcp` | CRM contacts, interactions, opportunities |
| `organizations-mcp` | Canonical `organizations` dimension (find/create/merge/link) |
| `job-hunt-mcp` | Job postings, applications, interviews |

All extensions share a **unified `contacts` table**, distinguished by `tags[]`
(`household_member`, `vendor`, `professional`). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
for the full picture and [docs/SCHEMA.md](docs/SCHEMA.md) for the schema.

## Getting started

### Prerequisites

- A [Supabase](https://supabase.com) project (free tier works)
- The [Supabase CLI](https://supabase.com/docs/guides/cli) (`supabase --version`)
- An LLM API key for entity extraction — one of `OPENROUTER_API_KEY`,
  `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`
- New to Open Brain? Start with the upstream
  [OB1 getting-started guide](https://github.com/NateBJones-Projects/OB1/blob/main/docs/01-getting-started.md)
  to stand up the core `thoughts` store first.

### 1. Clone and link

```bash
git clone https://github.com/hannahgwilson/open-brain-setup.git
cd open-brain-setup
supabase link --project-ref <YOUR_PROJECT_REF>
```

`supabase link` regenerates the local `supabase/.temp/` state (gitignored).

### 2. Set secrets

The Edge Functions read all credentials from Supabase secrets — nothing is
committed to this repo. Set them once:

```bash
supabase secrets set SUPABASE_URL=https://<YOUR_PROJECT_REF>.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<service-role-key>   # Dashboard > Project Settings > API
supabase secrets set DEFAULT_USER_ID=<your-auth-user-uuid>
supabase secrets set MCP_ACCESS_KEY=<64-char-hex>                   # shared secret for MCP endpoint URLs
supabase secrets set OPENROUTER_API_KEY=<key>                       # or ANTHROPIC_API_KEY / OPENAI_API_KEY
```

### 3. Apply the schema

Schema changes are applied through the Supabase SQL editor. Because of
cross-extension foreign keys, apply in this order — `family-calendar` defines
the `contacts` table that several others reference:

1. Core `thoughts` + `match_thoughts` (from the OB1 getting-started guide)
2. `enhanced-thoughts`
3. `entity-extraction`
4. `family-calendar` (creates `contacts`, `locations`, `events`)
5. `household-knowledge`
6. `professional-crm`
7. `organizations` (adds FK columns to `contacts` and `entities`)
8. `job-hunt`

The canonical `schema.sql` for each extension lives in the upstream OB1 repo.

### 4. Deploy the Edge Functions

```bash
supabase functions deploy open-brain-mcp --no-verify-jwt
supabase functions deploy entity-extraction-worker --no-verify-jwt
supabase functions deploy family-calendar-mcp --no-verify-jwt
supabase functions deploy household-knowledge-mcp --no-verify-jwt
supabase functions deploy professional-crm-mcp --no-verify-jwt
supabase functions deploy organizations-mcp --no-verify-jwt
supabase functions deploy job-hunt-mcp --no-verify-jwt
```

> **Always deploy a function with its `deno.json` present.** The bundler reads
> the per-function `deno.json` to resolve `npm:` imports. A missing import map
> fails the deploy with a misleading HTTP 400
> (`Relative import path "@supabase/supabase-js" not prefixed with / or ../`).
> If a function has a `_shared/` folder, it ships automatically alongside `index.ts`.

### 5. (Optional) Schedule the entity-extraction drain

Apply [`sql/entity_drain.sql`](sql/entity_drain.sql) in the SQL editor to run a
nightly `pg_cron` job that drains the `entity_extraction_queue` through the
worker. Edit the `<PROJECT_REF>` placeholder and brain key in the
`cron.schedule` block first.

### 6. Connect a client

Add the MCP endpoint URLs to Claude Desktop (or any MCP client) as custom
connectors. Each URL includes the access key as a query param:

```
https://<YOUR_PROJECT_REF>.supabase.co/functions/v1/<function-name>?key=<MCP_ACCESS_KEY>
```

## Operational notes

- **Service-role bypasses RLS.** All MCPs use the service-role key. RLS is in
  place for future multi-user scenarios but doesn't affect single-user operation.
- **The SQL editor doesn't halt on errors** — a failed statement doesn't stop
  the rest. Wrap related work in `DO $$ BEGIN ... END $$;` for atomicity.
- **The MCP tool registry caches at session start.** Restart your client after
  redeploying to pick up new tools.
- **Edge Functions are memory-capped** (256MB free / 512MB Pro). If
  `entity-extraction-worker` OOMs on a large batch, call it with `?limit=3`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for more.
