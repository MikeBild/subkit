import { z } from "zod";
import type { HttpDispatchObservation } from "../connectors/drivers/http.ts";
import { secretComparisonProof } from "../crypto/aes-gcm.ts";
import { scrubString } from "../logging/scrub-secrets.ts";
import { authorityRequestReview } from "../workflows/authority-request-review.ts";
import { canonicalWorkflowJson } from "../workflows/canonical-json.ts";
import { RequestStepSchema } from "../workflows/types.ts";
import type { RequestAuthoritySnapshot } from "./types.ts";

export type MaterializedRequest = HttpDispatchObservation & {
  generated_idempotency?: { key: string; page: number };
};

const materializedRequestSchema = z
  .object({
    method: z.string().min(1),
    url: z.url({ protocol: /^https?$/ }),
    headers: z.record(z.string(), z.string()),
    body: z.json(),
    unsupported_body: z.boolean().optional(),
    body_encoding: z.literal("multipart").optional(),
    body_bytes: z.number().int().nonnegative().optional(),
    generated_idempotency: z
      .object({ key: z.string().min(1), page: z.number().int().nonnegative() })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => (value.body_encoding === "multipart") === (value.body_bytes !== undefined));

export const PreparedDispatchSnapshotSchema = z
  .object({
    referenced_authorities: z
      .array(
        z
          .object({
            connector_id: z.string().uuid(),
            configuration_digest: z.string().regex(/^[a-f0-9]{64}$/),
            credential_id: z.string().uuid().nullable(),
            credential_revision: z.number().int().positive().nullable(),
            credential_binding_digest: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            connection_authority: z
              .object({ id: z.string().uuid(), revision: z.number().int().positive() })
              .strict()
              .nullable()
              .optional(),
          })
          .strict()
          .refine(
            (value) => (value.credential_id === null) === (value.credential_revision === null),
          ),
      )
      .max(1000)
      .optional(),
    step_id: z.string().min(1),
    step_row_id: z.string().uuid(),
    connector_id: z.string().uuid().nullable(),
    requires_review: z.boolean(),
    requires_transactional_authority: z.boolean().optional(),
    outbox_source: z
      .object({ ok: z.boolean(), recipient: z.unknown(), item_id: z.unknown() })
      .strict()
      .optional(),
    request_max_attempts: z.number().int().min(1).max(20),
    principal_id: z.string().uuid().nullable(),
    configuration_digest: z.string().regex(/^[a-f0-9]{64}$/),
    credential_id: z.string().uuid().nullable(),
    credential_revision: z.number().int().positive().nullable(),
    connection_authority: z
      .object({ id: z.string().uuid(), revision: z.number().int().positive() })
      .strict()
      .nullable(),
    request: materializedRequestSchema.optional(),
  })
  .strict()
  .refine((value) =>
    value.credential_id === null
      ? value.credential_revision === null && value.connection_authority === null
      : value.credential_revision !== null,
  );

export const PreparedRequestProofSchema = z
  .object({
    version: z.literal(1),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    max_attempts: z.number().int().min(1).max(20),
  })
  .strict();
export type PreparedRequestProof = z.infer<typeof PreparedRequestProofSchema>;

export const PreparedRequestReviewSchema = z
  .object({
    method: z.string().min(1),
    url: z.string().min(1),
    redacted_request_json: z.string().max(16_000),
    request_review_truncated: z.boolean(),
    opaque_payload_omitted: z.boolean(),
    body_bytes: z.number().int().nonnegative().optional(),
  })
  .strict();

export function preparedRequestReview(request: MaterializedRequest) {
  if (!materializedRequestSchema.safeParse(request).success || request.unsupported_body)
    return null;
  let body = request.body;
  let opaqueBody = request.body_encoding === "multipart";
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed !== null && typeof parsed === "object") body = parsed;
      else opaqueBody = true;
    } catch {
      opaqueBody = true;
    }
  }
  const step = RequestStepSchema.safeParse({
    kind: "request",
    id: "prepared",
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: opaqueBody ? null : body,
  });
  if (!step.success || request.unsupported_body) return null;
  const url = new URL(request.url);
  const measured =
    request.body_bytes ??
    (request.body === null || request.body === undefined
      ? undefined
      : new TextEncoder().encode(
          typeof request.body === "string" ? request.body : JSON.stringify(request.body),
        ).byteLength);
  return PreparedRequestReviewSchema.parse({
    method: request.method,
    url: scrubString(`${url.origin}${url.pathname}`),
    ...authorityRequestReview(step.data),
    opaque_payload_omitted: opaqueBody,
    ...(measured === undefined ? {} : { body_bytes: measured }),
  });
}

export function preparedRequestProof(
  tenant: string,
  snapshot: RequestAuthoritySnapshot,
  request: MaterializedRequest,
  maxAttempts: number,
): PreparedRequestProof | null {
  const parsed = materializedRequestSchema.safeParse(request);
  if (
    !parsed.success ||
    request.unsupported_body ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 20
  )
    return null;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    const key = name.toLowerCase();
    if (key in headers) return null;
    headers[key] = value;
  }
  if (request.generated_idempotency) {
    const { key, page } = request.generated_idempotency;
    if (headers["idempotency-key"] !== key || !Number.isSafeInteger(page) || page < 0) return null;
    delete headers["idempotency-key"];
  }
  const { request: _request, step_row_id: _row, ...authority } = snapshot;
  return PreparedRequestProofSchema.parse({
    version: 1,
    digest: secretComparisonProof(
      `prepared-request:v1:${tenant}`,
      canonicalWorkflowJson({
        authority,
        max_attempts: Math.min(20, Math.max(1, maxAttempts)),
        method: request.method.toUpperCase(),
        url: new URL(request.url).toString(),
        headers,
        body: request.body ?? null,
        ...(request.body_encoding
          ? { body_encoding: request.body_encoding, body_bytes: request.body_bytes }
          : {}),
        generated_idempotency_page: request.generated_idempotency?.page ?? null,
      }),
    ),
    max_attempts: Math.min(20, Math.max(1, maxAttempts)),
  });
}
