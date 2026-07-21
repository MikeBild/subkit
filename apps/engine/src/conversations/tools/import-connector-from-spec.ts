// import_connector_from_spec — parse an API request collection, HAR
// recording, OpenAPI document, GraphQL SDL, GraphQL introspection JSON,
// or curl command into a connector draft. If the detected base URL matches a
// built-in template via `matchTemplateByUrl`, we enrich from that
// template; otherwise we fall back to a manual HTTP connector draft.

import { z } from "@hono/zod-openapi";
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
import { findReusableConnectorByUrl } from "./connector-reuse.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

const SourceEnum = z.enum([
  "postman",
  "har",
  "openapi",
  "google_discovery",
  "graphql",
  "graphql_introspection",
  "curl",
]);

const inputSchema = z
  .object({
    source: SourceEnum,
    /**
     * Raw body, URL, or a curl command depending on `source`. For
     * `openapi` and `google_discovery` this may be either inline content
     * or an https:// URL — a URL triggers a live fetch (spec-fetchers,
     * SSRF-guarded). For
     * `graphql_introspection`, this is the endpoint URL.
     */
    content: z.string().min(1),
    /** Optional request headers used for URL-fetch variants. */
    headers: z.record(z.string(), z.string()).optional(),
    name: z.string().min(1).optional(),
    environment: z.enum(["dev", "prod"]).default("dev"),
    base_url_environment: z.string().optional(),
  })
  .openapi("ImportConnectorFromSpecToolInput");

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

async function parseSource(args: z.infer<typeof inputSchema>): Promise<Parsed> {
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
      const fetched = await fetchOpenApiSpec(raw, headers);
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
      const fetched = await fetchGoogleDiscoverySpec(raw, headers);
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
  // graphql_introspection — `content` is the endpoint URL.
  const fetched = await fetchGraphQLIntrospection(content, headers);
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
  example_input: {
    source: "curl",
    content: "curl -H 'Authorization: Bearer sk_test_xxx' https://api.stripe.com/v1/customers",
  },
  inputSchema,
  category: "tenant_write",
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const parsed = await parseSource(args);
    const baseUrl = parsed.base_url;
    // Reuse-existing-saved-connector: same dedup as
    // start_connector_from_description so two imports against the same
    // upstream URL never produce two saved connectors. Stateless
    // callers (smoke tests that exercise the parser only) may pass a
    // null context — skip the dedup in that case so the tool stays
    // testable without a DB stub.
    const reuseEnvelope =
      ctx?.tenant_id && ctx.db
        ? await findReusableConnectorByUrl({
            tenant_id: ctx.tenant_id,
            environment: args.environment,
            base_url: baseUrl,
            driver: "http",
            db: ctx.db,
          })
        : null;
    if (reuseEnvelope) {
      return { ok: true, data: reuseEnvelope };
    }
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
      // Attach the sample endpoints to config so the LLM can reuse them
      // during workflow authoring without re-parsing.
      enriched.config = {
        ...(enriched.config ?? {}),
        imported_sample_endpoints: parsed.endpoints.slice(0, 25),
        imported_source: args.source,
      };
      return {
        ok: true,
        data: {
          draft: enriched,
          template_match: {
            slug: match.template.slug,
            score: match.score,
            matched_segment: match.matched_segment,
          },
          recommended_next: ["update_connector_draft", "probe_connector_draft"],
        },
      };
    }

    // Manual fallback — no template matched.
    const authType = parsed.auth_hint?.type ?? "none";
    return {
      ok: true,
      data: {
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
      },
    };
  },
};

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
