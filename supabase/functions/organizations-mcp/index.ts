/**
 * organizations-mcp — Cross-cutting MCP for the `organizations` canonical dim.
 *
 * `organizations` is referenced by multiple extensions (job-hunt, professional-crm,
 * household-knowledge vendors) so its CRUD lives in its own MCP rather than
 * being owned by any single extension. Parallel role to how `contacts` is
 * shared across family-calendar, household-knowledge, and professional-crm.
 *
 * Schema dependency: `schemas/organizations/schema.sql` (organizations table +
 *   contacts.organization_id FK + entities.organization_id FK).
 *
 * Tools:
 *   org_add               — Insert a new organization
 *   org_find_or_create    — Idempotent: returns existing org by name or creates
 *   org_list              — List orgs with optional tag filter
 *   org_search            — FTS search across name, industry, notes
 *   org_get               — Get a single org with its contacts
 *   org_update            — Update fields on an existing org
 *   org_tag               — Add or remove tags
 *   org_merge             — Merge two orgs (moves contacts + entities FK refs)
 *   org_link_contact      — Set contacts.organization_id
 *   org_get_contacts      — List contacts at an org
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const app = new Hono();

const sizeEnum = z.enum(["startup", "mid-market", "enterprise"]);
const remotePolicyEnum = z.enum(["remote", "hybrid", "onsite"]);

app.post("*", async (c) => {
  // Patch Accept header for Claude Desktop connectors (no text/event-stream by default).
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
  if (!userId) {
    return c.json({ error: "DEFAULT_USER_ID not configured" }, 500);
  }

  const server = new McpServer({ name: "organizations", version: "1.0.0" });

  const ok = (payload: Record<string, unknown>) => ({
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  });

  // ──────────────────────────────────────────────────────────────────────────
  // org_add
  // ──────────────────────────────────────────────────────────────────────────
  server.tool(
    "org_add",
    "Add a new organization (company, school, agency, etc.) to the canonical dimension. Use org_find_or_create instead if you're not sure whether the org already exists.",
    {
      name: z.string().describe("Organization name"),
      industry: z.string().optional(),
      website: z.string().optional(),
      size: sizeEnum.optional().describe("startup | mid-market | enterprise"),
      headquarters_location_id: z.string().optional().describe("UUID of a row in `locations`"),
      remote_policy: remotePolicyEnum.optional(),
      glassdoor_rating: z.number().min(1.0).max(5.0).optional(),
      tags: z.array(z.string()).optional().describe(
        "Conventional tags: 'employer-target', 'past-employer', 'vendor', 'client', 'school', 'agency'",
      ),
      notes: z.string().optional(),
    },
    async (args) => {
      const { data, error } = await supabase
        .from("organizations")
        .insert({
          user_id: userId,
          name: args.name,
          industry: args.industry ?? null,
          website: args.website ?? null,
          size: args.size ?? null,
          headquarters_location_id: args.headquarters_location_id ?? null,
          remote_policy: args.remote_policy ?? null,
          glassdoor_rating: args.glassdoor_rating ?? null,
          tags: args.tags ?? [],
          notes: args.notes ?? null,
        })
        .select()
        .single();

      if (error) throw new Error(`org_add failed: ${error.message}`);
      return ok({ success: true, organization: data });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // org_find_or_create
  // Idempotent helper for callers that don't want to pre-check existence.
  // ──────────────────────────────────────────────────────────────────────────
  server.tool(
    "org_find_or_create",
    "Look up an organization by name (case-insensitive); create it if missing. Use this from other MCPs that want a stable org_id without two round-trips.",
    {
      name: z.string().describe("Organization name to find or create"),
      tags: z.array(z.string()).optional().describe("Tags to set if creating (no effect if found)"),
    },
    async ({ name, tags }) => {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("org_find_or_create: name is empty");

      const { data: existing, error: lookupErr } = await supabase
        .from("organizations")
        .select("*")
        .eq("user_id", userId)
        .ilike("name", trimmed)
        .limit(1)
        .maybeSingle();

      if (lookupErr) throw new Error(`lookup failed: ${lookupErr.message}`);
      if (existing) return ok({ success: true, organization: existing, created: false });

      const { data: created, error: insertErr } = await supabase
        .from("organizations")
        .insert({
          user_id: userId,
          name: trimmed,
          tags: tags ?? [],
        })
        .select()
        .single();

      if (insertErr) throw new Error(`create failed: ${insertErr.message}`);
      return ok({ success: true, organization: created, created: true });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // org_list
  // ──────────────────────────────────────────────────────────────────────────
  server.tool(
    "org_list",
    "List organizations, optionally filtered by a tag (e.g. 'employer-target', 'vendor').",
    {
      tag: z.string().optional().describe("Filter to orgs containing this tag"),
      limit: z.number().optional().describe("Max results (default 50)"),
    },
    async ({ tag, limit }) => {
      let qb = supabase
        .from("organizations")
        .select("*")
        .eq("user_id", userId)
        .order("name", { ascending: true })
        .limit(limit ?? 50);

      if (tag) qb = qb.contains("tags", [tag]);

      const { data, error } = await qb;
      if (error) throw new Error(`org_list failed: ${error.message}`);
      return ok({ success: true, count: data.length, organizations: data });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // org_search — FTS across name, industry, notes
  // ──────────────────────────────────────────────────────────────────────────
  server.tool(
    "org_search",
    "Full-text search across organization name, industry, and notes. Falls back to ILIKE if FTS is unavailable.",
    {
      query: z.string().describe("Search term"),
      tag: z.string().optional(),
      limit: z.number().optional().describe("Max results (default 20)"),
    },
    async ({ query, tag, limit }) => {
      const max = limit ?? 20;
      const tsQuery = query.trim().split(/\s+/).filter(Boolean).join(" & ");

      let qb = supabase
        .from("organizations")
        .select("*")
        .eq("user_id", userId)
        .textSearch("fts", tsQuery, { config: "english" })
        .limit(max);

      if (tag) qb = qb.contains("tags", [tag]);

      const { data, error } = await qb;
      if (error) {
        // FTS column may not exist on a fresh install — fall back to ILIKE
        let fallback = supabase
          .from("organizations")
          .select("*")
          .eq("user_id", userId)
          .or(
            `name.ilike.%${query}%,industry.ilike.%${query}%,notes.ilike.%${query}%`,
          )
          .limit(max);
        if (tag) fallback = fallback.contains("tags", [tag]);
        const { data: fbData, error: fbError } = await fallback;
        if (fbError) throw new Error(`org_search failed: ${fbError.message}`);
        return ok({
          success: true,
          mode: "ilike-fallback",
          count: fbData.length,
          organizations: fbData,
        });
      }
      return ok({ success: true, mode: "fts", count: data.length, organizations: data });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // org_get — single org + its contacts
  // ──────────────────────────────────────────────────────────────────────────
  server.tool(
    "org_get",
    "Get a single organization by id, including contacts associated with it.",
    {
      org_id: z.string().describe("Organization UUID"),
    },
    async ({ org_id }) => {
      const { data: org, error: orgErr } = await supabase
        .from("organizations")
        .select("*")
        .eq("id", org_id)
        .eq("user_id", userId)
        .maybeSingle();

      if (orgErr) throw new Error(`org_get failed: ${orgErr.message}`);
      if (!org) throw new Error(`Organization not found: ${org_id}`);

      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, name, title, email, tags, last_contacted")
        .eq("user_id", userId)
        .eq("organization_id", org_id)
        .order("name", { ascending: true });

      return ok({ success: true, organization: org, contacts: contacts ?? [] });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // org_update
  // ──────────────────────────────────────────────────────────────────────────
  server.tool(
    "org_update",
    "Update fields on an existing organization. Pass only the fields you want to change.",
    {
      org_id: z.string(),
      name: z.string().optional(),
      industry: z.string().optional(),
      website: z.string().optional(),
      size: sizeEnum.optional(),
      headquarters_location_id: z.string().optional(),
      remote_policy: remotePolicyEnum.optional(),
      glassdoor_rating: z.number().min(1.0).max(5.0).optional(),
      notes: z.string().optional(),
    },
    async (args) => {
      const { org_id, ...rest } = args;
      const patch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined) patch[k] = v;
      }
      if (Object.keys(patch).length === 0) {
        throw new Error("org_update: no fields to update");
      }

      const { data, error } = await supabase
        .from("organizations")
        .update(patch)
        .eq("id", org_id)
        .eq("user_id", userId)
        .select()
        .single();

      if (error) throw new Error(`org_update failed: ${error.message}`);
      return ok({ success: true, organization: data });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // org_tag — add or remove tags atomically
  // ──────────────────────────────────────────────────────────────────────────
  server.tool(
    "org_tag",
    "Add or remove tags on an organization. Tags are merged with the existing set; deduplicated.",
    {
      org_id: z.string(),
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
    },
    async ({ org_id, add, remove }) => {
      const { data: current, error: getErr } = await supabase
        .from("organizations")
        .select("tags")
        .eq("id", org_id)
        .eq("user_id", userId)
        .single();

      if (getErr) throw new Error(`org_tag fetch failed: ${getErr.message}`);

      const existing = new Set<string>((current?.tags as string[]) ?? []);
      for (const t of add ?? []) existing.add(t);
      for (const t of remove ?? []) existing.delete(t);

      const nextTags = Array.from(existing);

      const { data, error } = await supabase
        .from("organizations")
        .update({ tags: nextTags })
        .eq("id", org_id)
        .eq("user_id", userId)
        .select()
        .single();

      if (error) throw new Error(`org_tag update failed: ${error.message}`);
      return ok({ success: true, organization: data });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // org_merge
  // Move all FK references from merge_org_id -> keep_org_id, then delete merge.
  // Intended for de-duplication after partial captures produced two orgs for
  // the same real-world institution (different spellings / casings).
  // ──────────────────────────────────────────────────────────────────────────
  server.tool(
    "org_merge",
    "Merge two organizations: re-point all contacts and entities from `merge_org_id` to `keep_org_id`, then delete the merged org. Use after spotting a dupe.",
    {
      keep_org_id: z.string().describe("UUID of the org to keep"),
      merge_org_id: z.string().describe("UUID of the org to absorb and delete"),
    },
    async ({ keep_org_id, merge_org_id }) => {
      if (keep_org_id === merge_org_id) {
        throw new Error("org_merge: keep and merge ids are the same");
      }

      // Validate both exist and belong to this user
      const { data: orgs, error: lookupErr } = await supabase
        .from("organizations")
        .select("id, name")
        .eq("user_id", userId)
        .in("id", [keep_org_id, merge_org_id]);
      if (lookupErr) throw new Error(`org_merge lookup failed: ${lookupErr.message}`);
      if (!orgs || orgs.length !== 2) {
        throw new Error("org_merge: one or both organizations not found");
      }

      // Re-point contacts.organization_id
      const { count: contactsUpdated, error: contactsErr } = await supabase
        .from("contacts")
        .update({ organization_id: keep_org_id }, { count: "exact" })
        .eq("user_id", userId)
        .eq("organization_id", merge_org_id);
      if (contactsErr) throw new Error(`org_merge contacts update failed: ${contactsErr.message}`);

      // Re-point entities.organization_id (entities table is global — no user filter)
      const { count: entitiesUpdated, error: entitiesErr } = await supabase
        .from("entities")
        .update({ organization_id: keep_org_id }, { count: "exact" })
        .eq("organization_id", merge_org_id);
      if (entitiesErr) throw new Error(`org_merge entities update failed: ${entitiesErr.message}`);

      // Delete the merged org
      const { error: deleteErr } = await supabase
        .from("organizations")
        .delete()
        .eq("id", merge_org_id)
        .eq("user_id", userId);
      if (deleteErr) throw new Error(`org_merge delete failed: ${deleteErr.message}`);

      return ok({
        success: true,
        message: `Merged ${merge_org_id} into ${keep_org_id}`,
        contacts_repointed: contactsUpdated ?? 0,
        entities_repointed: entitiesUpdated ?? 0,
      });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // org_link_contact — set contacts.organization_id
  // ──────────────────────────────────────────────────────────────────────────
  server.tool(
    "org_link_contact",
    "Link a contact to an organization by setting contacts.organization_id. Pass org_id=null to unlink.",
    {
      contact_id: z.string(),
      org_id: z.string().nullable().describe("UUID of the organization, or null to unlink"),
    },
    async ({ contact_id, org_id }) => {
      const { data, error } = await supabase
        .from("contacts")
        .update({ organization_id: org_id })
        .eq("id", contact_id)
        .eq("user_id", userId)
        .select("id, name, organization_id")
        .single();

      if (error) throw new Error(`org_link_contact failed: ${error.message}`);
      return ok({ success: true, contact: data });
    },
  );

  // ──────────────────────────────────────────────────────────────────────────
  // org_get_contacts
  // ──────────────────────────────────────────────────────────────────────────
  server.tool(
    "org_get_contacts",
    "List contacts at an organization. Optionally filter by contact tag (e.g. 'professional').",
    {
      org_id: z.string(),
      contact_tag: z.string().optional(),
      limit: z.number().optional().describe("Max results (default 50)"),
    },
    async ({ org_id, contact_tag, limit }) => {
      let qb = supabase
        .from("contacts")
        .select("id, name, title, email, phone, linkedin_url, tags, last_contacted")
        .eq("user_id", userId)
        .eq("organization_id", org_id)
        .order("name", { ascending: true })
        .limit(limit ?? 50);

      if (contact_tag) qb = qb.contains("tags", [contact_tag]);

      const { data, error } = await qb;
      if (error) throw new Error(`org_get_contacts failed: ${error.message}`);
      return ok({ success: true, count: data.length, contacts: data });
    },
  );

  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c);
});

app.get("*", (c) => c.json({ status: "ok", service: "Organizations", version: "1.0.0" }));

Deno.serve(app.fetch);
