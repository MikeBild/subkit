import type { RequestStep } from "../types.ts";

export type PathPart = string | { var: string };

export type ProposedRule = { enum: string[] } | { class: string } | { caller_bound: true };

export interface PathRewrite {
  path: string;
  query: Record<string, string>;
}

export interface StepEvidence {
  url: string | null;
  key: string | null;
  prefix: string | null;
  pages: number | null;
  bytes: number | null;
  held: { url?: string | null; body?: unknown } | null;
  trial: boolean;
  prepared: { url?: string; redacted_request_json?: string; body_bytes?: number } | null;
  execution_id: string;
  version_id: string | null;
  at: Date;
}

export interface ProposedRequestScope {
  variables: Record<string, ProposedRule>;
  max_body_bytes: number;
  max_calls: number;
  destructive?: true;
}

export interface ProposedStorageScope {
  key_prefix: string;
  max_bytes: number;
  max_deletes?: number;
}

export interface StepProposal {
  step_id: string;
  max_pages?: number;
  boundary?: ProposedRequestScope;
  s3_scope?: ProposedStorageScope;
  path_rewrite?: PathRewrite;
}

export const MAX_LISTED_VALUES = 12;
export const MAX_LISTED_LENGTH = 32;

const NARROW_CLASSES = ["uuid", "timestamp", "date", "integer"] as const;
const WIDE_CLASSES = ["file_name", "identifier", "long_identifier"] as const;
const LISTABLE = /^[A-Za-z0-9._-]+$/;
const WHOLE_PLACEHOLDER = /^\$\{([^}]+)\}$/;
const UNSPLITTABLE = /[?#%\\]/;
const PLACEHOLDER_OPEN = "${";
const ORIGIN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/;

function classCovering(
  values: readonly string[],
  names: readonly string[],
  classes: Readonly<Record<string, RegExp>>,
): string | undefined {
  return names.find((name) => {
    const pattern = classes[name];
    return pattern !== undefined && values.every((value) => pattern.test(value));
  });
}

export function proposedRule(
  values: readonly string[],
  classes: Readonly<Record<string, RegExp>>,
  listedOnly: boolean,
  secret: (value: string) => boolean,
): ProposedRule | null {
  const distinct = [...new Set(values)].sort();
  if (distinct.length === 0) return null;
  const identifier = classes.uuid;
  const listed =
    distinct.length <= MAX_LISTED_VALUES &&
    distinct.every(
      (value) =>
        ((value.length <= MAX_LISTED_LENGTH && LISTABLE.test(value)) ||
          identifier?.test(value) === true) &&
        !secret(value),
    )
      ? { enum: distinct }
      : null;
  if (listedOnly) return listed;
  const narrow = classCovering(distinct, NARROW_CLASSES, classes);
  if (narrow) return { class: narrow };
  if (listed) return listed;
  const wide = classCovering(distinct, WIDE_CLASSES, classes);
  return wide ? { class: wide } : null;
}

export function contentCeiling(bytes: number): number {
  return Math.min(10_000_000, Math.max(1024, Math.ceil((bytes * 2) / 1024) * 1024));
}

export function pageCeiling(pages: readonly number[]): number | null {
  const fetched = pages.filter((count) => count > 0);
  if (fetched.length === 0) return null;
  return Math.min(1000, Math.max(5, Math.max(...fetched) * 2));
}

export function runCeiling(executionIds: readonly string[]): number {
  const perRun = new Map<string, number>();
  let busiest = 0;
  for (const id of executionIds) {
    const count = (perRun.get(id) ?? 0) + 1;
    perRun.set(id, count);
    busiest = Math.max(busiest, count);
  }
  return Math.min(10_000, Math.max(1, busiest * 2));
}

export function textBytes(value: unknown): number | null {
  if (value === null) return null;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text === undefined ? null : new TextEncoder().encode(text).byteLength;
}

function reviewedBodyBytes(json: string | undefined): number | null {
  if (json === undefined) return null;
  try {
    return textBytes((JSON.parse(json) as { body?: unknown }).body);
  } catch {
    return null;
  }
}

export function observedContentBytes(entry: StepEvidence): number | null {
  if (entry.bytes !== null && entry.bytes > 0) return entry.bytes;
  const held = textBytes(entry.held?.body);
  if (held !== null) return held;
  if (entry.prepared?.body_bytes !== undefined) return entry.prepared.body_bytes;
  return reviewedBodyBytes(entry.prepared?.redacted_request_json);
}

export function observedUrl(entry: StepEvidence): string | null {
  return entry.url || entry.held?.url || entry.prepared?.url || null;
}

export function observedKey(entry: StepEvidence): string | null {
  if (entry.key) return entry.key;
  return entry.held?.url?.replace(/^\/+/, "") || null;
}

export function evidenceKind(rows: readonly StepEvidence[]): "sent" | "trial" {
  return rows.some((entry) => !entry.trial && Boolean(entry.url || entry.key || entry.prefix))
    ? "sent"
    : "trial";
}

export function preferredEvidence<T extends { version_id: string | null }>(
  rows: readonly T[],
  version_id: string | null,
): readonly T[] {
  const own = rows.filter((row) => row.version_id === version_id);
  return own.length > 0 ? own : rows;
}

export function wholePlaceholder(value: unknown): string | null {
  return typeof value === "string" ? (WHOLE_PLACEHOLDER.exec(value)?.[1] ?? null) : null;
}

export function withoutOrigin(authored: string): string {
  return authored.replace(ORIGIN, "");
}

export function pathTemplate(path: string): PathPart[] | null {
  if (UNSPLITTABLE.test(path)) return null;
  const parts: PathPart[] = [];
  for (const part of path.split("/")) {
    const name = wholePlaceholder(part);
    if (name !== null) parts.push({ var: name });
    else if (part.includes(PLACEHOLDER_OPEN)) return null;
    else parts.push(part);
  }
  return parts;
}

function tailOf(parts: readonly PathPart[]): readonly PathPart[] {
  return parts[0] === "" ? parts.slice(1) : parts;
}

function parsed(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

export function alignFromEnd(parts: readonly PathPart[], url: string): Map<string, string> | null {
  const target = parsed(url);
  if (target === null) return null;
  const actual = target.pathname.split("/");
  const tail = tailOf(parts);
  const offset = actual.length - tail.length;
  if (offset < 0) return null;
  if (offset > 0 && typeof tail[0] !== "string") return null;
  const values = new Map<string, string>();
  for (const [index, part] of tail.entries()) {
    const seen = actual[offset + index] as string;
    if (typeof part !== "string") values.set(part.var, seen);
    else if (part !== seen) return null;
  }
  return values;
}

export function wholePathVariable(parts: readonly PathPart[]): string | null {
  const [only, ...rest] = tailOf(parts);
  return rest.length === 0 && only !== undefined && typeof only !== "string" ? only.var : null;
}

export function wholePathValue(url: string): string | null {
  return parsed(url)?.pathname ?? null;
}

export function baseDepth(base_url: string | null): number | null {
  if (!base_url) return 0;
  const base = parsed(base_url);
  return base === null ? null : base.pathname.split("/").filter(Boolean).length;
}

export function splitQueryFromPath(authored: string): PathRewrite | null {
  const cut = authored.indexOf("?");
  if (cut < 0) return null;
  const path = authored.slice(0, cut);
  if (UNSPLITTABLE.test(path)) return null;
  const query: Record<string, string> = {};
  for (const pair of authored.slice(cut + 1).split("&")) {
    if (pair === "") continue;
    const equals = pair.indexOf("=");
    if (equals <= 0) return null;
    const key = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    if (key.includes(PLACEHOLDER_OPEN) || Object.hasOwn(query, key)) return null;
    if (value.includes(PLACEHOLDER_OPEN) && wholePlaceholder(value) === null) return null;
    query[key] = value;
  }
  return Object.keys(query).length > 0 ? { path, query } : null;
}

export function rewriteObserved(
  rewrite: PathRewrite,
  parts: readonly PathPart[],
  urls: readonly string[],
): boolean {
  const expected = Object.keys(rewrite.query).sort();
  return urls.some((raw) => {
    const target = parsed(raw);
    if (target === null || alignFromEnd(parts, raw) === null) return false;
    const keys = [...target.searchParams.keys()].sort();
    if (keys.length !== expected.length) return false;
    return expected.every((key, index) => {
      const authored = rewrite.query[key] as string;
      if (keys[index] !== key) return false;
      return authored.includes(PLACEHOLDER_OPEN) || target.searchParams.get(key) === authored;
    });
  });
}

export function queryValue(url: string, key: string): string | null {
  return parsed(url)?.searchParams.get(key) ?? null;
}

export function folderSegments(key_prefix: string): string[] {
  return key_prefix.split("/").filter((segment) => segment !== "");
}

export function commonFolder(keys: readonly string[]): string | null {
  const [first, ...rest] = keys;
  if (first === undefined) return null;
  let end = first.length;
  for (const key of rest) {
    let index = 0;
    while (index < end && key[index] === first[index]) index += 1;
    end = index;
  }
  const cut = first.slice(0, end).lastIndexOf("/");
  return cut < 0 ? null : first.slice(0, cut + 1);
}

export function applyStepProposal(step: RequestStep, proposal: StepProposal): RequestStep {
  if (proposal.s3_scope && step.s3)
    return { ...step, s3: { ...step.s3, scope: { ...step.s3.scope, ...proposal.s3_scope } } };
  const paged =
    proposal.max_pages !== undefined && step.pagination
      ? { pagination: { ...step.pagination, max_pages: proposal.max_pages } }
      : {};
  const rewritten = proposal.path_rewrite
    ? {
        [step.path === undefined ? "url" : "path"]: proposal.path_rewrite.path,
        query: { ...step.query, ...proposal.path_rewrite.query },
      }
    : {};
  const bounded = proposal.boundary ? { boundary: proposal.boundary } : {};
  return { ...step, ...paged, ...rewritten, ...bounded } as RequestStep;
}
