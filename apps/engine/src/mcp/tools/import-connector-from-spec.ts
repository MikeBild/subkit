// MCP `import_connector_from_spec` product tool.
//
// Stateless: parses an API spec (curl command, OpenAPI inline/URL,
// GraphQL SDL, GraphQL introspection endpoint, Postman, HAR) and returns
// a connector draft enriched from the best matching built-in template,
// or a manual HTTP fallback when no template matches.
//
// Delegates to the same parsers used by the conversation tool
// (conversations/tools/import-connector-from-spec.ts) so behaviour is
// consistent. Available in all MCP modes.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { fetchGraphQLIntrospection, fetchOpenApiSpec } from "../../connectors/spec-fetchers.ts";
import { enrichConnectorFromTemplate } from "../../connectors/template-enrichment.ts";
import { matchTemplateByUrl } from "../../connectors/template-url-match.ts";
import type { EndpointSpec } from "../../llm/flows/document-analysis.ts";
import { parseCurlCommand } from "../../llm/flows/document-parsers/curl.ts";
import { parseGraphQL } from "../../llm/flows/document-parsers/graphql.ts";
import { parseGraphQLIntrospection } from "../../llm/flows/document-parsers/graphql-introspection.ts";
import { parseHar } from "../../llm/flows/document-parsers/har.ts";
import { parseOpenApi } from "../../llm/flows/document-parsers/openapi.ts";
import { parsePostman } from "../../llm/flows/document-parsers/postman.ts";

export const IMPORT_CONNECTOR_FROM_SPEC_TOOL_NAME = "import_connector_from_spec";

export const importConnectorFromSpecMcpTool: Tool = {
  name: IMPORT_CONNECTOR_FROM_SPEC_TOOL_NAME,
  description:
    "Import an API specification (curl command, OpenAPI inline or URL, GraphQL SDL, GraphQL introspection endpoint URL, Postman collection, or HAR recording) and return a connector draft. Auto-matches a built-in template when the base URL is recognised.",
  inputSchema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        enum: ["postman", "har", "openapi", "graphql", "graphql_introspection", "curl"],
        description: "Format of the content field.",
      },
      content: {
        type: "string",
        description:
          "Raw body, URL, or curl command. For openapi this may be inline YAML/JSON or an https:// URL. For graphql_introspection this is the endpoint URL.",
      },
      headers: {
        type: "object",
        description: "Optional request headers used when fetching a remote URL.",
        additionalProperties: { type: "string" },
      },
      name: {
        type: "string",
        description: "Optional connector name override.",
      },
      environment: {
        type: "string",
        enum: ["dev", "prod"],
        default: "dev",
        description: "Target environment for the draft.",
      },
      base_url_environment: {
        type: "string",
        description: "Selects base_url_options entry by environment label (e.g. 'eu', 'sandbox').",
      },
    },
    required: ["source", "content"],
    additionalProperties: false,
  },
};

export interface ImportConnectorFromSpecArgs {
  source: "postman" | "har" | "openapi" | "graphql" | "graphql_introspection" | "curl";
  content: string;
  headers?: Record<string, string>;
  name?: string;
  environment?: "dev" | "prod";
  base_url_environment?: string;
}

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

async function parseSource(args: ImportConnectorFromSpecArgs): Promise<{
  endpoints: EndpointSpec[];
  base_url: string;
  auth_hint?: { type: string; header_name?: string } | null;
}> {
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
    const eps = parseOpenApi(text);
    return {
      endpoints: eps,
      base_url: sourceUrl ? urlBaseFromFullUrl(sourceUrl) : firstEndpointBaseUrl(eps),
    };
  }
  if (source === "graphql") {
    const eps = parseGraphQL(content);
    return { endpoints: eps, base_url: "" };
  }
  // graphql_introspection — content is the endpoint URL.
  const fetched = await fetchGraphQLIntrospection(content, headers);
  const eps = parseGraphQLIntrospection(fetched.content);
  return { endpoints: eps, base_url: urlBaseFromFullUrl(content) };
}

export async function handleImportConnectorFromSpec(
  args: ImportConnectorFromSpecArgs,
): Promise<{ ok: true; data: unknown } | { ok: false; data: { error: string } }> {
  let parsed: Awaited<ReturnType<typeof parseSource>>;
  try {
    parsed = await parseSource(args);
  } catch (err) {
    return { ok: false, data: { error: err instanceof Error ? err.message : String(err) } };
  }

  const baseUrl = parsed.base_url;
  const match = baseUrl ? matchTemplateByUrl(baseUrl) : null;
  const env = args.environment ?? "dev";

  if (match) {
    const enriched = enrichConnectorFromTemplate(
      { name: args.name ?? match.template.name, environment: env },
      match.template,
      args.base_url_environment ? { environment: args.base_url_environment } : undefined,
    );
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

  const authHint = parsed.auth_hint;
  const authType =
    authHint?.type === "bearer"
      ? "bearer"
      : authHint?.type === "basic"
        ? "basic"
        : authHint?.type === "header"
          ? "header"
          : "none";

  return {
    ok: true,
    data: {
      draft: {
        name: args.name ?? baseUrlDomain(baseUrl) ?? "Imported connector",
        slug: slugify(baseUrlDomain(baseUrl) ?? "imported"),
        driver: "http" as const,
        environment: env,
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
}
