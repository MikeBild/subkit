import { sql } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import { type Db, getDb } from "../../db/client.ts";
import { connectorEndpointSchemas } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import type { ProviderKind } from "../runtime/model-init.ts";
import { parseGraphQL } from "./document-parsers/graphql.ts";
import { parseHar } from "./document-parsers/har.ts";
import { parseOpenApi } from "./document-parsers/openapi.ts";
import { parsePostman } from "./document-parsers/postman.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type DocumentFormat =
  | "openapi"
  | "graphql"
  | "postman"
  | "har"
  | "pdf"
  | "markdown"
  | "image"
  | "unknown";

export interface EndpointSpec {
  path: string;
  method: HttpMethod;
  description?: string;
  request_schema?: Record<string, unknown>;
  query_schema?: Record<string, unknown>;
  response_schema?: Record<string, unknown>;
  expected_statuses: number[];
  idempotent: boolean;
  example_request?: unknown;
  example_response?: unknown;
}

export interface AuthSpec {
  type: "none" | "header" | "query" | "bearer" | "basic" | "oauth2";
  header_name?: string;
  query_param?: string;
}

export interface DocumentAnalysisResult {
  endpoints: EndpointSpec[];
  auth: AuthSpec;
  schemas: Record<string, Record<string, unknown>>;
  confidence: number;
  source_format: DocumentFormat;
  errors: string[];
}

export interface DocumentAnalysisAttachment {
  storage_uri: string;
  mime_type: string;
  filename: string;
  content?: string;
  data?: Uint8Array;
}

interface DocumentAnalysisParams {
  tenant_id: string;
  attachments: DocumentAnalysisAttachment[];
  goal?: string;
  connector_ids?: string[];
  connector_id?: string;
  db?: Db;
  provider?: ProviderKind;
}

function detectDocumentFormat(
  filename: string,
  mimeType: string,
  contentSnippet?: string,
): DocumentFormat {
  const lower = filename.toLowerCase();
  const mime = mimeType.toLowerCase();

  if (lower.endsWith(".har") || (mime === "application/json" && lower.includes(".har")))
    return "har";
  if (mime === "application/pdf" || lower.endsWith(".pdf")) return "pdf";
  if (mime.startsWith("image/")) return "image";
  if (lower.endsWith(".graphql") || lower.endsWith(".gql") || lower.endsWith(".sdl"))
    return "graphql";
  if (lower.endsWith(".md") || lower.endsWith(".markdown") || mime === "text/markdown")
    return "markdown";

  if (
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml") ||
    lower.endsWith(".json") ||
    mime.includes("json") ||
    mime.includes("yaml")
  ) {
    if (contentSnippet) {
      if (contentSnippet.includes("openapi") || contentSnippet.includes("swagger"))
        return "openapi";
      if (contentSnippet.includes('"log"') && contentSnippet.includes('"entries"')) return "har";
      if (
        contentSnippet.includes('"info"') &&
        contentSnippet.includes('"schema"') &&
        contentSnippet.includes("postman")
      )
        return "postman";
      if (
        contentSnippet.includes("__schema") ||
        contentSnippet.includes("type Query") ||
        contentSnippet.includes("type Mutation")
      )
        return "graphql";
    }
    if (lower.includes("postman")) return "postman";
    return "openapi";
  }

  return "unknown";
}

function mergeEndpoints(all: EndpointSpec[][]): EndpointSpec[] {
  const seen = new Map<string, EndpointSpec>();
  for (const specs of all) {
    for (const spec of specs) {
      const key = `${spec.method}:${spec.path}`;
      if (!seen.has(key)) seen.set(key, spec);
    }
  }
  return Array.from(seen.values());
}

export async function runDocumentAnalysisFlow(
  p: DocumentAnalysisParams,
): Promise<DocumentAnalysisResult> {
  const allEndpoints: EndpointSpec[][] = [];
  const errors: string[] = [];
  let confidence = 100;
  let source_format: DocumentFormat = "unknown";

  for (const attachment of p.attachments) {
    const content = attachment.content ?? "";
    const fmt = detectDocumentFormat(
      attachment.filename,
      attachment.mime_type,
      content.slice(0, 500),
    );
    if (source_format === "unknown") source_format = fmt;

    try {
      switch (fmt) {
        case "openapi": {
          const specs = parseOpenApi(content);
          allEndpoints.push(specs);
          confidence = 95;
          break;
        }
        case "graphql": {
          const specs = parseGraphQL(content);
          allEndpoints.push(specs);
          confidence = 95;
          break;
        }
        case "postman": {
          const specs = parsePostman(content);
          allEndpoints.push(specs);
          confidence = 90;
          break;
        }
        case "har": {
          const specs = parseHar(content);
          allEndpoints.push(specs);
          confidence = 98;
          break;
        }
        default: {
          confidence = Math.min(confidence, 60);
          errors.push(
            `Document '${attachment.filename}' (${fmt}) requires LLM vision extraction — not yet implemented in this path.`,
          );
          break;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to parse '${attachment.filename}': ${msg}`);
      confidence = Math.min(confidence, 50);
    }
  }

  const merged = mergeEndpoints(allEndpoints);

  const auth: AuthSpec = { type: "none" };

  const result: DocumentAnalysisResult = {
    endpoints: merged,
    auth,
    schemas: {},
    confidence,
    source_format,
    errors,
  };

  const auditDb = p.db ?? getDb();
  await auditAwait(
    {
      tenant_id: p.tenant_id,
      actor_type: "system",
      actor_id: null,
      action: AuditAction.DOCUMENT_ANALYZED,
      resource_type: "connector",
      resource_id: p.connector_id ?? null,
      result: errors.length > 0 && merged.length === 0 ? "error" : "success",
      metadata: {
        source_format,
        confidence,
        endpoint_count: merged.length,
        attachment_count: p.attachments.length,
        ...(errors.length > 0 ? { errors: errors.slice(0, 5) } : {}),
      },
    },
    auditDb,
  ).catch((err) => {
    logger.warn({
      module: "document-analysis",
      action: "audit.emit_error",
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const connectorId = p.connector_id;
  if (connectorId && merged.length > 0) {
    const db = p.db ?? getDb();
    await db
      .insert(connectorEndpointSchemas)
      .values(
        merged.map((ep) => ({
          tenant_id: p.tenant_id,
          connector_id: connectorId,
          path: ep.path,
          method: ep.method,
          ...(ep.request_schema !== undefined
            ? { request_schema: ep.request_schema as Record<string, unknown> }
            : {}),
          ...(ep.query_schema !== undefined
            ? { query_schema: ep.query_schema as Record<string, unknown> }
            : {}),
          ...(ep.response_schema !== undefined
            ? { response_schema: ep.response_schema as Record<string, unknown> }
            : {}),
          expected_statuses: ep.expected_statuses,
          idempotent: ep.idempotent,
          ...(ep.description !== undefined ? { description: ep.description } : {}),
          source: result.source_format,
          confidence: result.confidence,
        })),
      )
      .onConflictDoUpdate({
        target: [
          connectorEndpointSchemas.connector_id,
          connectorEndpointSchemas.method,
          connectorEndpointSchemas.path,
        ],
        set: {
          request_schema: sql`excluded.request_schema`,
          response_schema: sql`excluded.response_schema`,
          expected_statuses: sql`excluded.expected_statuses`,
          confidence: sql`excluded.confidence`,
          extracted_at: sql`now()`,
        },
      })
      .catch((err) => {
        logger.warn({
          module: "document-analysis",
          action: "endpoint_registry.persist_error",
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  return result;
}
