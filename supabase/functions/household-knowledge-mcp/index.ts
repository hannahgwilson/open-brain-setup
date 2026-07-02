/**
 * Extension 1: Household Knowledge Base MCP Server
 *
 * Provides tools for storing and retrieving household facts:
 * - Household items (paint colors, appliances, measurements, etc.)
 * - Vendor contacts (service providers)
 */

import { Hono } from "hono";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import { escapePostgrestFilterValue, isAuthorized, ok, patchAcceptHeader, requireEnv } from "../_shared/mcp-request.ts";

const app = new Hono();

// ──────────────────────────────────────────────────────────────────────────
// Module-scope setup — read once at cold start, reused across every request.
// ──────────────────────────────────────────────────────────────────────────
const supabase = createClient(
  requireEnv("SUPABASE_URL"),
  requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
);
const userId = requireEnv("DEFAULT_USER_ID");

const server = new McpServer({ name: "household-knowledge", version: "1.1.0" });

// Add household item
server.tool(
  "add_household_item",
  "Add a new household item (paint color, appliance, measurement, document, etc.)",
  {
    name: z.string().describe("Name or description of the item"),
    category: z.string().optional().describe("Category (e.g. 'paint', 'appliance', 'measurement', 'document')"),
    location: z.string().optional().describe("Location in the home (e.g. 'Living Room', 'Kitchen')"),
    details: z.string().optional().describe("Flexible metadata as JSON string (e.g. '{\"brand\": \"Sherwin Williams\", \"color\": \"Sea Salt\"}')"),
    notes: z.string().optional().describe("Additional notes or context"),
  },
  async ({ name, category, location, details, notes }) => {
    // `details` is stored as jsonb — parse the JSON string into an object
    // before inserting, or it lands in the column as an escaped string blob
    // instead of a queryable object.
    let parsedDetails: Record<string, unknown> = {};
    if (details) {
      try {
        parsedDetails = JSON.parse(details);
      } catch (e) {
        throw new Error(`add_household_item: details is not valid JSON: ${(e as Error).message}`);
      }
    }

    const { data, error } = await supabase
      .from("household_items")
      .insert({
        user_id: userId,
        name,
        category: category || null,
        location: location || null,
        details: parsedDetails,
        notes: notes || null,
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to add household item: ${error.message}`);
    return ok({ success: true, message: `Added household item: ${name}`, item: data });
  },
);

// Search household items
server.tool(
  "search_household_items",
  "Search household items by name, category, or location",
  {
    query: z.string().optional().describe("Search term (searches name, category, location, and notes)"),
    category: z.string().optional().describe("Filter by specific category"),
    location: z.string().optional().describe("Filter by specific location"),
  },
  async ({ query, category, location }) => {
    let queryBuilder = supabase
      .from("household_items")
      .select("*")
      .eq("user_id", userId);

    if (category) {
      queryBuilder = queryBuilder.ilike("category", `%${category}%`);
    }

    if (location) {
      queryBuilder = queryBuilder.ilike("location", `%${location}%`);
    }

    if (query) {
      // User-supplied text splicing into a PostgREST `.or()` filter string —
      // reserved filter-grammar characters (`,` `.` `(` `)` `\`) must be
      // escaped or they'd reshape the filter instead of just matching text.
      const escaped = escapePostgrestFilterValue(query);
      queryBuilder = queryBuilder.or(
        `name.ilike.%${escaped}%,category.ilike.%${escaped}%,location.ilike.%${escaped}%,notes.ilike.%${escaped}%`,
      );
    }

    const { data, error } = await queryBuilder.order("created_at", { ascending: false });
    if (error) throw new Error(`Failed to search household items: ${error.message}`);
    return ok({ success: true, count: data.length, items: data });
  },
);

// Get item details
server.tool(
  "get_item_details",
  "Get full details of a specific household item by ID",
  {
    item_id: z.string().describe("Item ID (UUID)"),
  },
  async ({ item_id }) => {
    const { data, error } = await supabase
      .from("household_items")
      .select("*")
      .eq("id", item_id)
      .eq("user_id", userId)
      .single();

    if (error) throw new Error(`Failed to get item details: ${error.message}`);
    if (!data) throw new Error("Item not found or access denied");

    return ok({ success: true, item: data });
  },
);

// Add vendor
server.tool(
  "add_vendor",
  "Add a service provider (plumber, electrician, landscaper, etc.)",
  {
    name: z.string().describe("Vendor name"),
    service_type: z.string().optional().describe("Type of service (e.g. 'plumber', 'electrician', 'landscaper')"),
    phone: z.string().optional().describe("Phone number"),
    email: z.string().optional().describe("Email address"),
    website: z.string().optional().describe("Website URL"),
    notes: z.string().optional().describe("Additional notes"),
    rating: z.number().min(1).max(5).optional().describe("Rating from 1-5"),
    last_used: z.string().optional().describe("Date last used (YYYY-MM-DD format)"),
  },
  async ({ name, service_type, phone, email, website, notes, rating, last_used }) => {
    // Vendors live in the unified `contacts` table, tagged 'vendor'.
    // last_used maps to contacts.last_contacted (same semantic).
    const { data, error } = await supabase
      .from("contacts")
      .insert({
        user_id: userId,
        name,
        service_type: service_type || null,
        phone: phone || null,
        email: email || null,
        website: website || null,
        notes: notes || null,
        rating: rating || null,
        last_contacted: last_used ? new Date(last_used).toISOString() : null,
        tags: ["vendor"],
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to add vendor: ${error.message}`);
    return ok({ success: true, message: `Added vendor: ${name}`, vendor: data });
  },
);

// List vendors
server.tool(
  "list_vendors",
  "List service providers, optionally filtered by service type",
  {
    service_type: z.string().optional().describe("Filter by service type (e.g. 'plumber', 'electrician')"),
  },
  async ({ service_type }) => {
    // Vendors live in the unified `contacts` table, tagged 'vendor'.
    let queryBuilder = supabase
      .from("contacts")
      .select("*")
      .eq("user_id", userId)
      .contains("tags", ["vendor"]);

    if (service_type) {
      queryBuilder = queryBuilder.ilike("service_type", `%${service_type}%`);
    }

    const { data, error } = await queryBuilder.order("name", { ascending: true });
    if (error) throw new Error(`Failed to list vendors: ${error.message}`);
    return ok({ success: true, count: data.length, vendors: data });
  },
);

// ──────────────────────────────────────────────────────────────────────────
// HTTP entrypoint
// ──────────────────────────────────────────────────────────────────────────
app.post("*", async (c) => {
  patchAcceptHeader(c);
  if (!isAuthorized(c)) return c.json({ error: "Unauthorized" }, 401);

  const transport = new StreamableHTTPTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(c);
});

app.get("*", (c) => c.json({ status: "ok", service: "Household Knowledge MCP", version: "1.1.0" }));

Deno.serve(app.fetch);
