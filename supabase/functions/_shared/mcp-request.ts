/**
 * Common request-handling for the MCP Edge Functions in this project:
 * env loading, `key`/`x-access-key` auth, and the Claude Desktop Accept-header
 * patch. Pulled out of organizations-mcp, professional-crm-mcp,
 * family-calendar-mcp, and household-knowledge-mcp, which each reimplemented
 * this identically.
 *
 * Deliberately NOT adopted by open-brain-mcp (different, JSON-RPC-aware auth
 * — see its own comment referencing NateBJones-Projects/OB1#33 — plus a
 * `thoughts` table that isn't user-scoped) or entity-extraction-worker (a
 * plain REST worker, not an MCP tool server, with its own 3-method auth).
 *
 * Pattern: read env + build the Supabase client + register tools ONCE at
 * module scope (cold start), not per request — matches open-brain-mcp, which
 * already does this. Each request only needs the auth check + Accept-header
 * patch before handing off to the transport.
 */

import type { Context } from "hono";

/** Read a required env var; throws (failing the function's cold start) if unset. */
export function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} not configured`);
  return value;
}

const MCP_ACCESS_KEY = Deno.env.get("MCP_ACCESS_KEY") ?? "";

/** `?key=` or `x-access-key` header, checked against MCP_ACCESS_KEY. */
// deno-lint-ignore no-explicit-any
export function isAuthorized(c: Context<any>): boolean {
  const key = c.req.query("key") || c.req.header("x-access-key");
  return !!key && key === MCP_ACCESS_KEY;
}

/**
 * Claude Desktop connectors don't send the `Accept: text/event-stream`
 * header StreamableHTTPTransport requires. Patch it in if missing.
 */
// deno-lint-ignore no-explicit-any
export function patchAcceptHeader(c: Context<any>): void {
  if (c.req.header("accept")?.includes("text/event-stream")) return;
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

/** Standard MCP tool-result envelope: JSON payload as a single text block. */
export function ok(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * PostgREST's `.or()` filter string treats `,` `.` `(` `)` `\` as syntax
 * (condition separator, column.operator.value separator, grouping, escape).
 * Unescaped user input in an ILIKE fallback can reshape the filter instead
 * of just matching text. Escape those characters before interpolating.
 * https://postgrest.org/en/stable/references/api/tables_views.html#operators
 */
export function escapePostgrestFilterValue(value: string): string {
  return value.replace(/[,.()\\]/g, "\\$&");
}
