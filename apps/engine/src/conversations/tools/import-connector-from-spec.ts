import type { z } from "@hono/zod-openapi";
import type { EgressGuardContext } from "../../connectors/egress-guard.ts";
import {
  fetchGoogleDiscoverySpec,
  fetchGraphQLIntrospection,
  fetchOpenApiSpec,
} from "../../connectors/spec-fetchers.ts";
import { enrichConnectorFromTemplate } from "../../connectors/template-enrichment.ts";
import { matchTemplateByUrl } from "../../connectors/template-url-match.ts";
import type { EndpointSpec } from "../../llm/flows/document-analysis.ts";
import { parseCurlCommand } from "../../llm/flows/document-parsers/curl.ts";
import { parseGoogleDiscoveryWithMetadata } from "../../llm/flows/document-parsers/google-discovery.ts";
import { parseGraphQL } from "../../llm/flows/document-parsers/graphql.ts";
import { parseGraphQLIntrospection } from "../../llm/flows/document-parsers/graphql-introspection.ts";
import { parseHar } from "../../llm/flows/document-parsers/har.ts";
import { parseOpenApiWithMetadata } from "../../llm/flows/document-parsers/openapi.ts";
import { parsePostman } from "../../llm/flows/document-parsers/postman.ts";
import { findReusableConnectorByUrl, type ReusedConnectorEnvelope } from "./connector-reuse.ts";
import { importConnectorFromSpecInputSchema as inputSchema } from "./import-connector-from-spec-contract.ts";
import type { ConversationTool, ToolContext, ToolResult } from "./index.ts";

type Parsed = {
  endpoints: EndpointSpec[];
  base_url: string;
  auth_hint?: {
    type: "none" | "header" | "query" | "bearer" | "basic" | "oauth2";
    header_name?: string;
    query_param?: string;
  } | null;
};

function urlBaseFromFullUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return u;
  }
}

function firstEndpointBaseUrl(eps: EndpointSpec[]): string {
  for (const ep of eps) {
    if (ep.path.startsWith("http")) return urlBaseFromFullUrl(ep.path);
  }
  return "";
}

async function parseSource(
  args: z.infer<typeof inputSchema>,
  context: EgressGuardContext,
): Promise<Parsed> {
  const { source, content, headers } = args;
  if (source === "curl") {
    const curl = parseCurlCommand(content);
    return {
      endpoints: [
        {
          path: curl.url,
          method: curl.method as EndpointSpec["method"],
          expected_statuses: [200],
          idempotent: ["GET", "HEAD", "OPTIONS"].includes(curl.method),
        },
      ],
      base_url: urlBaseFromFullUrl(curl.url),
      auth_hint: curl.auth_hint ?? null,
    };
  }
  if (source === "postman") {
    const eps = parsePostman(content);
    return { endpoints: eps, base_url: firstEndpointBaseUrl(eps) };
  }
  if (source === "har") {
    const eps = parseHar(content);
    return { endpoints: eps, base_url: firstEndpointBaseUrl(eps) };
  }
  if (source === "openapi") {
    const raw = content.trim();
    let text = raw;
    let sourceUrl: string | null = null;
    if (/^https?:\/\//i.test(raw)) {
      sourceUrl = raw;
      const fetched = await fetchOpenApiSpec(raw, headers, context);
      text = fetched.content;
    }
    const parsed = parseOpenApiWithMetadata(text, sourceUrl ?? undefined);
    return {
      endpoints: parsed.endpoints,
      base_url:
        parsed.servers[0] ??
        (sourceUrl ? urlBaseFromFullUrl(sourceUrl) : firstEndpointBaseUrl(parsed.endpoints)),
      auth_hint: parsed.auth_hint,
    };
  }
  if (source === "google_discovery") {
    const raw = content.trim();
    let text = raw;
    if (/^https?:\/\//i.test(raw)) {
      const fetched = await fetchGoogleDiscoverySpec(raw, headers, context);
      text = fetched.content;
    }
    const parsed = parseGoogleDiscoveryWithMetadata(text);
    return {
      endpoints: parsed.endpoints,
      base_url: parsed.base_url,
      auth_hint: parsed.auth_hint,
    };
  }
  if (source === "graphql") {
    const eps = parseGraphQL(content);
    return { endpoints: eps, base_url: "" };
  }
  const fetched = await fetchGraphQLIntrospection(content, headers, context);
  const eps = parseGraphQLIntrospection(fetched.content);
  return {
    endpoints: eps,
    base_url: urlBaseFromFullUrl(content),
  };
}

