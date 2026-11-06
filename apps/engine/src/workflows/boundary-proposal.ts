import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { connectors, executionSteps, executions } from "../db/schema/index.ts";
import { pathValueAllowed, VALUE_CLASSES } from "./request-boundary.ts";
import type { RequestStep, WorkflowDef } from "./types.ts";

const CLASS_ORDER = ["uuid", "timestamp", "date", "integer", "file_name", "identifier"] as const;

const MAX_ENUM = 12;
const EVIDENCE_ROWS = 2000;

interface ProposedStepBoundary {
  step_id: string;
  max_pages?: number;
  boundary?: {
    variables: Record<string, { enum: string[] } | { class: string }>;
    max_body_bytes: number;
    max_calls: number;
  };
  s3_scope?: { key_prefix: string; max_bytes: number };
  path_rewrite?: { path: string; query: Record<string, string> };
  evidence: { observations: number; sample: string; newest_at: string };
}

interface UnproposableStep {
  step_id: string;
  reason:
    | "no_history"
    | "path_not_comparable"
    | "values_not_describable"
    | "body_size_unknown"
    | "not_supported";
}

interface BoundaryProposals {
  proposals: ProposedStepBoundary[];
  unproposable: UnproposableStep[];
}

interface Observation {
  step_key: string;
  url: string | null;
  key: string | null;
  pages: number | null;
  bytes: number | null;
  prefix: string | null;
  held: { url?: string; key?: string; body?: unknown } | null;
  prepared: { url?: string; redacted_request_json?: string; body_bytes?: number } | null;
  execution_id: string;
  at: Date;
}

async function observations(
  db: Executor,
  tenant_id: string,
  workflow_id: string,
  step_ids: readonly string[],
): Promise<Map<string, Observation[]>> {
  const byStep = new Map<string, Observation[]>();
  if (step_ids.length === 0) return byStep;
  const rows = await db
    .select({
      step_key: sql<string>`regexp_replace(${executionSteps.step_key}, '\\[[0-9]+\\]$', '')`,
      url: sql<string | null>`${executionSteps.request_meta} ->> 'url'`,
      key: sql<string | null>`${executionSteps.request_meta} ->> 'key'`,
      pages: sql<
        number | null
      >`nullif(${executionSteps.request_meta} ->> 'pages_fetched', '')::int`,
      bytes: sql<number | null>`nullif(${executionSteps.request_meta} ->> 'bytes_out', '')::int`,
      prefix: sql<string | null>`${executionSteps.request_meta} ->> 'prefix'`,
      prepared: sql<{ url?: string; redacted_request_json?: string; body_bytes?: number } | null>`
        ${executionSteps.request_meta} -> 'extras' -> 'prepared_request_review'
      `,
      held: sql<{ url?: string; key?: string; body?: unknown } | null>`(
        select el -> ${executionSteps.step_key} -> 'held_request'
        from jsonb_array_elements(${executionSteps.output_preview}) el
        where jsonb_typeof(${executionSteps.output_preview}) = 'array'
          and jsonb_exists(el, ${executionSteps.step_key})
        limit 1
      )`,
      execution_id: executionSteps.execution_id,
      at: executions.created_at,
    })
    .from(executionSteps)
    .innerJoin(executions, eq(executions.id, executionSteps.execution_id))
    .where(
      and(
        eq(executionSteps.tenant_id, tenant_id),
        eq(executions.workflow_id, workflow_id),
        sql`(${executionSteps.status} = 'succeeded' OR ${executionSteps.request_meta} ->> 'refused' = 'true')`,
        isNotNull(executionSteps.request_meta),
        sql`regexp_replace(${executionSteps.step_key}, '\\[[0-9]+\\]$', '') = ANY(${sql.param(step_ids as string[])}::text[])`,
      ),
    )
    .orderBy(desc(executions.created_at))
    .limit(EVIDENCE_ROWS);
  for (const row of rows) {
    if (
      !row.url &&
      !row.key &&
      !row.prefix &&
      !row.held?.url &&
      !row.held?.key &&
      !row.prepared?.url
    )
      continue;
    const list = byStep.get(row.step_key);
    if (list) list.push(row);
    else byStep.set(row.step_key, [row]);
  }
  return byStep;
}

function splitQueryFromPath(
  authored: string,
): { path: string; query: Record<string, string> } | null {
  const cut = authored.indexOf("?");
  if (cut < 0) return null;
  const path = authored.slice(0, cut);
  if (/[?#%\\]/.test(path)) return null;
  const query: Record<string, string> = {};
  for (const pair of authored.slice(cut + 1).split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) return null;
    const key = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (key.includes("${") || (value.includes("${") && !/^\$\{[^}]+\}$/.test(value))) return null;
    if (key in query) return null;
    query[key] = value;
  }
  return Object.keys(query).length > 0 ? { path, query } : null;
}

