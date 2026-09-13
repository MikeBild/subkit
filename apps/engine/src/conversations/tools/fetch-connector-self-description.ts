// fetch_connector_self_description — on-demand, transient fetch of the
// machine docs a connector advertises about itself.
//
// A connector's `self_description.links` records WHERE the connector
// publishes its own machine-readable docs — llms.txt / llms-full.txt,
// an OpenAPI spec, or a GraphQL endpoint (discovered during endpoint
// discovery / self-healing, or set manually). It stores LINKS ONLY,
// never the document bodies. This tool reads those links and LIVE-FETCHES
// the requested one(s) at authoring time, returning the text transiently
// in the tool result. It persists NOTHING — no docs ingestion, no DB
// writes — so the authoring loop can pull a fresh spec without warming a
// cache or mutating tenant state.
//
// Egress is guarded (SSRF blocklist) and goes through the driver fetch
// seam exactly like the discovery strategies, with a 15s timeout and a
// 50 KB response cap (truncated, not rejected).

import { z } from "@hono/zod-openapi";
import {
  buildClientSchema,
  getIntrospectionQuery,
  type IntrospectionQuery,
  printSchema,
} from "graphql";

import { getDriverFetch } from "../../connectors/drivers/fetch-seam.ts";
import { assertEgressAllowed } from "../../connectors/egress-guard.ts";
import { getConnector } from "../../connectors/service.ts";
import type {
  ConnectorSelfDescription,
  ConnectorSelfDescriptionLink,
} from "../../connectors/types.ts";
import { logger } from "../../logging/logger.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";

/** Hard transport bounds. Mirrors the discovery strategies' egress
 *  discipline — fetch is bounded in time and size so a hostile or huge
 *  doc can never stall a turn or blow the prompt budget. */
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 50 * 1024;

const inputSchema = z
  .object({
    connector_id: z.string().uuid().optional(),
    kind: z.enum(["llms", "openapi", "graphql", "all"]).default("all"),
  })
  .openapi("FetchConnectorSelfDescriptionToolInput");

/** What the operator asked for, expanded into the concrete link kinds we
 *  look for. `llms` prefers the full-content variant over the index. */
type RequestKind = "llms" | "openapi" | "graphql" | "all";

/** One materialised fetch result, transient. */
interface FetchedSelfDescription {
  kind: RequestKind;
  link_kind: ConnectorSelfDescriptionLink["kind"];
  url: string;
  source: ConnectorSelfDescriptionLink["source"];
  discovered_at: string;
  /** The live-fetched body — `text` for llms/openapi, SDL or raw
   *  introspection JSON for graphql. */
  body: string;
  /** True when the body was truncated to `MAX_RESPONSE_BYTES`. */
  truncated: boolean;
  /** graphql only: whether `body` is rendered SDL or raw introspection JSON. */
  format?: "sdl" | "introspection_json";
}

/** Pick the link for an `llms` request: prefer `llms_full`, fall back to
 *  `llms_txt`. Returns null when neither is recorded. */
function pickLlmsLink(links: ConnectorSelfDescriptionLink[]): ConnectorSelfDescriptionLink | null {
  return (
    links.find((l) => l.kind === "llms_full") ?? links.find((l) => l.kind === "llms_txt") ?? null
  );
}

/** Decode an arrayBuffer to text, capping at `MAX_RESPONSE_BYTES`. */
function decodeCapped(buf: ArrayBuffer): { text: string; truncated: boolean } {
  if (buf.byteLength > MAX_RESPONSE_BYTES) {
    return { text: new TextDecoder().decode(buf.slice(0, MAX_RESPONSE_BYTES)), truncated: true };
  }
  return { text: new TextDecoder().decode(buf), truncated: false };
}

/** Run `fn` against an AbortController wired to the turn signal + the
 *  per-fetch timeout. Clears the timer on completion. */
