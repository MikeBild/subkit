import { z } from "@hono/zod-openapi";
import type { MaterializedRequest } from "../execution/prepared-request.ts";

// Public ContentKit protocol: immutable markdown revisions and a release that
// overlays exactly those revisions. Retiring existing content is not included.
// These shapes describe a proposal, never establish human authority themselves.
const identifier = z.string().uuid();
const origin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.origin === value;
  });
const members = z
  .array(identifier)
  .min(1)
  .max(100)
  .refine((ids) => ids.every((id, index) => index === 0 || ids[index - 1]! < id));
export const ContentRevisionBoundarySchema = z
  .object({
    kind: z.literal("content_revision"),
    origin,
    item_ids: members,
    max_bytes: z.number().int().min(1).max(1_000_000),
  })
  .strict();
export const ContentReleaseBoundarySchema = z
  .object({
    kind: z.literal("content_release"),
    origin,
    site_id: identifier,
    reason: z.string().max(1_000).nullable(),
    sources: z
      .array(
        z
          .object({
            step_id: z.string().min(1),
            item_ids: members,
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .refine(
    ({ sources }) =>
      new Set(sources.map((source) => source.step_id)).size === sources.length &&
      new Set(sources.flatMap((source) => source.item_ids)).size ===
        sources.reduce((count, source) => count + source.item_ids.length, 0),
  );
export type ContentRevisionBoundary = z.infer<typeof ContentRevisionBoundarySchema>;
export type ContentReleaseBoundary = z.infer<typeof ContentReleaseBoundarySchema>;

/** A receipt must be captured by the driver from the successful raw response,
 * before authored selectors/transforms. Admission must load receipts only from
 * succeeded, non-held steps of this tenant and execution. Neither model output,
 * input data, a preview nor another execution can supply these receipts. */
export const ContentRevisionReceiptSchema = z
  .object({
    step_id: z.string().min(1),
    origin,
    item_id: identifier,
    revision_id: identifier,
  })
  .strict();
export type ContentRevisionReceipt = z.infer<typeof ContentRevisionReceiptSchema>;

function deny(): never {
  throw Object.assign(new Error("Content publication differs from its reviewed boundary"), {
    code: "execution_authority_changed",
  });
}

function requestUrl(request: MaterializedRequest): URL | null {
  try {
    const url = new URL(request.url);
    // URL normalization must not turn an ambiguous authored path into a match.
    if (
      !/^https?:\/\//.test(request.url) ||
      /[%\\]/.test(request.url) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      request.unsupported_body
    )
      return null;
    const rawPath = request.url.slice(request.url.indexOf("/", request.url.indexOf("://") + 3));
    if (rawPath !== url.pathname) return null;
    const headers = Object.entries(request.headers).map(([key, value]) => [
      key.toLowerCase(),
      value,
    ]);
    if (
      new Set(headers.map(([key]) => key)).size !== headers.length ||
      headers.some(
        ([key]) =>
          ![
            "content-type",
            "accept",
            "authorization",
            "x-api-key",
            "idempotency-key",
            "user-agent",
          ].includes(key!),
      )
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

function contentType(request: MaterializedRequest): string {
  return (
    Object.entries(request.headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] ?? ""
  );
}

export function inspectContentRevisionRequest(request: MaterializedRequest): {
  origin: string;
  item_id: string;
  bytes: number;
} | null {
  const url = requestUrl(request);
  const match = url && /^\/v1\/content\/([^/]+)\/revisions$/.exec(url.pathname);
  if (
    request.method !== "PUT" ||
    !url ||
    !match ||
    !identifier.safeParse(match[1]).success ||
    !/^text\/markdown(?:;\s*charset=utf-8)?$/i.test(contentType(request)) ||
    typeof request.body !== "string"
  )
    return null;
  const bytes = new TextEncoder().encode(request.body).byteLength;
  if (!bytes || bytes > 1_000_000) return null;
  return { origin: url.origin, item_id: match[1]!, bytes };
}

export function assertContentRevision(
  boundary: ContentRevisionBoundary,
  request: MaterializedRequest | undefined,
): void {
  const parsed = ContentRevisionBoundarySchema.safeParse(boundary);
  const actual = request && inspectContentRevisionRequest(request);
  if (
    !parsed.success ||
    !actual ||
    actual.origin !== parsed.data.origin ||
    !parsed.data.item_ids.includes(actual.item_id) ||
    actual.bytes > parsed.data.max_bytes
  )
    deny();
}

/** Inspect only a successful, untransformed provider response. The optional
 * returned item identity must agree; ambiguous nested/flat IDs fail closed. */
export function inspectContentRevisionResponse(input: {
  step_id: string;
  request: MaterializedRequest;
  status: number;
  body: unknown;
}): ContentRevisionReceipt | null {
  const actual = inspectContentRevisionRequest(input.request);
  if (!actual || input.status !== 201) return null;
  const envelope = z
    .object({
      id: identifier.optional(),
      item_id: identifier.optional(),
      revision: z
        .object({ id: identifier, item_id: identifier.optional() })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .safeParse(input.body);
  if (!envelope.success) return null;
  const value = envelope.data;
  const revisionId = value.revision?.id ?? value.id;
  if (
    !revisionId ||
    (value.id && value.revision && value.id !== value.revision.id) ||
    (value.item_id && value.item_id !== actual.item_id) ||
    (value.revision?.item_id && value.revision.item_id !== actual.item_id)
  )
    return null;
  const receipt = ContentRevisionReceiptSchema.safeParse({
    step_id: input.step_id,
    origin: actual.origin,
    item_id: actual.item_id,
    revision_id: revisionId,
  });
  return receipt.success ? receipt.data : null;
}

export function assertContentRelease(
  boundary: ContentReleaseBoundary,
  request: MaterializedRequest | undefined,
  receipts: readonly ContentRevisionReceipt[],
): void {
  const parsed = ContentReleaseBoundarySchema.safeParse(boundary);
  if (!parsed.success || !request) deny();
  const scope = parsed.data;
  const url = requestUrl(request);
  if (
    !url ||
    request.method !== "POST" ||
    url.origin !== scope.origin ||
    url.pathname !== `/v1/sites/${scope.site_id}/releases` ||
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType(request))
  )
    deny();
  let body: unknown = request.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      deny();
    }
  }
  const release = z
    .object({
      revision_ids: z.array(identifier).min(1).max(100),
      reason: z.string().max(1_000).optional(),
    })
    .strict()
    .safeParse(body);
  if (!release.success || (release.data.reason ?? null) !== scope.reason) deny();
  const expected = new Map(
    scope.sources.flatMap((source) => source.item_ids.map((id) => [id, source.step_id] as const)),
  );
  const observed = new Map<string, string>();
  for (const raw of receipts) {
    const receipt = ContentRevisionReceiptSchema.safeParse(raw);
    if (!receipt.success) deny();
    const value = receipt.data;
    // Other unrelated operations in the run grant no publication permission.
    if (!scope.sources.some((source) => source.step_id === value.step_id)) continue;
    if (
      value.origin !== scope.origin ||
      expected.get(value.item_id) !== value.step_id ||
      observed.has(value.item_id)
    )
      deny();
    observed.set(value.item_id, value.revision_id);
  }
  const ids = release.data.revision_ids;
  if (
    observed.size !== expected.size ||
    ids.length !== expected.size ||
    new Set(ids).size !== ids.length ||
    new Set(observed.values()).size !== observed.size ||
    ids.some((id) => ![...observed.values()].includes(id))
  )
    deny();
}
