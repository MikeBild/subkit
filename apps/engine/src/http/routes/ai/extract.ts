import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, Next } from "hono";
import { ErrorSchema } from "../../../api/common-schemas.ts";
import { ExtractFileResponseSchema } from "../../../api/extract-schemas.ts";
import {
  type Actor,
  AuditAction,
  audit,
  auditActor,
  auditAwait,
  readRequestSource,
  sanitizeForAudit,
} from "../../../audit/index.ts";
import type { Db } from "../../../db/client.ts";
import {
  BINARY_FORMATS,
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

export const EXTRACT_BODY_CAP_BYTES = 100 * 1024 * 1024;

const SUPPORTED_FILE_FORMATS = [
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
type SupportedFileFormat = (typeof SUPPORTED_FILE_FORMATS)[number];

const AUDITED_BINARY_FORMATS: ReadonlySet<string> = BINARY_FORMATS;

const FILENAME_HEADER_SCHEMA = z
  .string()
  .max(255)
  .refine((s) => !s.includes("/") && !s.includes("\\") && !s.includes("\0"), {
    message: "filename header must not contain path separators or NULs",
  });

// Clients percent-encode non-ASCII names (header values must be ASCII).
const decodeFilenameHeader = (value: string): string => {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const ExtractFileResponse = ExtractFileResponseSchema;

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
  actor: Actor | null,
  details: Record<string, unknown>,
  db?: Db,
): void {
  audit(
    {
      tenant_id: tenantId ?? "00000000-0000-0000-0000-000000000000",
      ...auditActor(actor),
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

function extractBodyCap() {
  return async (c: Context<AppEnv>, next: Next) => {
    if (c.req.method !== "POST") return next();

    const principal = c.get("principal");
    const tenantId = principal?.tenant_id ?? null;
    const actor = principal ? { kind: principal.kind, id: principal.id } : null;
    const middlewareDb = c.get("db");

    const lenHeader = c.req.header("content-length");
    let declaredLength: number | null = null;
    if (lenHeader) {
      const declared = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(declared)) {
        declaredLength = declared;
        if (declared > EXTRACT_BODY_CAP_BYTES) {
          auditDeniedTooLarge(
            tenantId,
            actor,
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
              actor,
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
        } catch {}
      }
      const buf = Buffer.concat(
        parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)),
      );
      const reconstructed = new Request(c.req.raw.url, {
        method: c.req.raw.method,
        headers: c.req.raw.headers,
        body: buf,
      });
      c.req.raw = reconstructed;
      const cache = (c.req as unknown as { bodyCache?: Record<string, unknown> }).bodyCache;
      if (cache) {
        for (const k of Object.keys(cache)) delete cache[k];
      }
    }

    return next();
  };
}

export function registerAiExtractRoute(app: OpenAPIHono<AppEnv>): void {
  app.openAPIRegistry.register("ExtractFileResponse", ExtractFileResponseSchema);

  app.use("/v1/ai/extract", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return requirePermission("workflow:read")(c, next);
  });
  app.use("/v1/extract", async (c, next) => {
    if (c.req.method !== "POST") return next();
    return requirePermission("workflow:read")(c, next);
  });

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

  app.post("/v1/extract", async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const contentType = (c.req.header("content-type") ?? "").toLowerCase();
    const rawFilenameHeader = c.req.header("x-filename");
    let filenameHeader: string | undefined;
    if (rawFilenameHeader !== undefined) {
      const parsed = FILENAME_HEADER_SCHEMA.safeParse(decodeFilenameHeader(rawFilenameHeader));
      if (!parsed.success) {
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

    let format: SupportedFileFormat;
    try {
      const detectInput: Parameters<typeof detectFormat>[0] = { buffer };
      const mimeHead = contentType.split(";")[0]?.trim();
      if (mimeHead) detectInput.mime = mimeHead;
      if (filenameHeader) detectInput.filename = filenameHeader;
      const detected = detectFormat(detectInput);
      if (!(SUPPORTED_FILE_FORMATS as readonly string[]).includes(detected)) {
        throw new UnsupportedMediaTypeError("unsupported_file_format", {
          supported: [...SUPPORTED_FILE_FORMATS],
          detail: detected,
        });
      }
      format = detected as SupportedFileFormat;
    } catch (err) {
      if (err instanceof UnsupportedMediaTypeError) throw err;
      if (err instanceof UnsupportedFileUploadError) {
        throw new UnsupportedMediaTypeError("unsupported_file_format", {
          supported: [...SUPPORTED_FILE_FORMATS],
          detail: err.message,
        });
      }
      throw err;
    }

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
          data = { text: parsed.text };
          pages = parsed.pages;
          break;
        }
        case "docx": {
          const parsed = await parseBinaryFile(buffer, "docx");
          data = { markdown: parsed.markdown };
          break;
        }
        case "xlsx":
        case "xls": {
          const parsed = await parseBinaryFile(buffer, format);
          data = { sheets: parsed.sheets };
          break;
        }
        case "pptx": {
          const parsed = await parseBinaryFile(buffer, "pptx");
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
      if (AUDITED_BINARY_FORMATS.has(format)) {
        await auditAwait(
          {
            tenant_id: principal.tenant_id,
            actor_type: principal.kind,
            actor_id: principal.id,
            action: AuditAction.DATA_EXPORTED,
            resource_type: "extract",
            resource_id: null,
            result: "error",
            reason: "parse_failed",
            metadata: {
              format,
              bytes,
              error: sanitizeForAudit(detail),
              request_source: readRequestSource(c),
              ...(filenameHeader ? { filename: sanitizeForAudit(filenameHeader) } : {}),
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

    if (AUDITED_BINARY_FORMATS.has(format)) {
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind,
          actor_id: principal.id,
          action: AuditAction.DATA_EXPORTED,
          resource_type: "extract",
          resource_id: null,
          result: "success",
          metadata: {
            format,
            bytes,
            request_source: readRequestSource(c),
            ...(pages !== undefined ? { pages } : {}),
            ...(filenameHeader ? { filename: sanitizeForAudit(filenameHeader) } : {}),
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
