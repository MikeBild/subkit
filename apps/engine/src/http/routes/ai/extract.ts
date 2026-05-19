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
//     header. Formats: json, csv, yaml, xml, plaintext, pdf, docx,
//     xlsx/xls, pptx. Binary formats are handled by the docs-ingestion
//     parser registry (`docs-ingestion/parsers/`); anything still
//     unknown is rejected with HTTP 415 + a typed
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
import { AuditAction, audit, auditAwait, readRequestSource } from "../../../audit/index.ts";
import type { Db } from "../../../db/client.ts";
import {
  BinaryParseError,
  detectFormat,
  parseBinaryFile,
  parseCsv,
  parseSimpleXml,
  parseSimpleYaml,
  UnsupportedFileUploadError,
} from "../../../docs-ingestion/index.ts";
import { runExtractFlow } from "../../../llm/index.ts";
import { BadRequestError, PayloadTooLargeError, UnsupportedMediaTypeError } from "../../errors.ts";
import { requireAuth } from "../../middleware/auth.ts";
import { requirePermission } from "../../middleware/require-permission.ts";
import type { AppEnv } from "../../openapi.ts";

/** 100 MB — see docs/08-operations.md § File and payload sizes. */
export const EXTRACT_BODY_CAP_BYTES = 100 * 1024 * 1024;

/** Formats the file-upload extractor knows how to parse. */
export const SUPPORTED_FILE_FORMATS = [
  "json",
  "csv",
  "yaml",
  "xml",
  "plaintext",
  "pdf",
  "docx",
  "xlsx",
  "xls",
  "pptx",
] as const;
export type SupportedFileFormat = (typeof SUPPORTED_FILE_FORMATS)[number];

/** Set of binary formats that participate in the data-export audit
 *  trail. Text formats (json/csv/yaml/xml/plaintext) skip the audit
 *  to keep the row volume reasonable — they're shape-only and don't
 *  carry the same governance weight as PDFs / Office docs. */
const AUDITED_BINARY_FORMATS: ReadonlySet<SupportedFileFormat> = new Set([
  "pdf",
  "docx",
  "xlsx",
  "xls",
  "pptx",
]);

/** Max length stored in `audit_log.metadata.error` per parser failure.
 *  Parser library messages can echo small chunks of the input on the
 *  malformed-XML path; bounding the length plus stripping control
 *  characters keeps SIEM consumers safe even if a future library
 *  regression starts copying more user-controlled bytes verbatim. */
const AUDIT_ERROR_MAX_LEN = 200;

function sanitizeAuditError(detail: string): string {
  // Strip ASCII control chars (NUL / TAB / CR / LF / DEL). Iterate by
  // char code instead of a literal-control-char regex so biome's
  // `noControlCharactersInRegex` rule stays happy.
  let out = "";
  for (const ch of detail) {
    const code = ch.charCodeAt(0);
    out += code < 32 || code === 127 ? " " : ch;
  }
  return out.length > AUDIT_ERROR_MAX_LEN ? `${out.slice(0, AUDIT_ERROR_MAX_LEN)}…` : out;
}

/** Validation for the `x-filename` request header used by `POST /v1/extract`.
 *  The header is operator-supplied (the `sk` CLI sends it, custom clients
 *  may too), so we treat it as untrusted input: bounded length, no path
 *  separators, no control chars. The parsed value is logged inside the
 *  parser failure audit row, so an unbounded or shell-meta value would
 *  reach SIEM consumers. Zod-at-the-boundary keeps that surface clean. */
const FILENAME_HEADER_SCHEMA = z
  .string()
  .max(255)
  .refine((s) => !s.includes("/") && !s.includes("\\") && !s.includes("\0"), {
    message: "filename header must not contain path separators or NULs",
  });

/** Discriminated union for the `POST /v1/extract` response body. The
 *  route is hand-registered via `app.post(...)` (not `app.openapi(...)`)
 *  because the *request* is polymorphic (content-type dispatch), but
 *  the *response* is well-typed per format. We parse the body through
 *  this schema before `c.json()` so future contributors can't introduce
 *  a silent shape regression. */
