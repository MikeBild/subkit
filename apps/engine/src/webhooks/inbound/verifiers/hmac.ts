// Configurable HMAC verifier.
//
// For senders that sign with a shared-secret HMAC but use neither the
// Standard Webhooks, GitHub nor Stripe header layout. The binding's
// `native_verifier_config.hmac` object describes the sender's scheme:
//
//   * signature_header  header carrying the signature
//   * signature_prefix  literal prefix stripped before decoding, e.g. "v1="
//   * encoding          "hex" | "base64" digest encoding
//   * signed_payload    template of the signed string; placeholders
//                       {timestamp}, {id} and {body} (required)
//   * timestamp_header  required when the template uses {timestamp};
//                       enables the replay window (tolerance_seconds)
//   * id_header         stable per-delivery id used for replay dedup
//   * type_header / type_field  optional event type source (header, or a
//                       top-level field of the JSON body)
//
// The raw body is signed exactly as received — never re-serialized.

import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { logger } from "../../../logging/logger.ts";
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
    id_header: headerName,
    type_header: headerName.optional(),
    type_field: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((cfg, ctx) => {
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
  });

export type HmacVerifierConfig = z.infer<typeof HmacVerifierConfig>;

function decodeDigest(value: string, encoding: "hex" | "base64"): Buffer | null {
  if (encoding === "hex") {
    // Buffer.from(…, "hex") silently truncates at the first invalid pair.
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
    } catch {
      // Non-JSON body: the type stays unknown.
    }
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
  const id = input.headers[cfg.id_header];
  if (!sigHeader || !id) {
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
    name === "body" ? input.rawBody : name === "id" ? id : rawTimestamp,
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
