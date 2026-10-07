import { z } from "@hono/zod-openapi";
import type { CallerContext } from "../execution/caller-context.ts";
import type { MaterializedRequest } from "../execution/prepared-request.ts";
import { hasRuntimeValue } from "./report-delivery-boundary.ts";
import type { RequestStep } from "./types.ts";

const safePrefix = z
  .string()
  .min(3)
  .max(512)
  .refine(
    (value) =>
      value.endsWith("/") &&
      value
        .split("/")
        .slice(0, -1)
        .every((part) => /^[A-Za-z0-9_+=.-]+$/.test(part) && part !== "." && part !== ".."),
  );
export const StorageScopeSchema = z
  .object({
    key_prefix: safePrefix,
    max_bytes: z.number().int().positive().max(10_000_000),
    max_deletes: z.number().int().positive().max(10_000).optional(),
    principal_bound: z.boolean().optional(),
  })
  .strict();
export const StorageBoundarySchema = z
  .object({
    base_url: z.string().url(),
    key_prefix: safePrefix,
    operation: z.enum(["GET", "HEAD", "LIST", "PUT", "DELETE"]),
    max_bytes: z.number().int().positive().max(10_000_000),
    max_keys: z.number().int().positive().max(10_000),
    paginate: z.boolean(),
    content_type: z.string().max(200).nullable(),
    max_deletes: z.number().int().positive().max(10_000).optional(),
    principal_bound: z.boolean().optional(),
  })
  .strict()
  .refine((boundary) => boundary.operation !== "DELETE" || boundary.max_deletes !== undefined, {
    message: "a DELETE storage boundary requires max_deletes",
  });
export type StorageBoundary = z.infer<typeof StorageBoundarySchema>;

export function storageBaseUrl(config: unknown): string | null {
  const parsed = z
    .object({
      region: z.string().optional(),
      endpoint: z.string().optional(),
      bucket: z.string().min(1),
      force_path_style: z.boolean().optional(),
    })
    .passthrough()
    .safeParse(config);
  if (!parsed.success || hasRuntimeValue(config)) return null;
  const cfg = parsed.data;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(cfg.bucket)) return null;
  try {
    const endpoint = cfg.endpoint ?? `s3.${cfg.region ?? "us-east-1"}.amazonaws.com`;
    const url = new URL(endpoint.includes("://") ? endpoint : `https://${endpoint}`);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[%\\]/.test(endpoint)
    )
      return null;
    if (cfg.force_path_style !== false)
      url.pathname = `${url.pathname.replace(/\/$/, "")}/${cfg.bucket}/`;
    else {
      url.hostname = `${cfg.bucket}.${url.hostname}`;
      url.pathname = "/";
    }
    return url.href;
  } catch {
    return null;
  }
}

export type StorageBoundaryRefusal =
  | "base_unresolved"
  | "no_scope"
  | "unsupported_method"
  | "delete_with_body"
  | "runtime_value_outside_key"
  | "query_or_headers_present"
  | "unsupported_option"
  | "content_type_invalid"
  | "scope_invalid";

function hasEntries(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "object") return true;
  return Object.keys(value as Record<string, unknown>).length > 0;
}

export function compileStorageBoundary(
  step: RequestStep,
  base: string | null,
):
  | { boundary: StorageBoundary; refusal?: never }
  | { boundary?: never; refusal: StorageBoundaryRefusal } {
  if (!base) return { refusal: "base_unresolved" };
  if (!step.s3?.scope) return { refusal: "no_scope" };
  if (!["GET", "HEAD", "LIST", "PUT", "DELETE"].includes(step.method))
    return { refusal: "unsupported_method" };
  if (step.method === "DELETE" && step.body !== undefined && step.body !== null)
    return { refusal: "delete_with_body" };
  const { body: _body, path: _path, url: _url, s3, ...fixed } = step;
  const { key: _key, prefix: _prefix, ...fixedStorage } = s3;
  if (hasRuntimeValue(fixed) || hasRuntimeValue(fixedStorage))
    return { refusal: "runtime_value_outside_key" };
  if (hasEntries(step.query) || hasEntries(step.headers))
    return { refusal: "query_or_headers_present" };
  if (
    step.pagination ||
    step.multipart ||
    step.xml ||
    s3.metadata ||
    s3.range ||
    s3.presign ||
    s3.multipart ||
    s3.multipart_threshold_mb
  )
    return { refusal: "unsupported_option" };
  if (s3.content_type && (step.method !== "PUT" || /[\r\n]/.test(s3.content_type)))
    return { refusal: "content_type_invalid" };
  const candidate = StorageBoundarySchema.safeParse({
    base_url: base,
    ...s3.scope,
    operation: step.method,
    max_keys: Math.min(s3.max_keys ?? 1000, s3.paginate ? 10_000 : 1000),
    paginate: s3.paginate === true,
    content_type: s3.content_type ?? null,
  });
  return candidate.success ? { boundary: candidate.data } : { refusal: "scope_invalid" };
}