function verifiedAgainst(
  rewrite: { path: string; query: Record<string, string> },
  parts: Array<string | { var: string }>,
  seen: readonly Observation[],
): boolean {
  const literal = Object.entries(rewrite.query).filter(([, value]) => !value.includes("${"));
  const varKeys = Object.entries(rewrite.query).filter(([, value]) => value.includes("${"));
  for (const entry of seen) {
    const raw = entry.url ?? entry.held?.url ?? entry.prepared?.url;
    if (!raw) continue;
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (!alignFromEnd(parts, raw)) continue;
    const keys = [...url.searchParams.keys()].sort();
    const expected = Object.keys(rewrite.query).sort();
    if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) continue;
    if (literal.some(([key, value]) => url.searchParams.get(key) !== value)) continue;
    if (varKeys.some(([key]) => !url.searchParams.has(key))) continue;
    return true;
  }
  return false;
}

function template(path: string): Array<string | { var: string }> | null {
  if (/[?#%\\]/.test(path)) return null;
  const parts: Array<string | { var: string }> = [];
  for (const part of path.split("/")) {
    const whole = /^\$\{([^}]+)\}$/.exec(part);
    if (whole?.[1]) parts.push({ var: whole[1] });
    else if (part.includes("${")) return null;
    else parts.push(part);
  }
  return parts;
}

function alignFromEnd(
  parts: Array<string | { var: string }>,
  url: string,
): Map<string, string> | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const actual = pathname.split("/");
  const tail = parts.filter((part, index) => index > 0 || part !== "");
  if (tail.length === 0 || tail.length > actual.length) return null;
  const offset = actual.length - tail.length;
  if (offset > 0 && typeof tail[0] !== "string") return null;
  const values = new Map<string, string>();
  for (const [index, part] of tail.entries()) {
    const seen = actual[offset + index] ?? "";
    if (typeof part === "string") {
      if (part !== seen) return null;
    } else values.set(part.var, seen);
  }
  return values;
}