async function withTimeout<T>(
  ctx: ToolContext,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  if (ctx.abortSignal) {
    if (ctx.abortSignal.aborted) controller.abort();
    else ctx.abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** GET a self-description URL, egress-guarded + bounded. Throws on a
 *  non-2xx or transport error so the caller can attach a per-link error. */
async function fetchTextLink(
  ctx: ToolContext,
  url: string,
): Promise<{ text: string; truncated: boolean }> {
  assertEgressAllowed(url, { tenant_id: ctx.tenant_id });
  return withTimeout(ctx, async (signal) => {
    const res = await getDriverFetch()(url, {
      method: "GET",
      headers: { accept: "text/plain, text/markdown, application/json, application/yaml, */*" },
      signal,
    });
    if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
    return decodeCapped(await res.arrayBuffer());
  });
}

/** POST the standard introspection query to a GraphQL endpoint. Renders
 *  SDL when the schema builds; otherwise returns the raw introspection
 *  JSON. Both forms are capped. Throws on a non-2xx / transport error. */
async function fetchGraphqlIntrospection(
  ctx: ToolContext,
  url: string,
): Promise<{ body: string; truncated: boolean; format: "sdl" | "introspection_json" }> {
  assertEgressAllowed(url, { tenant_id: ctx.tenant_id });
  const raw = await withTimeout(ctx, async (signal) => {
    const res = await getDriverFetch()(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        query: getIntrospectionQuery(),
        operationName: "IntrospectionQuery",
      }),
      signal,
    });
    if (!res.ok) throw new Error(`POST ${url} returned ${res.status}`);
    return new TextDecoder().decode(await res.arrayBuffer());
  });

  const parsed = JSON.parse(raw) as { data?: IntrospectionQuery; errors?: unknown };
  if (!parsed.data?.__schema) {
    throw new Error(`introspection response from ${url} missing data.__schema`);
  }
  // Prefer SDL — far more compact + readable than introspection JSON. Fall
  // back to capped raw JSON when the schema can't be rebuilt.
  try {
    const sdl = printSchema(buildClientSchema(parsed.data));
    const capped = capString(sdl);
    return { body: capped.text, truncated: capped.truncated, format: "sdl" };
  } catch {
    const capped = capString(JSON.stringify(parsed.data));
    return { body: capped.text, truncated: capped.truncated, format: "introspection_json" };
  }
}

/** Byte-cap a string at `MAX_RESPONSE_BYTES`. */
function capString(s: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= MAX_RESPONSE_BYTES) return { text: s, truncated: false };
  return { text: buf.subarray(0, MAX_RESPONSE_BYTES).toString("utf8"), truncated: true };
}

