import { z } from "@hono/zod-openapi";
import type { MaterializedRequest } from "../execution/prepared-request.ts";
import { hasRuntimeValue } from "./report-delivery-boundary.ts";
import type { RequestStep } from "./types.ts";

export const ReadPathBoundarySchema = z
  .object({
    origin: z.string().url(),
    segments: z.array(z.string().nullable()).min(2).max(50),
    search: z.string(),
  })
  .strict();
type ReadPathBoundary = z.infer<typeof ReadPathBoundarySchema>;

export function readPathBoundary(
  step: RequestStep,
  baseUrl?: string | null,
): ReadPathBoundary | null {
  const { path, url, ...fixed } = step;
  const authored = path ?? url;
  if (
    step.method !== "GET" ||
    step.side_effects === "write" ||
    step.body != null ||
    step.pagination ||
    step.query ||
    step.xml ||
    step.form ||
    step.multipart ||
    hasRuntimeValue(fixed) ||
    !authored ||
    (path && url) ||
    authored.includes("\\") ||
    authored.includes("%") ||
    hasRuntimeValue(baseUrl)
  )
    return null;
  const pieces = authored.split("/");
  const positions: number[] = [];
  const mask = pieces
    .map((piece, index) => {
      if (/^\$\{(?:item|input|scope)(?:\.[A-Za-z_][A-Za-z0-9_]*)+\}$/.test(piece)) {
        positions.push(index);
        return "subkit_variable_identifier";
      }
      return piece;
    })
    .join("/");
  if (!positions.length || hasRuntimeValue(mask)) return null;
  try {
    const resolved = new URL(mask, baseUrl ?? undefined);
    if (
      !["http:", "https:"].includes(resolved.protocol) ||
      resolved.username ||
      resolved.password ||
      resolved.hash ||
      resolved.host.includes("subkit_variable_identifier")
    )
      return null;
    const segments = resolved.pathname
      .split("/")
      .map((segment) => (segment === "subkit_variable_identifier" ? null : segment));
    if (segments.filter((segment) => segment === null).length !== positions.length) return null;
    if (!segments[1] || !segments.some((segment, index) => index > 1 && segment === null))
      return null;
    return { origin: resolved.origin, segments, search: resolved.search };
  } catch {
    return null;
  }
}

export function readPathTarget(boundary: ReadPathBoundary): string {
  return boundary.origin + boundary.segments.map((segment) => segment ?? "{ID}").join("/");
}

export function assertReadPath(
  boundary: ReadPathBoundary,
  request: MaterializedRequest | undefined,
) {
  const deny = () => {
    throw Object.assign(new Error("Read request differs from its reviewed resource path"), {
      code: "execution_authority_changed",
    });
  };
  if (request?.method !== "GET" || request.body != null || request.unsupported_body) return deny();
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return deny();
  }
  const segments = url.pathname.split("/");
  if (
    url.origin !== boundary.origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.search !== boundary.search ||
    segments.length !== boundary.segments.length
  )
    return deny();
  for (const [index, expected] of boundary.segments.entries()) {
    const actual = segments[index]!;
    if (expected === null ? !/^[A-Za-z0-9_-]{1,200}$/.test(actual) : actual !== expected)
      return deny();
  }
}