export function storageBoundary(step: RequestStep, base: string | null): StorageBoundary | null {
  return compileStorageBoundary(step, base).boundary ?? null;
}
export function storageTarget(boundary: StorageBoundary): string {
  return `${boundary.base_url}${boundary.key_prefix}*`;
}

export function assertStorageRequest(
  boundary: StorageBoundary,
  request: MaterializedRequest | undefined,
  caller: CallerContext | null = null,
): void {
  function deny(): never {
    throw Object.assign(new Error("Storage request differs from its reviewed folder and limits"), {
      code: "execution_authority_changed",
    });
  }
  if (!StorageBoundarySchema.safeParse(boundary).success || !request || request.unsupported_body)
    deny();
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    deny();
  }
  const base = new URL(boundary.base_url);
  if (url.origin !== base.origin || url.username || url.password || url.hash) deny();
  const keys = Object.keys(request.headers);
  if (keys.some((key) => key.toLowerCase() !== "content-type") || keys.length > 1) deny();
  const type = Object.values(request.headers)[0] ?? null;
  if (type !== boundary.content_type) deny();
  if (boundary.operation === "LIST") {
    if (request.method !== "GET" || url.pathname !== base.pathname || request.body != null) deny();
    const query = url.searchParams;
    if (
      [...query.keys()].some(
        (key) => !["list-type", "prefix", "max-keys", "continuation-token"].includes(key),
      ) ||
      new Set(query.keys()).size !== [...query.keys()].length ||
      query.get("list-type") !== "2"
    )
      deny();
    const prefix = query.get("prefix");
    const limit = Number(query.get("max-keys"));
    const ownerPrefix = principalStoragePrefix(boundary, caller);
    if (
      !ownerPrefix ||
      !prefix?.startsWith(ownerPrefix) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > Math.min(1000, boundary.max_keys) ||
      (!boundary.paginate && query.has("continuation-token"))
    )
      deny();
    return;
  }
  if (
    request.method !== boundary.operation ||
    url.search ||
    !url.pathname.startsWith(base.pathname)
  )
    deny();
  let key: string;
  try {
    key = decodeURIComponent(url.pathname.slice(base.pathname.length));
  } catch {
    deny();
  }
  if (storageKeyViolation(boundary, key, request.body, caller) !== null) deny();
}

function principalStoragePrefix(
  boundary: StorageBoundary,
  caller: CallerContext | null,
): string | null {
  if (!boundary.principal_bound) return boundary.key_prefix;
  if (!caller || !/^[A-Za-z0-9_+=.-]+$/.test(caller.principalId)) return null;
  return `${boundary.key_prefix}${caller.principalKind}/${caller.principalId}/`;
}

export type StorageKeyViolation =
  | { kind: "outside_folder"; key_prefix: string; key: string }
  | { kind: "key_invalid" }
  | { kind: "body_size"; bytes: number; max_bytes: number }
  | { kind: "body_not_text" | "body_forbidden" };

export function storageKeyViolation(
  boundary: StorageBoundary,
  key: string,
  body: unknown,
  caller: CallerContext | null = null,
): StorageKeyViolation | null {
  const prefix = principalStoragePrefix(boundary, caller);
  if (!prefix || !key.startsWith(prefix))
    return {
      kind: "outside_folder",
      key_prefix: prefix ?? boundary.key_prefix,
      key: key.slice(0, 200),
    };
  if (boundary.operation === "LIST") return body == null ? null : { kind: "body_forbidden" };
  if (
    key.split("/").some((part) => !part || part === "." || part === "..") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in object keys
    /[\\\u0000-\u001f]/.test(key)
  )
    return { kind: "key_invalid" };
  if (boundary.operation !== "PUT") return body == null ? null : { kind: "body_forbidden" };
  if (typeof body !== "string") return { kind: "body_not_text" };
  const bytes = new TextEncoder().encode(body).byteLength;
  return bytes > boundary.max_bytes
    ? { kind: "body_size", bytes, max_bytes: boundary.max_bytes }
    : null;
}

export function describeStorageKeyViolation(violation: StorageKeyViolation): string {
  switch (violation.kind) {
    case "outside_folder":
      return `the key "${violation.key}" is not under \`s3.scope.key_prefix\` "${violation.key_prefix}"`;
    case "body_size":
      return `the content is ${violation.bytes} bytes but \`s3.scope.max_bytes\` is ${violation.max_bytes}`;
    case "key_invalid":
      return "the key has an empty, `.` or `..` segment or a control character";
    case "body_not_text":
      return "the content is not text, so its size cannot be held to `s3.scope.max_bytes`";
    default:
      return "this operation may not carry content";
  }
}
