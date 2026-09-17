import { z } from "@hono/zod-openapi";
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
/** An authored proposal. Only a separate human-approved manifest grants access. */
export const StorageScopeSchema = z
  .object({
    key_prefix: safePrefix,
    max_bytes: z.number().int().positive().max(10_000_000),
  })
  .strict();
export const StorageBoundarySchema = z
  .object({
    base_url: z.string().url(),
    key_prefix: safePrefix,
    operation: z.enum(["GET", "HEAD", "LIST", "PUT"]),
    max_bytes: z.number().int().positive().max(10_000_000),
    max_keys: z.number().int().positive().max(10_000),
    paginate: z.boolean(),
    content_type: z.string().max(200).nullable(),
  })
  .strict();
export type StorageBoundary = z.infer<typeof StorageBoundarySchema>;

/** Mirrors the S3 connector's endpoint, path-style and region defaults. */
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

export function storageBoundary(step: RequestStep, base: string | null): StorageBoundary | null {
  if (!base || !step.s3?.scope || !["GET", "HEAD", "LIST", "PUT"].includes(step.method))
    return null;
  const { body: _body, path: _path, url: _url, s3, ...fixed } = step;
  const { key: _key, prefix: _prefix, ...fixedStorage } = s3;
  if (
    hasRuntimeValue(fixed) ||
    hasRuntimeValue(fixedStorage) ||
    step.query ||
    step.headers ||
    step.pagination ||
    step.multipart ||
    step.xml ||
    s3.metadata ||
    s3.range ||
    s3.presign ||
    s3.multipart ||
    s3.multipart_threshold_mb
  )
    return null;
  if (s3.content_type && (step.method !== "PUT" || /[\r\n]/.test(s3.content_type))) return null;
  const candidate = StorageBoundarySchema.safeParse({
    base_url: base,
    ...s3.scope,
    operation: step.method,
    max_keys: Math.min(s3.max_keys ?? 1000, s3.paginate ? 10_000 : 1000),
    paginate: s3.paginate === true,
    content_type: s3.content_type ?? null,
  });
  return candidate.success ? candidate.data : null;
}
export function storageTarget(boundary: StorageBoundary): string {
  return `${boundary.base_url}${boundary.key_prefix}*`;
}

export function assertStorageRequest(
  boundary: StorageBoundary,
  request: MaterializedRequest | undefined,
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
    if (
      !prefix?.startsWith(boundary.key_prefix) ||
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
  if (
    !key.startsWith(boundary.key_prefix) ||
    key.split("/").some((part) => !part || part === "." || part === "..") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in object keys
    /[\\\u0000-\u001f]/.test(key)
  )
    deny();
  if (boundary.operation === "PUT") {
    if (
      typeof request.body !== "string" ||
      new TextEncoder().encode(request.body).byteLength > boundary.max_bytes
    )
      deny();
  } else if (request.body != null) deny();
}
