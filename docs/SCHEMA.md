# Schema Reference

All tables in Hannah's Supabase project, organized by extension, with the
relationships between them.

## ERD — full schema relationships

```mermaid
erDiagram
    thoughts ||--o{ entity_extraction_queue : "queued for processing"
    thoughts ||--o{ thought_entities : "mentions"
    entities ||--o{ thought_entities : "mentioned in"
    entities ||--o{ edges : "from"
    entities ||--o{ edges : "to"
    entities }o--|| contacts : "person entity links to contact"
    entities }o--|| locations : "place entity links to location"
    entities }o--|| organizations : "org entity links to organization"

    organizations ||--o{ contacts : "where they work"
    locations ||--o{ organizations : "headquarters"

    contacts ||--o| household_details : "1:1 for household members"
    contacts ||--o{ caregiver_daily_hours : "au pair schedule"
    contacts ||--o{ events : "human participant"
    contacts ||--o{ pet_walks : "default walker"
    contacts ||--o{ dinner_defaults : "cook"
    contacts ||--o{ important_dates : "person"
    contacts ||--o{ contact_interactions : "touchpoint log"
    contacts ||--o{ opportunities : "CRM pipeline"

    pets ||--o{ pet_walks : "walk slots"
    pets ||--o{ events : "pet participant"

    locations ||--o{ household_details : "office_location"
    locations ||--o{ events : "where"

    thoughts {
        uuid id PK
        text content
        vector embedding
        jsonb metadata
        text content_fingerprint "added by enhanced-thoughts"
        text type
        smallint importance
        timestamptz created_at
    }

    entities {
        bigint id PK
        text entity_type "person|project|topic|tool|organization|place"
        text canonical_name
        text normalized_name
        jsonb aliases
        uuid contact_id FK "bridge to contacts"
        uuid location_id FK "bridge to locations"
        uuid organization_id FK "bridge to organizations"
    }

    edges {
        bigint id PK
        bigint from_entity_id FK
        bigint to_entity_id FK
        text relation "co_occurs_with|works_on|uses|related_to|member_of|located_in"
        int support_count
    }

    thought_entities {
        uuid thought_id FK
        bigint entity_id FK
        text mention_role
        numeric confidence
    }

    entity_extraction_queue {
        uuid thought_id PK
        text status "pending|processing|complete|failed|skipped"
        int attempt_count
        text last_error
    }

    contacts {
        uuid id PK
        uuid user_id
        text name
        text relationship
        date birth_date
        text email
        text phone
        text company "TEXT — retained for FTS until Phase D cleanup"
        uuid organization_id FK "added by organizations schema"
        text title
        text service_type "for vendors"
        smallint rating
        text_array tags "household_member|vendor|professional|friend"
        text how_we_met
        timestamptz last_contacted
        tsvector fts "FTS column added by professional-crm"
    }

    organizations {
        uuid id PK
        uuid user_id
        text name
        text industry
        text website
        text size "startup|mid-market|enterprise"
        uuid headquarters_location_id FK
        text remote_policy "remote|hybrid|onsite"
        numeric glassdoor_rating
        text_array tags "employer-target|past-employer|vendor|client|school"
        text notes
        tsvector fts
    }

    household_details {
        uuid contact_id PK_FK
        uuid user_id
        text role "primary_scheduler|partner|au_pair|child"
        text_array work_days
        time work_start
        time work_end
        int commute_minutes
        uuid office_location_id FK
        time leaves_home
        time returns_home
        numeric weekly_hours_target
        time nap_start
        time bedtime
        text preferences "free-form rules for Claude prompt"
    }

    pets {
        uuid id PK
        uuid user_id
        text name
        text species
        text breed
        date birth_date
        int walks_per_day
    }

    locations {
        uuid id PK
        uuid user_id
        text name
        text address
        int travel_minutes_from_home
    }

    events {
        uuid id PK
        uuid user_id
        uuid contact_id FK "human participant"
        uuid pet_id FK "pet participant"
        uuid location_id FK
        text title
        text activity_type "swim|forest_school|pool_league|cleaner|coop_shift|dog_walker_visit"
        text cadence_type "once|weekly|biweekly|every_n_weeks"
        int cadence_weeks
        text day_of_week
        date reference_date "anchor for biweekly+"
        time start_time
        time end_time
    }

    pet_walks {
        uuid id PK
        uuid pet_id FK
        text slot "morning|midday|evening|night"
        time scheduled_time
        uuid default_walker_contact_id FK
    }

    caregiver_daily_hours {
        uuid id PK
        uuid contact_id FK
        text day_of_week
        time start_time
        time end_time
        bool is_balance "true for Friday balance row"
    }

    dinner_defaults {
        uuid id PK
        text day_of_week
        uuid cook_id FK
        text dish_notes
    }

    important_dates {
        uuid id PK
        uuid person_id FK
        text title
        date date_value
        bool recurring_yearly
    }

    contact_interactions {
        uuid id PK
        uuid contact_id FK
        text interaction_type "meeting|email|call|coffee|event|linkedin|other"
        timestamptz occurred_at
        text summary
        tsvector fts
    }

    opportunities {
        uuid id PK
        uuid contact_id FK
        text title
        text stage "identified|in_conversation|proposal|negotiation|won|lost"
        decimal value
        date expected_close_date
    }
```

