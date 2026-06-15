# Architecture

How the pieces fit together end-to-end.

## The big picture

```
┌────────────────────────────────────────────────────────────────────────┐
│                            Supabase Project                            │
│                                                                        │
│  ┌────────────────────┐    ┌────────────────────────────────────────┐  │
│  │    PostgreSQL      │    │            Edge Functions              │  │
│  │                    │    │                                        │  │
│  │  ┌──────────────┐  │    │  ┌──────────────────────────────────┐  │  │
│  │  │  thoughts    │  │◄───┤  │  open-brain-mcp                  │  │  │
│  │  │  entities    │  │    │  │  family-calendar-mcp             │  │  │
│  │  │  edges       │  │    │  │  household-knowledge-mcp         │  │  │
│  │  │  contacts    │  │    │  │  professional-crm-mcp            │  │  │
│  │  │  events      │  │    │  │  entity-extraction-worker        │  │  │
│  │  │  ...         │  │    │  └──────────────────────────────────┘  │  │
│  │  └──────────────┘  │    │                                        │  │
│  └────────────────────┘    └────────────────────────────────────────┘  │
└──────────────────▲─────────────────────▲──────────────────▲────────────┘
                   │                     │                  │
                   │ HTTPS               │ HTTPS            │ HTTPS
                   │                     │                  │
       ┌───────────┴────────┐  ┌─────────┴─────────┐  ┌─────┴────────┐
       │  Claude Desktop    │  │ weekly_schedule   │  │  Other       │
       │  (MCP client)      │  │ Python app        │  │  clients     │
       └────────────────────┘  └───────────────────┘  └──────────────┘
```

## Data flow: thought → knowledge graph

1. A thought lands in `thoughts` (via `open-brain-mcp`'s `capture_thought` tool, or a recipe importer).
2. The `queue_entity_extraction` trigger fires, inserting a row in `entity_extraction_queue` with `status='pending'`.
3. `entity-extraction-worker` Edge Function is invoked (curl or cron). It:
   - Claims pending queue items atomically (`status='processing'`).
   - For each thought, calls an LLM (OpenRouter / Anthropic / OpenAI) to extract entities + relationships.
   - Upserts into `entities`, `edges`, `thought_entities`.
   - Marks queue item `status='complete'`.
4. When a `entities.canonical_name` (case-insensitive) matches a `contacts.name` or `locations.name`, the bridge FKs (`entities.contact_id` / `entities.location_id`) get populated.

That last step lets you join thoughts → entities → contacts to ask "what
have we discussed about Marthe?" with full SQL — no fuzzy matching at query
time.

## Data flow: household scheduling

The `weekly_schedule` Python app:

```
config.yaml ───┐
               ├──→ load_config() ──→ Claude API ──→ weekly schedule text ──→ clipboard
Supabase ──────┘                        ▲
  ↑                                      │
  └── db.py (supabase-py reads) ─────────┘
                                         │
                                    GCal events
                                         │
                                  Open Brain notes
                                  (MCP semantic search)
```

`config.yaml` now holds only app-behavior settings (output format, emoji
map, regex filters, dinner-negotiable list). Household data lives in
Supabase. `db.py` fetches `contacts`, `household_details`, `pets`, `events`,
`pet_walks`, `caregiver_daily_hours`, `dinner_defaults`, and shapes them
into the dict structure `generate_schedule.py` expects.

## MCP layer

Each MCP is a deployed Edge Function that exposes tools via the Model Context
Protocol. Claude Desktop connects via custom connector URLs.

| MCP | Tools | Notes |
|---|---|---|
| `open-brain-mcp` | `capture_thought`, `search`, `fetch`, `list_thoughts`, `search_thoughts`, `thought_stats` | Core thought management |
| `family-calendar-mcp` | `add_contact`, `list_contacts`, `update_contact`, `add_pet`, `list_pets`, `set_household_details`, `get_household_member`, `add_location`, `list_locations`, `add_event`, `get_week_schedule`, `search_events`, `set_caregiver_daily_hours`, `set_pet_walk`, `set_dinner_default`, `list_dinner_defaults`, `add_important_date`, `get_upcoming_dates` | Unified contacts model |
| `household-knowledge-mcp` | `add_household_item`, `search_household_items`, `get_item_details`, `add_vendor`, `list_vendors` | Vendor tools write to `contacts` with `tags=['vendor']` |
| `professional-crm-mcp` | `crm_add_contact`, `crm_search_contacts`, `crm_log_interaction`, `crm_get_contact_history`, `crm_create_opportunity`, `crm_get_follow_ups`, `crm_update_contact`, `crm_link_thought`, `crm_prep_context`, `crm_stale_contacts` | All filter `contacts` by `tags=['professional']` |
| `entity-extraction-worker` | (No tools — invoked via HTTP POST with `?limit=N`) | Drains the extraction queue |

## Authentication & access

- **Service-role key** (`SUPABASE_SERVICE_ROLE_KEY`) is set as a Supabase secret. All MCPs and the Python app use it. Bypasses RLS.
- **`MCP_ACCESS_KEY`** (64-char hex) is the shared secret for MCP endpoints. Claude Desktop URLs include it as `?key=...`.
- **`DEFAULT_USER_ID`** is the auth user UUID. Scopes all data via the `user_id` column on every table.

All three are set via `supabase secrets set NAME=value`. They live in the
Supabase project and are auto-injected into Edge Functions.

## Deployment workflow

```bash
# Edit canonical source
$EDITOR /Users/hannah/repos/OB1/extensions/<name>/index.ts

# Copy to deployed location
cp /Users/hannah/repos/OB1/extensions/<name>/index.ts \
   /Users/hannah/repos/open-brain/supabase/functions/<name>-mcp/index.ts

# Deploy
cd /Users/hannah/repos/open-brain
supabase functions deploy <name>-mcp --no-verify-jwt
```

The URL and access key stay the same across deploys, so Claude Desktop
connections don't need to be reconfigured.

## What lives where

| Concept | Source of truth |
|---|---|
| Household roster (who Hannah lives with) | `contacts` + `household_details` in Supabase |
| Recurring events (swim, coop, cleaner) | `events` table in Supabase |
| Schedule output formatting | `weekly_schedule/config.yaml` (yaml) |
| Knowledge graph nodes | `entities` (populated by LLM worker from `thoughts`) |
| Real-time calendar events | Google Calendar (read at run time by `weekly_schedule`) |
| Captured notes | `thoughts` (via Open Brain MCP) |
| Edge Function source | `OB1/extensions/<name>/index.ts` |
| Deployed Edge Function | `open-brain/supabase/functions/<name>-mcp/index.ts` (copy of OB1 source) |

## Operational gotchas

- **Supabase SQL editor runs statements sequentially without halting on
  error.** Wrap related work in `DO $$ BEGIN ... END $$;` for atomicity.
- **MCP tool registry caches at session start.** Restart Claude Desktop
  after redeploying to pick up new tool definitions.
- **Edge Function memory cap (256MB free, 512MB Pro).** The
  `entity-extraction-worker` can OOM on large batches; use `?limit=3` if
  defaults fail.
- **`_shared/` folders.** If an Edge Function imports from `_shared/`, that
  folder must be copied alongside `index.ts` when deploying.
- **Cross-extension FK dependencies.** `contacts` is defined by
  family-calendar but referenced by household-knowledge and professional-crm.
  Always deploy family-calendar's schema first.
