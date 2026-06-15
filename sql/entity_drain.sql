-- Nightly drain of the entity_extraction_queue via the entity-extraction-worker.
--
-- Apply this once via the Supabase SQL editor. It does three things:
--   1. Enables pg_cron + pg_net (no-ops if already enabled).
--   2. Defines public.drain_entity_queue(worker_url, brain_key, ...) — loops
--      N calls of ?limit=K to the entity-extraction-worker, sleeping S seconds
--      between calls.
--   3. Schedules drain_entity_queue() nightly at 04:00 UTC, passing the URL
--      and brain key inline so the function stays parameterized.
--
-- Two callers, one function:
--   * pg_cron nightly job   → SELECT public.drain_entity_queue(<url>, <key>);
--   * Weekly-schedule UI    → HTTP POST /process-entities → Python helper
--                             loops the worker directly (does NOT call this
--                             SQL function). Same behavior, different host.
--
-- TIMEZONE: pg_cron runs in UTC. 04:00 UTC = midnight EDT (summer) /
-- 23:00 EST (previous night, winter). For "midnight ET" all year you'd need
-- two jobs or live with the drift. If it matters in November, re-run the
-- cron.schedule block below with '0 5 * * *' instead of '0 4 * * *'.
--
-- BEFORE APPLYING: replace <PROJECT_REF> with your Supabase project ref and
-- <BRAIN_KEY> with the MCP_ACCESS_KEY value from your Edge Function secrets.
-- The brain key will end up in the cron.job.command column (privileged read
-- only). To rotate it later, just re-run the cron.schedule block — it will
-- overwrite the same jobname.

-- ── 1. Extensions ──────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ── 2. Drain function ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.drain_entity_queue(
  worker_url     text,
  brain_key      text,
  max_iterations int DEFAULT 10,
  per_call_limit int DEFAULT 3,
  sleep_seconds  int DEFAULT 60
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, net
AS $$
DECLARE
  i       int;
  started timestamptz := now();
BEGIN
  IF worker_url IS NULL OR worker_url = '' THEN
    RAISE EXCEPTION 'worker_url is required';
  END IF;
  IF brain_key IS NULL OR brain_key = '' THEN
    RAISE EXCEPTION 'brain_key is required';
  END IF;

  -- Fire-and-forget pg_net calls. The worker writes results to the queue
  -- directly; we don't need to inspect the HTTP response. We sleep between
  -- calls so a fast empty-queue response doesn't burn the worker's per-call
  -- start-up cost in a tight loop.
  --
  -- Memory note: CLAUDE.md recommends limit=3 to avoid Edge Function OOM
  -- (default tier 256MB, Pro 512MB). 10 iterations × 3 = up to 30 thoughts
  -- per nightly run — comfortable for typical daily capture volume.
  FOR i IN 1..max_iterations LOOP
    PERFORM net.http_post(
      url     := worker_url || '?limit=' || per_call_limit,
      headers := jsonb_build_object(
                   'x-brain-key',  brain_key,
                   'Content-Type', 'application/json'
                 ),
      body    := '{}'::jsonb
    );
    IF i < max_iterations THEN
      PERFORM pg_sleep(sleep_seconds);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'iterations',     max_iterations,
    'per_call_limit', per_call_limit,
    'started_at',     started,
    'finished_at',    now()
  );
END;
$$;

-- ── 3. Nightly schedule ────────────────────────────────────────────────────
-- If a same-name job exists, unschedule first so this is idempotent.
SELECT cron.unschedule('drain-entity-queue-nightly')
  WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'drain-entity-queue-nightly');

-- Schedule. The URL + key are baked into the cron command (single-quoted as
-- SQL literals). %L safely escapes either value if it contains quotes.
SELECT cron.schedule(
  'drain-entity-queue-nightly',
  '0 4 * * *',
  format(
    $cmd$SELECT public.drain_entity_queue(%L, %L);$cmd$,
    'https://<PROJECT_REF>.supabase.co/functions/v1/entity-extraction-worker',
    '<BRAIN_KEY>'
  )
);

-- ── Verify ────────────────────────────────────────────────────────────────
-- After applying, confirm:
--   SELECT jobname, schedule, command FROM cron.job WHERE jobname LIKE 'drain%';
--   SELECT public.drain_entity_queue(
--     'https://<PROJECT_REF>.supabase.co/functions/v1/entity-extraction-worker',
--     '<BRAIN_KEY>',
--     1, 3, 0
--   );  -- manual one-shot test (one call, no sleep)
