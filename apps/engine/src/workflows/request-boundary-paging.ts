import { canonicalWorkflowJson } from "./canonical-json.ts";
import type { RequestBoundary } from "./request-boundary.ts";

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type PagedBodyViolation =
  | { reason: "not_an_object" | "changed_between_pages" }
  | { reason: "paging_value"; field: string };

export function pagedBodyParts(
  params: readonly string[],
  body: unknown,
): { rest: string } | PagedBodyViolation {
  let parsed: unknown = body;
  if (typeof body === "string") {
    try {
      parsed = JSON.parse(body);
    } catch {
      return { reason: "not_an_object" };
    }
  }
  if (!isPlainRecord(parsed)) return { reason: "not_an_object" };
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!params.includes(key)) {
      rest[key] = value;
      continue;
    }
    if (typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value)))
      return { reason: "paging_value", field: key };
  }
  try {
    return { rest: canonicalWorkflowJson(rest) };
  } catch {
    return { reason: "not_an_object" };
  }
}

export function pagedBodyGuard(
  boundary: RequestBoundary,
): ((body: unknown) => PagedBodyViolation | null) | null {
  if (boundary.pagination?.location !== "body") return null;
  let first: string | undefined;
  return (body) => {
    const parts = pagedBodyParts(boundary.pagination?.params ?? [], body);
    if ("reason" in parts) return parts;
    if (first !== undefined && parts.rest !== first) return { reason: "changed_between_pages" };
    first = parts.rest;
    return null;
  };
}

export function describePagedBodyViolation(detail: PagedBodyViolation): string {
  if (detail.reason === "paging_value")
    return `the paging field \`${detail.field}\` in the body is not a plain text or number value`;
  if (detail.reason === "changed_between_pages")
    return "a later page differs from the first page in more than the reviewed paging fields";
  return "paging through the body needs a JSON object body";
}