const ExtractFileResponse = z.discriminatedUnion("format", [
  z.object({ format: z.literal("json"), bytes: z.number(), data: z.unknown() }),
  z.object({ format: z.literal("yaml"), bytes: z.number(), data: z.unknown() }),
  z.object({
    format: z.literal("csv"),
    bytes: z.number(),
    data: z.array(z.record(z.string(), z.string())),
  }),
  z.object({ format: z.literal("xml"), bytes: z.number(), data: z.unknown() }),
  z.object({ format: z.literal("plaintext"), bytes: z.number(), data: z.string() }),
  z.object({
    format: z.literal("pdf"),
    bytes: z.number(),
    pages: z.number(),
    data: z.object({ text: z.string() }),
  }),
  z.object({
    format: z.literal("docx"),
    bytes: z.number(),
    data: z.object({ markdown: z.string() }),
  }),
  z.object({
    format: z.literal("xlsx"),
    bytes: z.number(),
    data: z.object({ sheets: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))) }),
  }),
  z.object({
    format: z.literal("xls"),
    bytes: z.number(),
    data: z.object({ sheets: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))) }),
  }),
  z.object({
    format: z.literal("pptx"),
    bytes: z.number(),
    data: z.object({
      slides: z.array(z.object({ index: z.number(), text: z.string() })),
    }),
  }),
]);

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
    const principal = requireAuth(c);
    const db = c.get("db");
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    const rawFilenameHeader = c.req.header("x-filename");
    let filenameHeader: string | undefined;
    if (rawFilenameHeader !== undefined) {
      const parsed = FILENAME_HEADER_SCHEMA.safeParse(rawFilenameHeader);
      if (!parsed.success) {
        // Convention across `apps/engine/src/http/routes/`: BadRequestError
        // takes a human-readable message first; machine-readable codes
        // live in `details`. Keeps the OpenAPI error envelope uniform.
        throw new BadRequestError(
          parsed.error.issues[0]?.message ?? "x-filename header is invalid",
          { code: "invalid_x_filename_header" },
        );
      }
      filenameHeader = parsed.data;
    }

    const raw = await c.req.raw.arrayBuffer();
    const bytes = raw.byteLength;
    const buffer = Buffer.from(raw);

    // `text/plain` gets short-circuited because the docs ingester's
    // detector rightly refuses it (plain text is not a doc format) but
    // the extract endpoint treats it as a first-class format.
    const isPlainText =
      contentType.startsWith("text/plain") || filenameHeader?.toLowerCase().endsWith(".txt");
    if (isPlainText) {
      const payload = ExtractFileResponse.parse({
        format: "plaintext",
        bytes,
        data: buffer.toString("utf8"),
      });
      return c.json(payload, 200);
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
    let data: unknown;
    let pages: number | undefined;
    try {
      switch (format) {
        case "json":
          data = JSON.parse(buffer.toString("utf8"));
          break;
        case "yaml":
          data = parseSimpleYaml(buffer.toString("utf8"));
          break;
        case "csv": {
          const parsed = parseCsv(buffer.toString("utf8"));
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
          data = parseSimpleXml(buffer.toString("utf8"));
          break;
        case "plaintext":
          data = buffer.toString("utf8");
          break;
        case "pdf": {
          const parsed = await parseBinaryFile(buffer, "pdf");
          if (parsed.format !== "pdf") throw new Error("parser returned wrong format");
          data = { text: parsed.text };
          pages = parsed.pages;
          break;
        }
        case "docx": {
          const parsed = await parseBinaryFile(buffer, "docx");
          if (parsed.format !== "docx") throw new Error("parser returned wrong format");
          data = { markdown: parsed.markdown };
          break;
        }
        case "xlsx":
        case "xls": {
          const parsed = await parseBinaryFile(buffer, format);
          if (parsed.format !== "xlsx" && parsed.format !== "xls") {
            throw new Error("parser returned wrong format");
          }
          data = { sheets: parsed.sheets };
          break;
        }
        case "pptx": {
          const parsed = await parseBinaryFile(buffer, "pptx");
          if (parsed.format !== "pptx") throw new Error("parser returned wrong format");
          data = { slides: parsed.slides };
          break;
        }
      }
    } catch (err) {
      const detail =
        err instanceof BinaryParseError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      // Audit binary parse failures as well as successes. Without
      // this, a pathological-upload campaign would only show up in
      // metrics (`subkit_docs_binary_parse_total{result="error"}`)
      // and never in `audit_log`, making forensic queries blind.
      // Text formats skip the audit row to keep volume reasonable.
      // `auditAwait` so the row persists before the 400 returns —
      // `data.exported` is a governance event and operators expect
      // it visible by the time the client sees the response.
      if (AUDITED_BINARY_FORMATS.has(format)) {
        await auditAwait(
          {
            tenant_id: principal.tenant_id,
            actor_type: principal.kind,
            actor_id: principal.kind === "user" ? principal.id : null,
            action: AuditAction.DATA_EXPORTED,
            resource_type: "extract",
            resource_id: null,
            result: "error",
            reason: "parse_failed",
            metadata: {
              format,
              bytes,
              error: sanitizeAuditError(detail),
              request_source: readRequestSource(c),
              ...(filenameHeader ? { filename: filenameHeader } : {}),
            },
          },
          db,
        );
      }
      return c.json(
        {
          code: "bad_request",
          message: `extract: failed to parse ${format} body`,
          trace_id: c.get("trace_id"),
          details: { error: detail },
        },
        400,
      );
    }

    // Audit successful binary parses BEFORE the response Zod parse so
    // a future schema-shape regression can't silently drop the
    // governance row. Text formats are omitted (shape-only, no
    // tenant-content egress). `auditAwait` keeps `data.exported`
    // durable before the 200 acks.
    if (AUDITED_BINARY_FORMATS.has(format)) {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.kind === "user" ? principal.id : null,
          action: AuditAction.DATA_EXPORTED,
          resource_type: "extract",
          resource_id: null,
          result: "success",
          metadata: {
            format,
            bytes,
            request_source: readRequestSource(c),
            ...(pages !== undefined ? { pages } : {}),
            ...(filenameHeader ? { filename: filenameHeader } : {}),
          },
        },
        db,
      );
    }
    const payload = ExtractFileResponse.parse(
      pages !== undefined ? { format, bytes, pages, data } : { format, bytes, data },
    );
    return c.json(payload, 200);
  });
}
