// Extract HTTP surface.
//
// This module registers two sibling routes that both live under the
// "ai/extract" concept but serve different callers:
//
//   POST /v1/ai/extract
//     The LLM-driven inference surface. Takes a JSON body of the shape
//     `{sample, hint?}`, passes it through `runExtractFlow`, and returns
//     the inferred JSON Schema + canonical data. Unchanged from the
//     pre-P2 shape.
//
//   POST /v1/extract
//     The file-upload surface documented in docs/04-authoring.md. Accepts
//     a raw request body whose format is detected from the `content-type`
//     header. Formats: json, csv, yaml, xml, plaintext. Anything else
//     (pdf, docx, xlsx, …) is rejected with HTTP 415 + a typed
//     `unsupported_file_format` envelope listing the supported set. No
//     LLM is called.
//
// Both routes enforce the shared 100 MB body cap from
// docs/08-operations.md. The cap is checked twice so a hostile
// or buggy client cannot evade it:
//   1. `content-length` header — rejected before the body is read so we
//      never touch the socket for an obviously-oversized upload.
//   2. Streaming fallback — if the client omits `content-length`, we
//      aggregate the body chunk-by-chunk and bail the moment the
//      running total crosses the cap. Rejection writes a typed
//      `data.exported` audit row so operators see the attempt.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { audit } from "../../../audit/audit.ts";
import { AuditAction } from "../../../audit/types.ts";
import type { Db } from "../../../db/client.ts";
import {
  detectFormat,
  parseCsv,
  parseSimpleXml,
  parseSimpleYaml,
  UnsupportedFileUploadError,
} from "../../../docs-ingestion/sources/file-upload.ts";
import { runExtractFlow } from "../../../llm/flows/extract.ts";
import { PayloadTooLargeError, UnsupportedMediaTypeError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

/** 100 MB — see docs/08-operations.md § File and payload sizes. */
export const EXTRACT_BODY_CAP_BYTES = 100 * 1024 * 1024;

/** Formats the file-upload extractor knows how to parse. */
export const SUPPORTED_FILE_FORMATS = ["json", "csv", "yaml", "xml", "plaintext"] as const;
export type SupportedFileFormat = (typeof SUPPORTED_FILE_FORMATS)[number];

const ExtractBody = z
  .object({
    sample: z.string().min(1),
    hint: z.string().optional(),
  })
  .openapi("AiExtractBody");

const ExtractResponse = z
  .object({
    schema: z.unknown(),
    data: z.unknown(),
    tokens: z.record(z.string(), z.number()),
    model_used: z.string(),
    fell_back: z.boolean(),
  })
  .openapi("AiExtractResponse");

const route = createRoute({
  method: "post",
  path: "/v1/ai/extract",
  tags: ["ai"],
  summary: "Extract structured fields from an unstructured sample",
  security: [{ bearerAuth: [] }],
  request: { body: { content: { "application/json": { schema: ExtractBody } } } },
  responses: {
    200: { description: "OK", content: { "application/json": { schema: ExtractResponse } } },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    413: {
      description: "Payload too large",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

function auditDeniedTooLarge(
  tenantId: string | null,
  actorId: string | null,
  details: Record<string, unknown>,
  db?: Db,
): void {
  // `tenant_id` can legitimately be null when the body cap trips
  // *before* we have a validated principal — fall back to the system
  // tenant marker so the audit row still lands. When a per-request
  // executor is handed in we bind the audit write to it so tests with
  // per-db isolation observe the row.
  audit(
    {
      tenant_id: tenantId ?? "00000000-0000-0000-0000-000000000000",
      actor_type: actorId ? "user" : "system",
      actor_id: actorId,
      action: AuditAction.DATA_EXPORTED,
      resource_type: "extract",
      resource_id: null,
      result: "denied",
      reason: "extract_too_large",
      metadata: { cap_bytes: EXTRACT_BODY_CAP_BYTES, ...details },
    },
    db,
  );
}

/**
 * Body-cap middleware shared by both extract routes. Declared as a
 * standalone factory so `/v1/ai/extract` and `/v1/extract` can install
 * the same cap without duplicating the stream-aggregation logic.
 */
function extractBodyCap() {
  return async (c: Context<AppEnv>, next: Next) => {
    if (c.req.method !== "POST") return next();

    const principal = c.get("principal");
    const tenantId = principal?.tenant_id ?? null;
    const actorId = principal?.kind === "user" ? principal.id : null;
    const middlewareDb = c.get("db");

    // 1. Reject on the declared content-length before we read the body.
    const lenHeader = c.req.header("content-length");
    let declaredLength: number | null = null;
    if (lenHeader) {
      const declared = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(declared)) {
        declaredLength = declared;
        if (declared > EXTRACT_BODY_CAP_BYTES) {
          auditDeniedTooLarge(
            tenantId,
            actorId,
            {
              source: "content_length",
              declared_bytes: declared,
            },
            middlewareDb,
          );
          throw new PayloadTooLargeError("extract body exceeds 100 MB cap", {
            cap_bytes: EXTRACT_BODY_CAP_BYTES,
            declared_bytes: declared,
          });
        }
      }
    }

    // 2. If content-length is missing (or the header couldn't be
    //    parsed), stream the body and bail as soon as the running
    //    total crosses the cap. When a valid, in-range content-length
    //    was provided we trust it and skip the copy so the happy path
    //    stays a zero-overhead passthrough.
    const rawBody = c.req.raw.body;
    if (declaredLength === null && rawBody) {
      const reader = rawBody.getReader();
      const parts: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > EXTRACT_BODY_CAP_BYTES) {
            auditDeniedTooLarge(
              tenantId,
              actorId,
              {
                source: "stream",
                observed_bytes: total,
              },
              middlewareDb,
            );
            throw new PayloadTooLargeError("extract body exceeds 100 MB cap", {
              cap_bytes: EXTRACT_BODY_CAP_BYTES,
              observed_bytes: total,
            });
          }
          parts.push(value);
        }
      } finally {
        try {
          reader.releaseLock();
        } catch {
          // ignore — reader may already be released
        }
      }
      // Re-hydrate the request body so downstream handlers can parse it.
      const buf = Buffer.concat(
        parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)),
      );
      const reconstructed = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: buf,
      });
      c.req.raw = reconstructed;
      // Clear any cached parsed body on the Hono request wrapper so the
      // openapi validator / text() accessor re-reads the reconstructed
      // request.
      const cache = (c.req as unknown as { bodyCache?: Record<string, unknown> }).bodyCache;
      if (cache) {
        for (const k of Object.keys(cache)) delete cache[k];
      }
    }

    return next();
  };
}