function wholePathValue(parts: Array<string | { var: string }>, url: string): string | null {
  const tail = parts.filter((part, index) => index > 0 || part !== "");
  const only = tail.length === 1 ? tail[0] : undefined;
  if (only === undefined || typeof only === "string") return null;
  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function ruleFor(values: readonly string[]): { enum: string[] } | { class: string } | null {
  const distinct = [...new Set(values)].sort();
  if (distinct.length === 0 || distinct.some((value) => value.length === 0)) return null;
  for (const name of CLASS_ORDER) {
    if (distinct.every((value) => VALUE_CLASSES[name].test(value))) return { class: name };
  }
  if (distinct.length > MAX_ENUM || distinct.some((value) => /[/?#%\\]/.test(value))) return null;
  return { enum: distinct };
}

function commonPrefix(keys: readonly string[]): string | null {
  if (keys.length === 0) return null;
  const first = keys[0] ?? "";
  let end = first.length;
  for (const key of keys) {
    let index = 0;
    while (index < end && index < key.length && key[index] === first[index]) index += 1;
    end = index;
  }
  const cut = first.slice(0, end).lastIndexOf("/");
  return cut < 0 ? null : first.slice(0, cut + 1);
}

function bodyCeiling(bytes: number): number {
  return Math.min(10_000_000, Math.max(1024, Math.ceil((bytes * 2) / 1024) * 1024));
}

function derivedPageCap(
  step: RequestStep,
  seen: readonly Observation[],
): number | null | undefined {
  if (!step.pagination || step.pagination.max_pages !== undefined) return undefined;
  const pages = seen.flatMap((entry) => (entry.pages && entry.pages > 0 ? [entry.pages] : []));
  if (pages.length === 0) return null;
  return Math.min(1000, Math.max(5, Math.max(...pages) * 2));
}

function derivedCallCap(seen: readonly Observation[]): number {
  const perRun = new Map<string, number>();
  for (const entry of seen) {
    perRun.set(entry.execution_id, (perRun.get(entry.execution_id) ?? 0) + 1);
  }
  const busiest = Math.max(0, ...perRun.values());
  return Math.min(10_000, Math.max(1, busiest * 2));
}

function proposeRequestStep(
  step: RequestStep,
  seen: readonly Observation[],
  base_url: string | null,
): ProposedStepBoundary | UnproposableStep["reason"] {
  if (step.boundary !== undefined) {
    const cap = derivedPageCap(step, seen);
    if (cap === null) return "no_history";
    if (cap === undefined) return "not_supported";
    const newest = seen.find((entry) => entry.url) ?? seen[0];
    return {
      step_id: step.id,
      max_pages: cap,
      evidence: {
        observations: seen.filter((entry) => entry.pages).length,
        sample: (newest?.url ?? "").slice(0, 300),
        newest_at: (newest?.at ?? new Date()).toISOString(),
      },
    };
  }
  const authored = step.path ?? step.url;
  if (!authored || (step.path !== undefined && step.url !== undefined)) return "not_supported";
  const rewrite = template(authored) ? null : splitQueryFromPath(authored);
  const parts = template(rewrite?.path ?? authored);
  if (!parts) return "path_not_comparable";
  if (rewrite && !verifiedAgainst(rewrite, parts, seen)) return "path_not_comparable";
  const urls = seen.flatMap((entry) => {
    const url = entry.url ?? entry.held?.url ?? entry.prepared?.url;
    return url ? [{ ...entry, url }] : [];
  });
  if (urls.length === 0) return "no_history";
  const collected = new Map<string, string[]>();
  for (const part of parts) if (typeof part !== "string") collected.set(part.var, []);
  for (const value of Object.values(step.query ?? {}))
    if (typeof value === "string" && value.includes("${")) return "not_supported";
  for (const [key, value] of Object.entries(rewrite?.query ?? {})) {
    const whole = /^\$\{([^}]+)\}$/.exec(value);
    if (whole?.[1]) collected.set(whole[1], []);
    void key;
  }
  const queryVars = new Map(
    Object.entries(rewrite?.query ?? {}).flatMap(([key, value]) => {
      const whole = /^\$\{([^}]+)\}$/.exec(value);
      return whole?.[1] ? [[key, whole[1]] as const] : [];
    }),
  );
  const wholePathVar = (() => {
    const tail = parts.filter((part, index) => index > 0 || part !== "");
    const only = tail.length === 1 ? tail[0] : undefined;
    return only !== undefined && typeof only !== "string" ? only.var : null;
  })();
  if (wholePathVar) {
    const baseDepth = (() => {
      try {
        return base_url ? new URL(base_url).pathname.split("/").filter(Boolean).length : 0;
      } catch {
        return null;
      }
    })();
    if (baseDepth === null || baseDepth > 0) return "not_supported";
    const observed = urls.flatMap((entry) => {
      const value = wholePathValue(parts, entry.url as string);
      return value === null ? [] : [value];
    });
    if (observed.length === 0) return "path_not_comparable";
    if (!observed.every((value) => pathValueAllowed(value))) return "values_not_describable";
    const newestWhole = urls[0] as Observation;
    return {
      step_id: step.id,
      ...(rewrite ? { path_rewrite: rewrite } : {}),
      boundary: {
        variables: { [wholePathVar]: { class: "path" } },
        max_body_bytes: 0,
        max_calls: derivedCallCap(seen),
      },
      evidence: {
        observations: observed.length,
        sample: (newestWhole.url ?? "").slice(0, 300),
        newest_at: newestWhole.at.toISOString(),
      },
    };
  }
  let comparable = 0;
  for (const entry of urls) {
    const values = alignFromEnd(parts, entry.url as string);
    if (!values) continue;
    comparable += 1;
    for (const [name, value] of values) collected.get(name)?.push(value);
    if (queryVars.size === 0) continue;
    try {
      const search = new URL(entry.url as string).searchParams;
      for (const [key, name] of queryVars) {
        const seenValue = search.get(key);
        if (seenValue !== null) collected.get(name)?.push(seenValue);
      }
    } catch {}
  }
  if (comparable === 0) return "path_not_comparable";
  const variables: Record<string, { enum: string[] } | { class: string }> = {};
  for (const [name, values] of collected) {
    const rule = ruleFor(values);
    if (!rule) return "values_not_describable";
    variables[name] = rule;
  }
  const method = (step.method ?? "GET").toUpperCase();
  const sent = seen.flatMap((entry) => {
    if (entry.bytes && entry.bytes > 0) return [entry.bytes];
    if (entry.held?.body !== undefined) return [JSON.stringify(entry.held.body)?.length ?? 0];
    if (entry.prepared?.body_bytes !== undefined) return [entry.prepared.body_bytes];
    if (entry.prepared?.redacted_request_json === undefined) return [];
    try {
      const review = JSON.parse(entry.prepared.redacted_request_json) as { body?: unknown };
      return review.body === undefined || review.body === null
        ? []
        : [JSON.stringify(review.body)?.length ?? 0];
    } catch {
      return [];
    }
  });
  const body =
    step.body === undefined || method === "GET" || method === "HEAD"
      ? 0
      : sent.length === 0
        ? null
        : bodyCeiling(Math.max(...sent));
  if (body === null) return "body_size_unknown";
  const newest = urls[0] as Observation;
  const cap = derivedPageCap(step, seen);
  if (cap === null) return "no_history";
  return {
    step_id: step.id,
    ...(cap === undefined ? {} : { max_pages: cap }),
    ...(rewrite ? { path_rewrite: rewrite } : {}),
    boundary: { variables, max_body_bytes: body, max_calls: derivedCallCap(seen) },
    evidence: {
      observations: comparable,
      sample: (newest.url ?? "").slice(0, 300),
      newest_at: newest.at.toISOString(),
    },
  };
}

function proposeStorageStep(
  step: RequestStep,
  seen: readonly Observation[],
): ProposedStepBoundary | UnproposableStep["reason"] {
  const keys = seen.flatMap((entry) =>
    entry.key ? [entry.key] : entry.held?.key ? [entry.held.key] : [],
  );
  const prefixes = seen.flatMap((entry) => (entry.prefix ? [entry.prefix] : []));
  if (keys.length === 0 && prefixes.length === 0) return "no_history";
  const key_prefix =
    keys.length > 0 ? commonPrefix(keys) : commonPrefix(prefixes.map((p) => `${p}x`));
  if (!key_prefix) return "values_not_describable";
  const declared = step.s3?.scope;
  const written = seen.flatMap((entry) => (entry.bytes && entry.bytes > 0 ? [entry.bytes] : []));
  const folderFits =
    declared === undefined ||
    [...keys, ...prefixes].every((value) => value.startsWith(declared.key_prefix));
  const ceilingFits =
    declared === undefined || written.length === 0 || Math.max(...written) <= declared.max_bytes;
  if (declared !== undefined && folderFits && ceilingFits) return "not_supported";
  const newest = seen.find((entry) => entry.key || entry.prefix || entry.held?.key) as Observation;
  const isWrite = (step.method ?? "GET").toUpperCase() === "PUT";
  if (isWrite && written.length === 0) return "body_size_unknown";
  return {
    step_id: step.id,
    s3_scope: {
      key_prefix: folderFits && declared ? declared.key_prefix : key_prefix,
      max_bytes:
        written.length > 0
          ? bodyCeiling(Math.max(...written))
          : (declared?.max_bytes ?? bodyCeiling(1024)),
    },
    evidence: {
      observations: keys.length + prefixes.length,
      sample: (newest.key ?? newest.prefix ?? "").slice(0, 300),
      newest_at: newest.at.toISOString(),
    },
  };
}

export async function proposeBoundaries(
  db: Executor,
  params: { tenant_id: string; workflow_id: string; definition: WorkflowDef },
): Promise<BoundaryProposals> {
  const open = params.definition.steps.flatMap((step) =>
    step.kind === "request" &&
    ((step.boundary === undefined && step.s3?.scope === undefined) ||
      step.s3?.scope !== undefined ||
      (step.pagination !== undefined && step.pagination.max_pages === undefined))
      ? [step]
      : [],
  );
  const seen = await observations(
    db,
    params.tenant_id,
    params.workflow_id,
    open.map((step) => step.id),
  );
  const connectorIds = [
    ...new Set(open.flatMap((step) => (step.connector_id ? [step.connector_id] : []))),
  ];
  const baseUrls = new Map<string, string | null>(
    connectorIds.length
      ? (
          await db
            .select({ id: connectors.id, base_url: connectors.base_url })
            .from(connectors)
            .where(
              and(eq(connectors.tenant_id, params.tenant_id), inArray(connectors.id, connectorIds)),
            )
        ).map((row) => [row.id, row.base_url])
      : [],
  );
  const connectorBase = (step: RequestStep, table: Map<string, string | null>) =>
    step.connector_id ? (table.get(step.connector_id) ?? null) : null;
  const proposals: ProposedStepBoundary[] = [];
  const unproposable: UnproposableStep[] = [];
  for (const step of open) {
    const history = seen.get(step.id) ?? [];
    const result = step.s3
      ? proposeStorageStep(step, history)
      : step.sql || step.mcp || step.graphql || step.xml || step.multipart
        ? "not_supported"
        : proposeRequestStep(step, history, connectorBase(step, baseUrls));
    if (typeof result === "string") unproposable.push({ step_id: step.id, reason: result });
    else proposals.push(result);
  }
  return { proposals, unproposable };
}
