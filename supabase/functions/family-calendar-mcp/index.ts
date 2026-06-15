import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";

const app = new Hono();

const DAYS_OF_WEEK = [
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
] as const;
const dayOfWeekSchema = z.enum(DAYS_OF_WEEK);

function dateForDayInWeek(weekStartIso: string, dayOfWeek: string): Date {
  const offset = DAYS_OF_WEEK.indexOf(dayOfWeek as typeof DAYS_OF_WEEK[number]);
  const d = new Date(weekStartIso);
  if (offset >= 0) d.setUTCDate(d.getUTCDate() + offset);
  return d;
}

function eventOccursInWeek(
  event: {
    cadence_type: string;
    cadence_weeks: number | null;
    day_of_week: string | null;
    reference_date: string | null;
    start_date: string | null;
    end_date: string | null;
  },
  weekStartIso: string,
): boolean {
  const weekStart = new Date(weekStartIso);
  const weekEnd = new Date(weekStartIso);
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

  if (event.cadence_type === "once") {
    if (!event.start_date) return false;
    const d = new Date(event.start_date);
    return d >= weekStart && d < weekEnd;
  }

  if (!event.day_of_week) return false;
  const target = dateForDayInWeek(weekStartIso, event.day_of_week);
  if (event.start_date && new Date(event.start_date) > target) return false;
  if (event.end_date && new Date(event.end_date) < target) return false;
  if (event.cadence_type === "weekly") return true;

  if (!event.reference_date || !event.cadence_weeks) return false;
  const ref = new Date(event.reference_date);
  const dayMs = 24 * 60 * 60 * 1000;
  const deltaDays = Math.round((target.getTime() - ref.getTime()) / dayMs);
  if (deltaDays < 0) return false;
  const deltaWeeks = Math.round(deltaDays / 7);
  return deltaWeeks % event.cadence_weeks === 0;
}

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
  if (!key || key !== expected) return c.json({ error: "Unauthorized" }, 401);

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
  const userId = Deno.env.get("DEFAULT_USER_ID");
  if (!userId) return c.json({ error: "DEFAULT_USER_ID not configured" }, 500);

  const server = new McpServer({ name: "family-calendar", version: "3.0.0" });
  const textResult = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  });

  // ==========================================================================
  // locations
  // ==========================================================================
  server.tool(
    "add_location",
    "Add a location (home, office, swim class, etc.)",
    {
      name: z.string(),
      address: z.string().optional(),
      travel_minutes_from_home: z.number().int().optional(),
      notes: z.string().optional(),
    },
    async (args) => {
      const { data, error } = await supabase.from("locations")
        .insert({ user_id: userId, ...args }).select().single();
      if (error) throw error;
      return textResult(data);
    },
  );

  server.tool("list_locations", "List all saved locations", {}, async () => {
    const { data, error } = await supabase.from("locations")
      .select("*").eq("user_id", userId).order("name");
    if (error) throw error;
    return textResult(data);
  });

  // ==========================================================================
  // contacts — unified table for all humans (household, vendors, friends, pros)
  // ==========================================================================
  server.tool(
    "add_contact",
    "Add a contact (household member, vendor, friend, professional). Use tags to classify: 'household_member', 'vendor', 'professional', 'friend'.",
    {
      name: z.string(),
      relationship: z.string().optional().describe("'spouse', 'au_pair', 'dog_walker', 'pediatrician', etc."),
      birth_date: z.string().optional().describe("YYYY-MM-DD"),
      email: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
      website: z.string().optional(),
      linkedin_url: z.string().optional(),
      company: z.string().optional(),
      title: z.string().optional(),
      service_type: z.string().optional().describe("For vendors: 'dog_walker', 'cleaner', etc."),
      rating: z.number().int().min(1).max(5).optional(),
      tags: z.array(z.string()).optional().describe("Classification tags"),
      how_we_met: z.string().optional(),
      notes: z.string().optional(),
    },
    async (args) => {
      const { data, error } = await supabase.from("contacts")
        .insert({ user_id: userId, ...args, tags: args.tags ?? [] })
        .select().single();
      if (error) throw error;
      return textResult(data);
    },
  );

  server.tool(
    "list_contacts",
    "List contacts, optionally filtered by tag, relationship, or service type",
    {
      tag: z.string().optional().describe("Filter to contacts where this tag is present (e.g. 'household_member', 'vendor')"),
      relationship: z.string().optional(),
      service_type: z.string().optional(),
    },
    async (args) => {
      let q = supabase.from("contacts").select("*").eq("user_id", userId);
      if (args.tag) q = q.contains("tags", [args.tag]);
      if (args.relationship) q = q.eq("relationship", args.relationship);
      if (args.service_type) q = q.eq("service_type", args.service_type);
      const { data, error } = await q.order("name");
      if (error) throw error;
      return textResult(data);
    },
  );

  server.tool(
    "update_contact",
    "Update fields on an existing contact. Only supplied fields are changed.",
    {
      contact_id: z.string().uuid(),
      name: z.string().optional(),
      relationship: z.string().optional(),
      birth_date: z.string().optional(),
      email: z.string().optional(),
      phone: z.string().optional(),
      address: z.string().optional(),
      website: z.string().optional(),
      linkedin_url: z.string().optional(),
      company: z.string().optional(),
      title: z.string().optional(),
      service_type: z.string().optional(),
      rating: z.number().int().min(1).max(5).optional(),
      tags: z.array(z.string()).optional(),
      how_we_met: z.string().optional(),
      last_contacted: z.string().optional().describe("ISO timestamp"),
      follow_up_date: z.string().optional().describe("YYYY-MM-DD"),
      notes: z.string().optional(),
    },
    async ({ contact_id, ...patch }) => {
      // Strip undefined values so we only update fields the caller supplied.
      const cleaned = Object.fromEntries(
        Object.entries(patch).filter(([, v]) => v !== undefined),
      );
      const { data, error } = await supabase.from("contacts")
        .update(cleaned).eq("id", contact_id).eq("user_id", userId)
        .select().single();
      if (error) throw error;
      return textResult(data);
    },
  );

  // ==========================================================================
  // pets
  // ==========================================================================
  server.tool(
    "add_pet",
    "Add a pet",
    {
      name: z.string(),
      species: z.string().optional().describe("'dog', 'cat', etc."),
      breed: z.string().optional(),
      birth_date: z.string().optional(),
      walks_per_day: z.number().int().optional(),
      notes: z.string().optional(),
    },
    async (args) => {
      const { data, error } = await supabase.from("pets")
        .insert({ user_id: userId, ...args }).select().single();
      if (error) throw error;
      return textResult(data);
    },
  );

  server.tool("list_pets", "List all pets", {}, async () => {
    const { data, error } = await supabase.from("pets")
      .select("*").eq("user_id", userId).order("name");
    if (error) throw error;
    return textResult(data);
  });

  // ==========================================================================
  // household_details — schedule/work attributes for household members
  // ==========================================================================
  server.tool(
    "set_household_details",
    "Upsert household scheduling attributes for a contact (work hours, child routines, etc.). Call after add_contact for household members.",
    {
      contact_id: z.string().uuid(),
      role: z.string().optional().describe("'primary_scheduler', 'partner', 'au_pair', 'child'"),

      work_days: z.array(dayOfWeekSchema).optional(),
      work_start: z.string().optional().describe("HH:MM"),
      work_end: z.string().optional().describe("HH:MM"),
      commute_minutes: z.number().int().optional(),
      office_location_id: z.string().uuid().optional(),
      leaves_home: z.string().optional().describe("HH:MM"),
      returns_home: z.string().optional().describe("HH:MM"),

      weekly_hours_target: z.number().optional(),
      schedule_stability_notes: z.string().optional(),

      nap_start: z.string().optional(),
      nap_end: z.string().optional(),
      bedtime: z.string().optional(),
      wake_start: z.string().optional(),
      wake_end: z.string().optional(),

      preferences: z.string().optional(),
    },
    async (args) => {
      const { data, error } = await supabase.from("household_details")
        .upsert({ user_id: userId, ...args }, { onConflict: "contact_id" })
        .select().single();
      if (error) throw error;
      return textResult(data);
    },
  );

  server.tool(
    "get_household_member",
    "Get full profile for a household member: contact + household_details",
    {
      contact_id: z.string().uuid(),
    },
    async ({ contact_id }) => {
      const { data, error } = await supabase.from("contacts")
        .select(`*, household_details(*)`)
        .eq("id", contact_id).eq("user_id", userId).single();
      if (error) throw error;
      return textResult(data);
    },
  );

  // ==========================================================================
  // events
  // ==========================================================================
  server.tool(
    "add_event",
    "Add a recurring or one-off event. Pass contact_id (human) AND/OR pet_id depending on who the event involves.",
    {
      title: z.string(),
      activity_type: z.string().optional(),
      contact_id: z.string().uuid().optional().describe("Human involved (household member, vendor, etc.)"),
      pet_id: z.string().uuid().optional().describe("Pet involved (for vet visits, dog walks, etc.)"),
      location_id: z.string().uuid().optional(),

      cadence_type: z.enum(["once", "weekly", "biweekly", "every_n_weeks"]),
      cadence_weeks: z.number().int().optional(),
      day_of_week: dayOfWeekSchema.optional(),
      reference_date: z.string().optional().describe("YYYY-MM-DD anchor for biweekly+ cadences"),

      start_time: z.string().optional(),
      end_time: z.string().optional(),
      start_date: z.string().optional(),
      end_date: z.string().optional(),

      notes: z.string().optional(),
    },
    async (args) => {
      const cadence_weeks = args.cadence_weeks
        ?? (args.cadence_type === "weekly" ? 1
          : args.cadence_type === "biweekly" ? 2
          : null);
      const { data, error } = await supabase.from("events")
        .insert({ user_id: userId, ...args, cadence_weeks })
        .select().single();
      if (error) throw error;
      return textResult(data);
    },
  );

  server.tool(
    "get_week_schedule",
    "All events occurring in a Mon-Sun week (recurrence math applied)",
    {
      week_start: z.string().describe("Monday of the week (YYYY-MM-DD)"),
      contact_id: z.string().uuid().optional(),
      pet_id: z.string().uuid().optional(),
    },
    async (args) => {
      let q = supabase.from("events")
        .select(`*,
          contact:contact_id (id, name, relationship, tags),
          pet:pet_id (id, name, species),
          location:location_id (id, name, address)`)
        .eq("user_id", userId);
      if (args.contact_id) q = q.eq("contact_id", args.contact_id);
      if (args.pet_id) q = q.eq("pet_id", args.pet_id);
      const { data, error } = await q.order("start_time");
      if (error) throw error;
      const occurring = (data ?? []).filter((e) => eventOccursInWeek(e, args.week_start));
      return textResult(occurring);
    },
  );

  server.tool(
    "search_events",
    "Search events by title, activity_type, contact, or pet",
    {
      query: z.string().optional(),
      activity_type: z.string().optional(),
      contact_id: z.string().uuid().optional(),
      pet_id: z.string().uuid().optional(),
    },
    async (args) => {
      let q = supabase.from("events")
        .select(`*, contact:contact_id (id, name), pet:pet_id (id, name), location:location_id (id, name)`)
        .eq("user_id", userId);
      if (args.query) q = q.ilike("title", `%${args.query}%`);
      if (args.activity_type) q = q.eq("activity_type", args.activity_type);
      if (args.contact_id) q = q.eq("contact_id", args.contact_id);
      if (args.pet_id) q = q.eq("pet_id", args.pet_id);
      const { data, error } = await q.order("start_date", { ascending: false });
      if (error) throw error;
      return textResult(data);
    },
  );

  // ==========================================================================
  // caregiver_daily_hours
  // ==========================================================================
  server.tool(
    "set_caregiver_daily_hours",
    "Upsert a caregiver's hours for a day of week",
    {
      contact_id: z.string().uuid(),
      day_of_week: dayOfWeekSchema,
      start_time: z.string().optional(),
      end_time: z.string().optional(),
      is_balance: z.boolean().optional(),
      notes: z.string().optional(),
    },
    async (args) => {
      const { data, error } = await supabase.from("caregiver_daily_hours")
        .upsert({ user_id: userId, ...args, is_balance: args.is_balance ?? false },
                { onConflict: "contact_id,day_of_week" })
        .select().single();
      if (error) throw error;
      return textResult(data);
    },
  );

  // ==========================================================================
  // pet_walks
  // ==========================================================================
  server.tool(
    "set_pet_walk",
    "Upsert a pet's walk routine for a slot. Walker can be any contact (household member or vendor).",
    {
      pet_id: z.string().uuid(),
      slot: z.enum(["morning", "midday", "evening", "night"]),
      scheduled_time: z.string().optional(),
      default_walker_contact_id: z.string().uuid().optional(),
      notes: z.string().optional(),
    },
    async (args) => {
      const { data, error } = await supabase.from("pet_walks")
        .upsert({ user_id: userId, ...args }, { onConflict: "pet_id,slot" })
        .select().single();
      if (error) throw error;
      return textResult(data);
    },
  );

  // ==========================================================================
  // dinner_defaults
  // ==========================================================================
  server.tool(
    "set_dinner_default",
    "Upsert default cook for a day of week",
    {
      day_of_week: dayOfWeekSchema,
      cook_id: z.string().uuid().optional(),
      dish_notes: z.string().optional(),
    },
    async (args) => {
      const { data, error } = await supabase.from("dinner_defaults")
        .upsert({ user_id: userId, ...args }, { onConflict: "user_id,day_of_week" })
        .select().single();
      if (error) throw error;
      return textResult(data);
    },
  );

  server.tool("list_dinner_defaults", "List dinner defaults", {}, async () => {
    const { data, error } = await supabase.from("dinner_defaults")
      .select(`*, cook:cook_id (id, name)`).eq("user_id", userId).order("day_of_week");
    if (error) throw error;
    return textResult(data);
  });

  // ==========================================================================
  // important_dates
  // ==========================================================================
  server.tool(
    "add_important_date",
    "Add a date to remember",
    {
      contact_id: z.string().uuid().optional().describe("Optional — contact this date is about"),
      title: z.string(),
      date_value: z.string().describe("YYYY-MM-DD"),
      recurring_yearly: z.boolean().optional(),
      reminder_days_before: z.number().int().optional(),
      notes: z.string().optional(),
    },
    async (args) => {
      const { data, error } = await supabase.from("important_dates")
        .insert({
          user_id: userId,
          person_id: args.contact_id ?? null,
          title: args.title,
          date_value: args.date_value,
          recurring_yearly: args.recurring_yearly ?? false,
          reminder_days_before: args.reminder_days_before ?? 7,
          notes: args.notes,
        }).select().single();
      if (error) throw error;
      return textResult(data);
    },
  );

  server.tool(
    "get_upcoming_dates",
    "Important dates in the next N days",
    {
      days_ahead: z.number().int().optional(),
    },
    async (args) => {
      const daysAhead = args.days_ahead || 30;
      const today = new Date();
      const futureDate = new Date();
      futureDate.setDate(today.getDate() + daysAhead);
      const { data, error } = await supabase.from("important_dates")
        .select("*").eq("user_id", userId)
        .gte("date_value", today.toISOString().split("T")[0])
        .lte("date_value", futureDate.toISOString().split("T")[0])
        .order("date_value");
      if (error) throw error;
      return textResult(data);
    },
  );

  const transport = new StreamableHTTPTransport();
  await server.connect(transport);
  return transport.handleRequest(c);
});

app.get("*", (c) => c.json({ status: "ok", service: "Family Calendar", version: "3.0.0" }));

Deno.serve(app.fetch);