export function registerAiExtractRoute(app: OpenAPIHono<AppEnv>): void {
  // RBAC: extract endpoints are read-only — they surface data that
  // already lives in the tenant's workflow context.
  app.use("/v1/ai/extract", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return requirePermission("workflow:read")(c, next);
  });
  app.use("/v1/extract", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return requirePermission("workflow:read")(c, next);
  });

  // Middleware runs before the zod `openapi` handler, so we can reject
  // with a typed HttpError while the body is still on the wire.
  app.use("/v1/ai/extract", extractBodyCap());
  app.use("/v1/extract", extractBodyCap());

  app.openapi(route, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");
    const result = await runExtractFlow(
      {
        tenant_id: principal.tenant_id,
        sample: body.sample,
        ...(body.hint ? { hint: body.hint } : {}),
      },
      db,
    );
    return c.json(
      {
        schema: result.schema,
        data: result.data,
        tokens: {
          system: result.tokens.system,
          skills: result.tokens.skills,
          docs: result.tokens.docs,
          failures: result.tokens.failures,
          messages: result.tokens.messages,
          total: result.tokens.total,
        },
        model_used: result.model_used,
        fell_back: result.fell_back,
      },
      200,
    );
  });

  // -----------------------------------------------------------------
  // POST /v1/extract — file-upload extraction surface.
  //
  // Not declared via `app.openapi(...)` because the request body is
  // intentionally polymorphic (text/json/yaml/xml/csv) and the openapi
  // validator would second-guess the content-type routing.
  // -----------------------------------------------------------------
  app.post("/v1/extract", async (c) => {
    requireAuth(c);
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    const filenameHeader = c.req.header("x-filename") ?? undefined;

    const raw = await c.req.raw.arrayBuffer();
    const bytes = raw.byteLength;
    const buffer = Buffer.from(raw);

    // `text/plain` gets short-circuited because the docs ingester's
    // detector rightly refuses it (plain text is not a doc format) but
    // the extract endpoint treats it as a first-class format.
    const isPlainText =
      contentType.startsWith("text/plain") || filenameHeader?.toLowerCase().endsWith(".txt");
    if (isPlainText) {
      return c.json(
        {
          format: "plaintext" as SupportedFileFormat,
          bytes,
          data: buffer.toString("utf8"),
        },
        200,
      );
    }

    // Resolve format through the same detector the docs ingester uses,
    // so unsupported types surface as `UnsupportedFileUploadError` and
    // we can map them to 415 uniformly.
    let format: SupportedFileFormat;
    try {
      const detectInput: Parameters<typeof detectFormat>[0] = { buffer };
      const mimeHead = contentType.split(";")[0]?.trim();
      if (mimeHead) detectInput.mime = mimeHead;
      if (filenameHeader) detectInput.filename = filenameHeader;
      const detected = detectFormat(detectInput);
      format = detected as SupportedFileFormat;
    } catch (err) {
      if (err instanceof UnsupportedFileUploadError) {
        throw new UnsupportedMediaTypeError("unsupported_file_format", {
          supported: [...SUPPORTED_FILE_FORMATS],
          detail: err.message,
        });
      }
      throw err;
    }

    // Dispatch to the matching parser. We don't route through
    // `ingestFileUpload` because it emits RawChunks suitable for the
    // doc retrieval store; this endpoint wants the parsed data tree.
    const text = buffer.toString("utf8");
    let data: unknown;
    try {
      switch (format) {
        case "json":
          data = JSON.parse(text);
          break;
        case "yaml":
          data = parseSimpleYaml(text);
          break;
        case "csv": {
          const parsed = parseCsv(text);
          data = parsed.rows.map((row) => {
            const obj: Record<string, string> = {};
            for (let i = 0; i < parsed.headers.length; i += 1) {
              obj[parsed.headers[i] ?? String(i)] = row[i] ?? "";
            }
            return obj;
          });
          break;
        }
        case "xml":
          data = parseSimpleXml(text);
          break;
        case "plaintext":
          data = text;
          break;
      }
    } catch (err) {
      return c.json(
        {
          code: "bad_request",
          message: `extract: failed to parse ${format} body`,
          trace_id: c.get("trace_id"),
          details: { error: err instanceof Error ? err.message : String(err) },
        },
        400,
      );
    }

    return c.json({ format, bytes, data }, 200);
  });
}