## By extension

### Core (OB1 Getting Started + schemas/enhanced-thoughts + schemas/entity-extraction)

- **`thoughts`** — Raw captured thoughts. Embedding vector for similarity search, JSONB metadata. Extended by `enhanced-thoughts` schema with `content_fingerprint`, `type`, `importance`, `quality_score`, etc.
- **`entities`** — Knowledge graph nodes. Extracted from thoughts by the worker. Bridge FKs `contact_id` and `location_id` link to the canonical canonical tables when names match.
- **`edges`** — Typed relationships between entities. Built up as the worker sees co-occurrences.
- **`thought_entities`** — Many-to-many link from thoughts to entities, with mention role + confidence.
- **`entity_extraction_queue`** — Async queue. Auto-trigger queues new/updated thoughts; the `entity-extraction-worker` Edge Function drains it.

### family-calendar extension

The "canonical" tables — defined in this extension's `schema.sql`:

- **`contacts`** — Unified table for all humans (household, vendors, friends, professional). `tags[]` classifies. `service_type` is set for vendors. FTS column + GIN index added by professional-crm.
- **`pets`** — Separate from contacts. Just animals.
- **`household_details`** — 1:1 child of contacts, present only for household members. Holds all the schedule/work/routine attributes (work_days, nap_start, preferences, etc.).
- **`locations`** — Named places. Referenced by household_details.office_location_id and events.location_id.
- **`events`** — Recurring and one-off events. Cadence inlined as columns (`cadence_type`, `cadence_weeks`, `reference_date`). FK to contacts (human participant) AND/OR pets (pet participant) AND location.
- **`pet_walks`** — One row per slot per pet. Default walker is a contact (can be household member OR vendor).
- **`caregiver_daily_hours`** — One row per weekday per caregiver. `is_balance=true` for "balance of remaining weekly hours" (Friday for au pair).
- **`dinner_defaults`** — Per-day default cook + dish notes.
- **`important_dates`** — Birthdays, anniversaries, deadlines.

### household-knowledge extension

- **`household_items`** — Paint colors, appliance specs, etc. (Unrelated to the contacts work.)
- **No `household_vendors` table** — vendors moved to `contacts` with `tags=['vendor']`. The `add_vendor` and `list_vendors` MCP tools read/write `contacts` filtered by tag.

### professional-crm extension

- **`contact_interactions`** — Log of touchpoints with contacts. Auto-updates `contacts.last_contacted` via trigger. Has its own FTS column.
- **`opportunities`** — CRM pipeline stages.
- **`contacts.fts`** column + **`crm_search_contacts_fts`** RPC — added to the `contacts` table by this extension. RPC filters to `tags @> ['professional']`.
- **No `professional_contacts` table** — folded into `contacts` with `tags=['professional']`.

### organizations schema (pending — not yet applied)

- **`organizations`** — Canonical dimension for institutions (companies, schools, agencies). `tags[]` classifies (`employer-target`, `past-employer`, `vendor`, `client`, `school`). FTS column + GIN index for search. Soft-unique on `(user_id, LOWER(name))`.
- **`contacts.organization_id`** — Added by this schema. Nullable FK letting "all contacts at Anthropic" become a real join instead of `ILIKE` on `contacts.company`. The TEXT `contacts.company` column is retained for now because the professional-crm FTS depends on it.
- **`entities.organization_id`** — Added by this schema. Knowledge-graph bridge analogous to `entities.contact_id` and `entities.location_id`. Populated by the entity-extraction worker when an `entity_type='organization'` matches an `organizations.name`.
- **Why it exists:** unblocks the job-hunt extension to drop its `companies` table and FK to `organizations` instead, and gives the KG a real join path for org-typed entities.

## Key FK relationships

```
thoughts.id ──┬─→ entity_extraction_queue.thought_id
              └─→ thought_entities.thought_id
                       │
                       └─→ entities.id ──┬─→ edges.from_entity_id / to_entity_id
                                          ├─→ contacts.id      (entities.contact_id)
                                          ├─→ locations.id     (entities.location_id)
                                          └─→ organizations.id (entities.organization_id)  [pending]

contacts.id ──┬─→ household_details.contact_id (1:1, PK)
              ├─→ caregiver_daily_hours.contact_id
              ├─→ events.contact_id
              ├─→ pet_walks.default_walker_contact_id
              ├─→ dinner_defaults.cook_id
              ├─→ important_dates.person_id
              ├─→ contact_interactions.contact_id
              └─→ opportunities.contact_id

organizations.id ─→ contacts.organization_id    [pending]
                 ─→ entities.organization_id    [pending]

pets.id ──────┬─→ pet_walks.pet_id
              └─→ events.pet_id

locations.id ─┬─→ household_details.office_location_id
              ├─→ events.location_id
              └─→ organizations.headquarters_location_id  [pending]
```

## Migration history

There is no committed migration history for this deployment. The
authoritative source for "what should the schema look like" is each
extension's `schema.sql` in `/Users/hannah/repos/OB1/extensions/<name>/`.

Past changes are visible in OB1's git log if needed (the unified-contacts
refactor was applied via a one-shot recovery SQL — see conversation history,
not committed).