export const fetchConnectorSelfDescriptionTool: ConversationTool = {
  name: "fetch_connector_self_description",
  description:
    "Live-fetch the machine docs a connector publishes ABOUT ITSELF — its llms.txt / llms-full.txt, OpenAPI spec, or GraphQL schema (via introspection) — using the self-description links recorded on the connector. The body is fetched fresh on demand and returned transiently; nothing is persisted. Call this when the authoring context shows a connector that 'publishes its own docs' and you need the actual endpoint / type / field details before drafting a `request` step. Pass `kind` to narrow to one form (`llms`, `openapi`, `graphql`) or `all` (default). Requires a connector in scope (or pass `connector_id`). If no matching link is recorded, run `discover_connector_endpoints` first to populate them.",
  inputSchema,
  category: "tenant_read",
  // Builds a definition rather than using one: withheld from the
  // read-and-execute tier even though it only reads.
  authoring_only: true,
  use_case:
    "When a connector advertises self-description links, fetch its llms.txt / OpenAPI / GraphQL schema on demand to ground request steps in the real surface instead of guessing.",
  important_notes: [
    "Fetches live and returns the body transiently — persists nothing (no docs ingestion, no DB writes).",
    "Egress-guarded with a 15s timeout and a 50 KB response cap (oversize bodies are truncated, not rejected).",
    "If the connector records no matching self-description link, run `discover_connector_endpoints` to populate them, then retry.",
  ],
  example_input: { kind: "all" },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const connector_id = args.connector_id ?? ctx.connector_id ?? undefined;
    if (!connector_id) {
      return {
        ok: false,
        error_code: "no_connector_in_scope",
        message: "no connector in scope; pass connector_id or set a connector for the conversation",
        next_best_actions: ["find_connector", "get_connector"],
        data: { error: "no connector in scope" },
      };
    }

    const connector = await getConnector(ctx.tenant_id, connector_id, ctx.db);
    if (!connector) {
      return {
        ok: false,
        error_code: "connector_not_found",
        message: `no connector with id '${connector_id}' in this tenant`,
        next_best_actions: ["list_connectors", "get_connector"],
        data: { connector_id },
      };
    }

    const selfDescription = (connector.self_description ?? {}) as ConnectorSelfDescription;
    const links = selfDescription.links ?? [];

    // Resolve the requested kind(s) to the concrete links we'll fetch.
    const wants = (k: RequestKind): boolean => args.kind === "all" || args.kind === k;
    const planned: Array<{ kind: RequestKind; link: ConnectorSelfDescriptionLink }> = [];
    if (wants("llms")) {
      const link = pickLlmsLink(links);
      if (link) planned.push({ kind: "llms", link });
    }
    if (wants("openapi")) {
      const link = links.find((l) => l.kind === "openapi");
      if (link) planned.push({ kind: "openapi", link });
    }
    if (wants("graphql")) {
      const link = links.find((l) => l.kind === "graphql");
      if (link) planned.push({ kind: "graphql", link });
    }

    if (planned.length === 0) {
      const kindLabel = args.kind === "all" ? "self-description" : args.kind;
      return {
        ok: false,
        error_code: "no_self_description_link",
        message: `no ${kindLabel} link recorded for connector '${connector.slug}' — run discover_connector_endpoints to populate self-description links, then retry`,
        next_best_actions: ["discover_connector_endpoints", "fetch_connector_docs"],
        data: {
          connector_id,
          connector_slug: connector.slug,
          requested_kind: args.kind,
          available_link_kinds: links.map((l) => l.kind),
        },
      };
    }

    const fetched: FetchedSelfDescription[] = [];
    const errors: Array<{ kind: RequestKind; link_kind: string; url: string; error: string }> = [];
    for (const { kind, link } of planned) {
      try {
        if (kind === "graphql") {
          const out = await fetchGraphqlIntrospection(ctx, link.url);
          fetched.push({
            kind,
            link_kind: link.kind,
            url: link.url,
            source: link.source,
            discovered_at: link.discovered_at,
            body: out.body,
            truncated: out.truncated,
            format: out.format,
          });
        } else {
          const out = await fetchTextLink(ctx, link.url);
          fetched.push({
            kind,
            link_kind: link.kind,
            url: link.url,
            source: link.source,
            discovered_at: link.discovered_at,
            body: out.text,
            truncated: out.truncated,
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({
          module: "conversation_tool",
          action: "fetch_connector_self_description.error",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          connector_id,
          link_kind: link.kind,
          error_message: message,
        });
        errors.push({ kind, link_kind: link.kind, url: link.url, error: message });
      }
    }

    if (fetched.length === 0) {
      return {
        ok: false,
        error_code: "self_description_fetch_failed",
        message: `failed to fetch any self-description doc for connector '${connector.slug}'`,
        next_best_actions: ["discover_connector_endpoints", "fetch_connector_docs"],
        data: { connector_id, connector_slug: connector.slug, errors },
      };
    }

    return {
      ok: true,
      data: {
        connector_id,
        connector_slug: connector.slug,
        // Transient — fetched live this turn, persisted nowhere.
        documents: fetched,
        ...(errors.length > 0 ? { errors } : {}),
      },
    };
  },
};
