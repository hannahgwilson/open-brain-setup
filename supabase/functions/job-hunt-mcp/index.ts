/**
 * Extension 6: Job Hunt Pipeline MCP Server
 *
 * Layers job-hunt facts (postings, applications, interviews) on top of the
 * canonical dims:
 *   * organizations  — target employers (via organizations-mcp)
 *   * contacts       — recruiters / hiring managers / interviewers (via CRM)
 *   * events         — optional calendar surfacing for scheduled interviews
 *
 * What changed from v1.0:
 *   - No `add_company`. Use organizations-mcp `org_find_or_create`.
 *   - No `add_job_contact`. Use professional-crm `crm_add_contact` with
 *     tags=['professional','job-hunt'] and the org's id as organization_id.
 *   - No `link_contact_to_professional_crm`. They're already in CRM.
 *   - `add_job_posting` takes `organization_id` (UUID), not company text.
 *   - `submit_application` takes `referral_contact_id` (UUID), not text.
 *   - `schedule_interview` takes `interviewer_contact_id` (UUID), and can
 *     optionally write through to the `events` table for calendar surfacing.
 *   - New `update_application_status` — explicit transition with notes; the
 *     application_status_history table is auto-populated by a DB trigger.
 *   - New `get_funnel_metrics` — true conversion rates from the history.
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

const app = new Hono();

const applicationStatusEnum = z.enum([
  "draft", "applied", "screening", "interviewing", "offer", "accepted", "rejected", "withdrawn",
]);
const interviewTypeEnum = z.enum([
  "phone_screen", "technical", "behavioral", "system_design", "hiring_manager", "team", "final",
]);
const remotePolicyEnum = z.enum(["remote", "hybrid", "onsite"]);
const sourceEnum = z.enum(["linkedin", "company-site", "referral", "recruiter", "other"]);

// ──────────────────────────────────────────────────────────────────────────────
// Handlers — pulled out for the multi-step writes (schedule_interview,
// get_pipeline_overview, get_funnel_metrics) where inline gets ugly.
// ──────────────────────────────────────────────────────────────────────────────

interface ScheduleInterviewArgs {
  application_id: string;
  interview_type: z.infer<typeof interviewTypeEnum>;
  scheduled_at?: string;
  duration_minutes?: number;
  interviewer_contact_id?: string;
  notes?: string;
  add_to_calendar?: boolean;
}

async function handleScheduleInterview(
  supabase: SupabaseClient,
  userId: string,
  args: ScheduleInterviewArgs,
): Promise<Record<string, unknown>> {
  let eventId: string | null = null;

  // Optional calendar bridge: create a one-off event so the interview shows
  // up in the family-calendar week view.
  if (args.add_to_calendar && args.scheduled_at) {
    // Derive a title for the event by joining out to the application + posting + org.
    const { data: applicationCtx } = await supabase
      .from("applications")
      .select(`
        id,
        job_postings!inner (
          title,
          organizations!inner ( name )
        )
      `)
      .eq("id", args.application_id)
      .eq("user_id", userId)
      .maybeSingle();

    const postingTitle =
      (applicationCtx?.job_postings as { title?: string } | undefined)?.title ?? "Interview";
    const orgName =
      (
        (applicationCtx?.job_postings as { organizations?: { name?: string } } | undefined)
          ?.organizations as { name?: string } | undefined
      )?.name ?? "";

    const dt = new Date(args.scheduled_at);
    if (Number.isNaN(dt.getTime())) {
      throw new Error("schedule_interview: scheduled_at is not a valid ISO timestamp");
    }
    const startDate = dt.toISOString().slice(0, 10); // YYYY-MM-DD
    const startTime = dt.toISOString().slice(11, 19); // HH:MM:SS
    let endTime: string | null = null;
    if (args.duration_minutes && args.duration_minutes > 0) {
      const endDt = new Date(dt.getTime() + args.duration_minutes * 60_000);
      endTime = endDt.toISOString().slice(11, 19);
    }

    const eventTitle = orgName
      ? `Interview: ${postingTitle} @ ${orgName}`
      : `Interview: ${postingTitle}`;

    const { data: eventRow, error: eventErr } = await supabase
      .from("events")
      .insert({
        user_id: userId,
        contact_id: args.interviewer_contact_id ?? null,
        title: eventTitle,
        activity_type: "interview",
        cadence_type: "once",
        start_date: startDate,
        start_time: startTime,
        end_time: endTime,
        notes: args.notes ?? null,
      })
      .select("id")
      .single();

    if (eventErr) {
      throw new Error(`schedule_interview: failed to create calendar event: ${eventErr.message}`);
    }
    eventId = eventRow?.id ?? null;
  }

  const { data, error } = await supabase
    .from("interviews")
    .insert({
      user_id: userId,
      application_id: args.application_id,
      interviewer_contact_id: args.interviewer_contact_id ?? null,
      event_id: eventId,
      interview_type: args.interview_type,
      scheduled_at: args.scheduled_at ?? null,
      duration_minutes: args.duration_minutes ?? null,
      status: "scheduled",
      notes: args.notes ?? null,
    })
    .select()
    .single();

  if (error) throw new Error(`schedule_interview failed: ${error.message}`);
  return { success: true, interview: data, calendar_event_id: eventId };
}

async function handleGetPipelineOverview(
  supabase: SupabaseClient,
  userId: string,
  daysAhead: number,
): Promise<Record<string, unknown>> {
  const { data: applications, error: appError } = await supabase
    .from("applications")
    .select("status")
    .eq("user_id", userId);
  if (appError) throw new Error(`pipeline_overview: ${appError.message}`);

  const statusCounts: Record<string, number> = {};
  for (const a of applications ?? []) {
    statusCounts[a.status] = (statusCounts[a.status] ?? 0) + 1;
  }

  const futureDate = new Date();
  futureDate.setDate(futureDate.getDate() + daysAhead);

  const { data: upcoming, error: intError } = await supabase
    .from("interviews")
    .select(`
      *,
      applications!inner (
        id,
        job_postings!inner (
          id, title,
          organizations!inner ( id, name )
        )
      )
    `)
    .eq("user_id", userId)
    .eq("status", "scheduled")
    .gte("scheduled_at", new Date().toISOString())
    .lte("scheduled_at", futureDate.toISOString())
    .order("scheduled_at", { ascending: true });
  if (intError) throw new Error(`pipeline_overview: ${intError.message}`);

  return {
    success: true,
    total_applications: applications?.length ?? 0,
    status_breakdown: statusCounts,
    upcoming_interviews_count: upcoming?.length ?? 0,
    upcoming_interviews: upcoming ?? [],
  };
}

async function handleGetFunnelMetrics(
  supabase: SupabaseClient,
  userId: string,
  windowDays: number | null,
): Promise<Record<string, unknown>> {
  // Pull all status-history rows within the window. Compute:
  //   - count of applications that ever entered each status
  //   - conversion rate between adjacent stages
  //   - median days from `applied` to each later stage
  let qb = supabase
    .from("application_status_history")
    .select("application_id, from_status, to_status, changed_at")
    .eq("user_id", userId);

  if (windowDays && windowDays > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    qb = qb.gte("changed_at", cutoff.toISOString());
  }

  const { data: rows, error } = await qb;
  if (error) throw new Error(`get_funnel_metrics: ${error.message}`);

  // Map of application_id -> { status: firstReachedAt }
  const reachedAt = new Map<string, Map<string, string>>();
  for (const r of rows ?? []) {
    const m = reachedAt.get(r.application_id) ?? new Map<string, string>();
    if (!m.has(r.to_status)) m.set(r.to_status, r.changed_at);
    reachedAt.set(r.application_id, m);
  }

  const stageOrder = ["applied", "screening", "interviewing", "offer", "accepted"];
  const stageCounts: Record<string, number> = {};
  for (const stage of stageOrder) stageCounts[stage] = 0;
  for (const m of reachedAt.values()) {
    for (const stage of stageOrder) if (m.has(stage)) stageCounts[stage]++;
  }

  const conversion: Record<string, number | null> = {};
  for (let i = 1; i < stageOrder.length; i++) {
    const prev = stageOrder[i - 1];
    const cur = stageOrder[i];
    conversion[`${prev}_to_${cur}`] = stageCounts[prev] > 0
      ? Number((stageCounts[cur] / stageCounts[prev]).toFixed(3))
      : null;
  }

  // Median days from applied -> each downstream stage
  const days: Record<string, number[]> = {};
  for (let i = 1; i < stageOrder.length; i++) days[stageOrder[i]] = [];
  for (const m of reachedAt.values()) {
    const appliedAt = m.get("applied");
    if (!appliedAt) continue;
    const t0 = new Date(appliedAt).getTime();
    for (let i = 1; i < stageOrder.length; i++) {
      const at = m.get(stageOrder[i]);
      if (at) {
        days[stageOrder[i]].push((new Date(at).getTime() - t0) / 86_400_000);
      }
    }
  }
  const median = (xs: number[]) => {
    if (xs.length === 0) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return Number((s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]).toFixed(1));
  };
  const medianDaysFromApplied: Record<string, number | null> = {};
  for (const k of Object.keys(days)) medianDaysFromApplied[k] = median(days[k]);

  return {
    success: true,
    window_days: windowDays,
    stage_counts: stageCounts,
    conversion_rates: conversion,
    median_days_from_applied: medianDaysFromApplied,
    sample_size: reachedAt.size,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// MCP endpoint
// ──────────────────────────────────────────────────────────────────────────────

app.post("*", async (c) => {
  if (!c.req.header("accept")?.includes("text/event-stream")) {
    const headers = new Headers(c.req.raw.headers);
    headers.set("Accept", "application/json, text/event-stream");
    const patched = new Request(c.req.raw.url, {
      method: c.req.raw.method,
      headers,
      body: c.req.raw.body,
      // @ts-ignore -- duplex required for streaming body in Deno
      duplex: "half",
    });
    Object.defineProperty(c.req, "raw", { value: patched, writable: true });
  }

  const key = c.req.query("key") || c.req.header("x-access-key");
  const expected = Deno.env.get("MCP_ACCESS_KEY");
  if (!key || key !== expected) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

  const userId = Deno.env.get("DEFAULT_USER_ID");
  if (!userId) return c.json({ error: "DEFAULT_USER_ID not configured" }, 500);

  const server = new McpServer({ name: "job-hunt", version: "2.0.0" });

  const ok = (payload: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  });

  // ───────────────────────────────────────────────────────────────────────
  // add_job_posting
  // ───────────────────────────────────────────────────────────────────────
  server.tool(
    "add_job_posting",
    "Add a job posting for a role at an organization. Pass the organization_id (UUID) obtained from organizations-mcp `org_find_or_create` or `org_search`.",
    {
      organization_id: z.string().describe("UUID of the row in `organizations`"),
      title: z.string().describe("Job title"),
      url: z.string().optional(),
      salary_min: z.number().optional(),
      salary_max: z.number().optional(),
      salary_currency: z.string().optional().describe("Default USD"),
      requirements: z.array(z.string()).optional(),
      nice_to_haves: z.array(z.string()).optional(),
      location: z.string().optional().describe("Posting-specific location (may differ from org HQ)"),
      remote_policy: remotePolicyEnum.optional(),
      source: sourceEnum.optional(),
      posted_date: z.string().optional().describe("YYYY-MM-DD"),
      closing_date: z.string().optional().describe("YYYY-MM-DD"),
      notes: z.string().optional(),
    },
    async (args) => {
      const { data, error } = await supabase
        .from("job_postings")
        .insert({
          user_id: userId,
          organization_id: args.organization_id,
          title: args.title,
          url: args.url ?? null,
          salary_min: args.salary_min ?? null,
          salary_max: args.salary_max ?? null,
          salary_currency: args.salary_currency ?? "USD",
          requirements: args.requirements ?? [],
          nice_to_haves: args.nice_to_haves ?? [],
          location: args.location ?? null,
          remote_policy: args.remote_policy ?? null,
          source: args.source ?? null,
          posted_date: args.posted_date ?? null,
          closing_date: args.closing_date ?? null,
          notes: args.notes ?? null,
        })
        .select()
        .single();
      if (error) throw new Error(`add_job_posting failed: ${error.message}`);
      return ok({ success: true, job_posting: data });
    },
  );

  // ───────────────────────────────────────────────────────────────────────
  // submit_application
  // ───────────────────────────────────────────────────────────────────────
  server.tool(
    "submit_application",
    "Record a submitted application. If someone referred you, pass `referral_contact_id` (UUID from contacts). Status defaults to 'applied' and is auto-logged to application_status_history.",
    {
      job_posting_id: z.string(),
      referral_contact_id: z.string().optional().describe("UUID of the contact who referred you"),
      status: applicationStatusEnum.optional().describe("Default 'applied'"),
      applied_date: z.string().optional().describe("YYYY-MM-DD"),
      resume_version: z.string().optional(),
      cover_letter_notes: z.string().optional(),
      notes: z.string().optional(),
    },
    async (args) => {
      const { data, error } = await supabase
        .from("applications")
        .insert({
          user_id: userId,
          job_posting_id: args.job_posting_id,
          referral_contact_id: args.referral_contact_id ?? null,
          status: args.status ?? "applied",
          applied_date: args.applied_date ?? null,
          resume_version: args.resume_version ?? null,
          cover_letter_notes: args.cover_letter_notes ?? null,
          notes: args.notes ?? null,
        })
        .select()
        .single();
      if (error) throw new Error(`submit_application failed: ${error.message}`);
      return ok({ success: true, application: data });
    },
  );

  // ───────────────────────────────────────────────────────────────────────
  // update_application_status
  // ───────────────────────────────────────────────────────────────────────
  server.tool(
    "update_application_status",
    "Move an application to a new status. The transition is auto-recorded in application_status_history by a DB trigger — pass `notes` only to annotate the application row itself.",
    {
      application_id: z.string(),
      status: applicationStatusEnum,
      response_date: z.string().optional().describe("YYYY-MM-DD — set when receiving company response"),
      notes: z.string().optional(),
    },
    async (args) => {
      const patch: Record<string, unknown> = { status: args.status };
      if (args.response_date) patch.response_date = args.response_date;
      if (args.notes) patch.notes = args.notes;

      const { data, error } = await supabase
        .from("applications")
        .update(patch)
        .eq("id", args.application_id)
        .eq("user_id", userId)
        .select()
        .single();
      if (error) throw new Error(`update_application_status failed: ${error.message}`);
      return ok({ success: true, application: data });
    },
  );

  // ───────────────────────────────────────────────────────────────────────
  // schedule_interview
  // ───────────────────────────────────────────────────────────────────────
  server.tool(
    "schedule_interview",
    "Schedule an interview for an application. Pass `add_to_calendar: true` to also create a row in `events` so the interview shows in the family-calendar week view.",
    {
      application_id: z.string(),
      interview_type: interviewTypeEnum,
      scheduled_at: z.string().optional().describe("ISO 8601 timestamp"),
      duration_minutes: z.number().optional(),
      interviewer_contact_id: z.string().optional().describe("UUID of the interviewer in contacts"),
      notes: z.string().optional().describe("Pre-interview prep notes"),
      add_to_calendar: z.boolean().optional().describe("Default false. When true, also writes to `events`."),
    },
    async (args) => {
      const result = await handleScheduleInterview(supabase, userId, args);
      return ok(result);
    },
  );

  // ───────────────────────────────────────────────────────────────────────
  // log_interview_notes
  // ───────────────────────────────────────────────────────────────────────
  server.tool(
    "log_interview_notes",
    "Add feedback and a rating after an interview; marks status as completed.",
    {
      interview_id: z.string(),
      feedback: z.string().optional(),
      rating: z.number().min(1).max(5).optional(),
    },
    async (args) => {
      const { data, error } = await supabase
        .from("interviews")
        .update({
          feedback: args.feedback ?? null,
          rating: args.rating ?? null,
          status: "completed",
        })
        .eq("id", args.interview_id)
        .eq("user_id", userId)
        .select()
        .single();
      if (error) throw new Error(`log_interview_notes failed: ${error.message}`);
      return ok({ success: true, interview: data });
    },
  );

  // ───────────────────────────────────────────────────────────────────────
  // list_postings
  // ───────────────────────────────────────────────────────────────────────
  server.tool(
    "list_postings",
    "List tracked job postings, optionally filtered by organization. Returns posting + organization name for context.",
    {
      organization_id: z.string().optional(),
      limit: z.number().optional().describe("Default 50"),
    },
    async ({ organization_id, limit }) => {
      let qb = supabase
        .from("job_postings")
        .select(`*, organizations!inner ( id, name )`)
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit ?? 50);
      if (organization_id) qb = qb.eq("organization_id", organization_id);
      const { data, error } = await qb;
      if (error) throw new Error(`list_postings failed: ${error.message}`);
      return ok({ success: true, count: data.length, postings: data });
    },
  );

  // ───────────────────────────────────────────────────────────────────────
  // list_applications
  // ───────────────────────────────────────────────────────────────────────
  server.tool(
    "list_applications",
    "List applications, optionally filtered by status or organization. Returns application + posting + org for context.",
    {
      status: applicationStatusEnum.optional(),
      organization_id: z.string().optional(),
      limit: z.number().optional().describe("Default 50"),
    },
    async ({ status, organization_id, limit }) => {
      let qb = supabase
        .from("applications")
        .select(`
          *,
          job_postings!inner (
            id, title, organization_id,
            organizations!inner ( id, name )
          )
        `)
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(limit ?? 50);
      if (status) qb = qb.eq("status", status);
      if (organization_id) qb = qb.eq("job_postings.organization_id", organization_id);
      const { data, error } = await qb;
      if (error) throw new Error(`list_applications failed: ${error.message}`);
      return ok({ success: true, count: data.length, applications: data });
    },
  );

  // ───────────────────────────────────────────────────────────────────────
  // get_pipeline_overview
  // ───────────────────────────────────────────────────────────────────────
  server.tool(
    "get_pipeline_overview",
    "Dashboard summary: application counts by status, plus upcoming interviews in the next N days (default 7).",
    {
      days_ahead: z.number().optional(),
    },
    async ({ days_ahead }) => {
      const result = await handleGetPipelineOverview(supabase, userId, days_ahead ?? 7);
      return ok(result);
    },
  );

  // ───────────────────────────────────────────────────────────────────────
  // get_upcoming_interviews
  // ───────────────────────────────────────────────────────────────────────
  server.tool(
    "get_upcoming_interviews",
    "List scheduled interviews in the next N days (default 14) with org / role context.",
    {
      days_ahead: z.number().optional(),
    },
    async ({ days_ahead }) => {
      const future = new Date();
      future.setDate(future.getDate() + (days_ahead ?? 14));

      const { data, error } = await supabase
        .from("interviews")
        .select(`
          *,
          applications!inner (
            id,
            job_postings!inner (
              id, title,
              organizations!inner ( id, name )
            )
          )
        `)
        .eq("user_id", userId)
        .eq("status", "scheduled")
        .gte("scheduled_at", new Date().toISOString())
        .lte("scheduled_at", future.toISOString())
        .order("scheduled_at", { ascending: true });

      if (error) throw new Error(`get_upcoming_interviews failed: ${error.message}`);
      return ok({ success: true, count: data.length, interviews: data });
    },
  );

  // ───────────────────────────────────────────────────────────────────────
  // get_funnel_metrics
  // ───────────────────────────────────────────────────────────────────────
  server.tool(
    "get_funnel_metrics",
    "Compute true funnel conversion rates (applied → screening → interviewing → offer → accepted) and median days-from-applied to each stage. Uses application_status_history.",
    {
      window_days: z.number().optional().describe("If set, restrict to status changes within the last N days"),
    },
    async ({ window_days }) => {
      const result = await handleGetFunnelMetrics(supabase, userId, window_days ?? null);
      return ok(result);
    },
  );

  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c);
});

app.get("*", (c) => c.json({ status: "ok", service: "Job Hunt Pipeline", version: "2.0.0" }));

Deno.serve(app.fetch);
