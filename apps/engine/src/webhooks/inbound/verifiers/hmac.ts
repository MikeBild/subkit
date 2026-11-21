import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { logger } from "../../../logging/index.ts";
import type { VerifierResult, VerifyInput } from "./types.ts";

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const PLACEHOLDER = /\{([a-z_]+)\}/g;
const ALLOWED_PLACEHOLDERS = new Set(["timestamp", "id", "body"]);

const headerName = z
  .string()
  .min(1)
  .max(128)
  .regex(HEADER_NAME, "must be a valid HTTP header name")
  .transform((name) => name.toLowerCase());

export const HmacVerifierConfig = z
  .object({
    signature_header: headerName,
    signature_prefix: z.string().max(32).default(""),
    algorithm: z.literal("sha256").default("sha256"),
    encoding: z.enum(["hex", "base64"]).default("hex"),
    signed_payload: z.string().min(1).max(256).default("{body}"),
    timestamp_header: headerName.optional(),
    tolerance_seconds: z.number().int().min(1).max(86_400).default(300),
    id_header: headerName.optional(),
    id_field: z.string().min(1).max(128).optional(),
    type_header: headerName.optional(),
    type_field: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    if (!cfg.id_header && !cfg.id_field) {
      ctx.addIssue({
        code: "custom",
        path: ["id_header"],
        message: "id_header or signed-body id_field is required",
      });
    }
    const used = [...cfg.signed_payload.matchAll(PLACEHOLDER)].map((m) => m[1] ?? "");
    for (const name of used) {
      if (!ALLOWED_PLACEHOLDERS.has(name)) {
        ctx.addIssue({
          code: "custom",
          path: ["signed_payload"],
          message: `unknown placeholder {${name}} — allowed: {timestamp}, {id}, {body}`,
        });
      }
    }
    if (!used.includes("body")) {
      ctx.addIssue({
        code: "custom",
        path: ["signed_payload"],
        message: "signed_payload must include {body}",
      });
    }
    if (used.includes("timestamp") && !cfg.timestamp_header) {
      ctx.addIssue({
        code: "custom",
        path: ["timestamp_header"],
        message: "timestamp_header is required when signed_payload uses {timestamp}",
      });
    }
    if (used.includes("id") && !cfg.id_header) {
      ctx.addIssue({
        code: "custom",
        path: ["id_header"],
        message: "id_header is required when signed_payload uses {id}",
      });
    }
  });

export type HmacVerifierConfig = z.infer<typeof HmacVerifierConfig>;

function decodeDigest(value: string, encoding: "hex" | "base64"): Buffer | null {
  if (encoding === "hex") {
    if (value.length !== 64 || !/^[0-9a-fA-F]+$/.test(value)) return null;
    return Buffer.from(value, "hex");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const buf = Buffer.from(value, "base64");
  return buf.length === 32 ? buf : null;
}

function eventType(input: VerifyInput, cfg: HmacVerifierConfig): string {
  if (cfg.type_header) return input.headers[cfg.type_header] ?? "unknown";
  if (cfg.type_field) {
    try {
      const parsed = JSON.parse(input.rawBody) as Record<string, unknown>;
      const value = parsed?.[cfg.type_field];
      if (typeof value === "string" && value.length > 0) return value;
    } catch {}
  }
  return "unknown";
}

export function verifyHmac(input: VerifyInput): VerifierResult {
  const parsed = HmacVerifierConfig.safeParse(input.config?.hmac);
  if (!parsed.success) {
    return { ok: false, reason: "bad_hmac_config" };
  }
  const cfg = parsed.data;

  const sigHeader = input.headers[cfg.signature_header];
  const headerId = cfg.id_header ? input.headers[cfg.id_header] : undefined;
  if (
    !sigHeader ||
    (!cfg.id_field && !headerId) ||
    (cfg.signed_payload.includes("{id}") && !headerId)
  ) {
    return { ok: false, reason: "missing_hmac_headers" };
  }

  const now = Math.floor((input.now ?? Date.now()) / 1000);
  let timestamp = now;
  let rawTimestamp = "";
  if (cfg.timestamp_header) {
    rawTimestamp = input.headers[cfg.timestamp_header] ?? "";
    const ts = Number.parseInt(rawTimestamp, 10);
    if (!rawTimestamp || !Number.isFinite(ts) || String(ts) !== rawTimestamp.trim()) {
      return { ok: false, reason: "bad_timestamp" };
    }
    if (Math.abs(now - ts) > cfg.tolerance_seconds) {
      return { ok: false, reason: "timestamp_outside_window" };
    }
    timestamp = ts;
  }

  if (!sigHeader.startsWith(cfg.signature_prefix)) {
    return { ok: false, reason: "bad_hmac_signature_format" };
  }
  const provided = decodeDigest(sigHeader.slice(cfg.signature_prefix.length).trim(), cfg.encoding);
  if (!provided) {
    return { ok: false, reason: "bad_hmac_signature_format" };
  }

  const base = cfg.signed_payload.replace(PLACEHOLDER, (_, name: string) =>
    name === "body" ? input.rawBody : name === "id" ? (headerId ?? "") : rawTimestamp,
  );
  const expected = createHmac(cfg.algorithm, input.secret).update(base, "utf8").digest();
  if (!timingSafeEqual(provided, expected)) {
    logger.warn({
      module: "webhooks.inbound",
      action: "verify_failed",
      verifier: "hmac",
      reason: "bad_signature",
    });
    return { ok: false, reason: "bad_signature" };
  }

  let id = headerId;
  if (cfg.id_field) {
    try {
      const body: unknown = JSON.parse(input.rawBody);
      const value =
        typeof body === "object" &&
        body !== null &&
        !Array.isArray(body) &&
        Object.hasOwn(body, cfg.id_field)
          ? (body as Record<string, unknown>)[cfg.id_field]
          : undefined;
      if (typeof value !== "string" || value.length === 0 || value.length > 512) {
        return { ok: false, reason: "bad_hmac_event_id" };
      }
      id = value;
    } catch {
      return { ok: false, reason: "bad_hmac_event_id" };
    }
  }
  if (!id) return { ok: false, reason: "bad_hmac_event_id" };

  const type = eventType(input, cfg);
  logger.debug({
    module: "webhooks.inbound",
    action: "verified",
    verifier: "hmac",
    webhook_id: id,
    type,
  });
  return { ok: true, normalized: { id, timestamp, type } };
}