export const importConnectorFromSpecTool: ConversationTool = {
  name: "import_connector_from_spec",
  description:
    "Import an API specification (an API request collection, HAR, OpenAPI or Google Discovery inline/URL up to 50 MiB, GraphQL SDL, GraphQL introspection endpoint, or a curl command) into a connector draft. Specification metadata seeds the base URL and authentication. Auto-matches a built-in template when the base URL is recognised; otherwise produces a manual HTTP connector draft with sampled endpoints attached.",
  use_case:
    "Use when the operator brings an existing API spec, request collection, curl command, or a GraphQL endpoint URL. Faster than manually describing the connector.",
  inputSchema,
  category: "tenant_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    return {
      ok: true,
      data: await importConnectorDraftFromSpec({
        args,
        ...(ctx?.tenant_id ? { tenant_id: ctx.tenant_id, db: ctx.db } : {}),
      }),
    };
  },
};

type ImportConnectorDraftResult = ReusedConnectorEnvelope | Record<string, unknown>;

export async function importConnectorDraftFromSpec(
  p: { args: z.infer<typeof inputSchema> } & (
    | { tenant_id: string; db: ToolContext["db"] }
    | { tenant_id?: undefined; db?: undefined }
  ),
): Promise<ImportConnectorDraftResult> {
  const { args } = p;
  const parsed = await parseSource(args, p.tenant_id ? { tenant_id: p.tenant_id, exec: p.db } : {});
  const baseUrl = parsed.base_url;
  const reuseEnvelope =
    p.tenant_id && p.db
      ? await findReusableConnectorByUrl({
          tenant_id: p.tenant_id,
          environment: args.environment,
          base_url: baseUrl,
          driver: "http",
          ...(args.force_new ? { force_new: true } : {}),
          db: p.db,
        })
      : null;
  if (reuseEnvelope) return reuseEnvelope as ImportConnectorDraftResult;

  const match = baseUrl ? matchTemplateByUrl(baseUrl) : null;
  if (match) {
    const enriched = enrichConnectorFromTemplate(
      {
        name: args.name ?? match.template.name,
        environment: args.environment,
      },
      match.template,
      args.base_url_environment ? { environment: args.base_url_environment } : undefined,
    );
    enriched.config = {
      ...(enriched.config ?? {}),
      imported_sample_endpoints: parsed.endpoints.slice(0, 25),
      imported_source: args.source,
    };
    return {
      draft: enriched,
      template_match: {
        slug: match.template.slug,
        score: match.score,
        matched_segment: match.matched_segment,
      },
      recommended_next: ["update_connector_draft", "probe_connector_draft"],
    };
  }

  const authType = parsed.auth_hint?.type ?? "none";
  return {
    draft: {
      name: args.name ?? baseUrlDomain(baseUrl) ?? "Imported connector",
      slug: slugify(baseUrlDomain(baseUrl) ?? "imported"),
      driver: "http" as const,
      environment: args.environment,
      base_url: baseUrl || undefined,
      auth_type: authType,
      config: {
        imported_sample_endpoints: parsed.endpoints.slice(0, 25),
        imported_source: args.source,
      },
    },
    template_match: null,
    recommended_next: ["update_connector_draft", "probe_connector_draft"],
  };
}

export { importConnectorFromSpecInputSchema } from "./import-connector-from-spec-contract.ts";

function baseUrlDomain(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "imported"
  );
}
