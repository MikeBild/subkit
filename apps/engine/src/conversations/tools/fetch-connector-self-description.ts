import { z } from "@hono/zod-openapi";
import {
  buildClientSchema,
  getIntrospectionQuery,
  type IntrospectionQuery,
  printSchema,
} from "graphql";
import { getDriverFetch } from "../../connectors/drivers/fetch-seam.ts";
import { fetchWithEgressGuard } from "../../connectors/index.ts";
import { getConnector } from "../../connectors/service.ts";
import type {
  ConnectorSelfDescription,
  ConnectorSelfDescriptionLink,
} from "../../connectors/types.ts";
import { logger } from "../../logging/logger.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 50 * 1024;

const inputSchema = z
  .object({
    connector_id: z.string().uuid().optional(),
    kind: z.enum(["llms", "openapi", "graphql", "all"]).default("all"),
  })
  .openapi("FetchConnectorSelfDescriptionToolInput");

type RequestKind = "llms" | "openapi" | "graphql" | "all";

interface FetchedSelfDescription {
  kind: RequestKind;
  link_kind: ConnectorSelfDescriptionLink["kind"];
  url: string;
  source: ConnectorSelfDescriptionLink["source"];
  discovered_at: string;
  body: string;
  truncated: boolean;
  format?: "sdl" | "introspection_json";
}

function pickLlmsLink(links: ConnectorSelfDescriptionLink[]): ConnectorSelfDescriptionLink | null {
  return (
    links.find((l) => l.kind === "llms_full") ?? links.find((l) => l.kind === "llms_txt") ?? null
  );
}

function decodeCapped(buf: ArrayBuffer): { text: string; truncated: boolean } {
  if (buf.byteLength > MAX_RESPONSE_BYTES) {
    return { text: new TextDecoder().decode(buf.slice(0, MAX_RESPONSE_BYTES)), truncated: true };
  }
  return { text: new TextDecoder().decode(buf), truncated: false };
}

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

async function fetchTextLink(
  ctx: ToolContext,
  url: string,
): Promise<{ text: string; truncated: boolean }> {
  return withTimeout(ctx, async (signal) => {
    const res = await fetchWithEgressGuard(
      url,
      {
        method: "GET",
        headers: { accept: "text/plain, text/markdown, application/json, application/yaml, */*" },
        signal,
      },
      { tenant_id: ctx.tenant_id, exec: ctx.db },
      { fetchImpl: getDriverFetch() },
    );
    if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
    return decodeCapped(await res.arrayBuffer());
  });
}

async function fetchGraphqlIntrospection(
  ctx: ToolContext,
  url: string,
): Promise<{ body: string; truncated: boolean; format: "sdl" | "introspection_json" }> {
  const raw = await withTimeout(ctx, async (signal) => {
    const res = await fetchWithEgressGuard(
      url,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          query: getIntrospectionQuery(),
          operationName: "IntrospectionQuery",
        }),
        signal,
      },
      { tenant_id: ctx.tenant_id, exec: ctx.db },
      { fetchImpl: getDriverFetch() },
    );
    if (!res.ok) throw new Error(`POST ${url} returned ${res.status}`);
    return new TextDecoder().decode(await res.arrayBuffer());
  });

  const parsed = JSON.parse(raw) as { data?: IntrospectionQuery; errors?: unknown };
  if (!parsed.data?.__schema) {
    throw new Error(`introspection response from ${url} missing data.__schema`);
  }
  try {
    const sdl = printSchema(buildClientSchema(parsed.data));
    const capped = capString(sdl);
    return { body: capped.text, truncated: capped.truncated, format: "sdl" };
  } catch {
    const capped = capString(JSON.stringify(parsed.data));
    return { body: capped.text, truncated: capped.truncated, format: "introspection_json" };
  }
}

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
        documents: fetched,
        ...(errors.length > 0 ? { errors } : {}),
      },
    };
  },
};
