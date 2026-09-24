// What SubKit can work out for itself about where a step goes.
//
// A scheduled workflow is held until a human approves its effects, and an
// effect can only be approved when its step says where it may go. Until now,
// "says where it may go" meant a person writing a `boundary` or an `s3.scope`
// by hand — for a workflow of twenty steps, twenty times, in a chat, through a
// model that paraphrases. The approval dialog's honest answer was "SubKit
// cannot yet check the allowed actions of this flow; investigate the cause in
// the chat", which is a technical question handed to the one person who cannot
// answer it. Three production workflows stood blocked behind that sentence.
//
// The runtime already knows the answer. Every dispatched request records the
// URL it resolved to, and every storage request the key it wrote; that history
// is the same evidence `boundary-evidence.ts` uses to catch a declared folder
// that lies. Read in the other direction it PROPOSES: this step has been
// reading `…/v1/pages/<uuid>` for months, so the folder is `/v1/pages/` and the
// value is a uuid.
//
// Two rules keep a proposal honest:
//
//   1. Nothing is derived from a name, a guess, or a shape that "looks like"
//      something. Every proposed rule is the narrowest one that covers values
//      this very step really sent, under this very workflow.
//   2. A proposal is never applied to what runs. It becomes a new DRAFT the
//      human reviews and puts into service — the same gate as before, with the
//      typing removed.
//
// Where the evidence is missing or contradictory, this returns a reason instead
// of a boundary. A proposal nobody can justify is the defect this product keeps
// paying for.

import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { executionSteps, executions } from "../db/schema/index.ts";
import { VALUE_CLASSES } from "./request-boundary.ts";
import type { RequestStep, WorkflowDef } from "./types.ts";

/** Widest last: the first class that covers every observed value wins. */
const CLASS_ORDER = ["uuid", "timestamp", "date", "integer", "file_name", "identifier"] as const;

/** How many distinct values may be listed before a class is required instead. */
const MAX_ENUM = 12;
/** How far back the evidence is read. One row per dispatch, newest first. */
const EVIDENCE_ROWS = 2000;

export interface ProposedStepBoundary {
  step_id: string;
  /**
   * A page cap for a step that paginates without one. Without it the number of
   * requests a run makes is not a number anyone can review, and the boundary
   * compiler refuses the step — a refusal no amount of authoring the boundary
   * itself can clear, because the extra requests come from the engine.
   */
  max_pages?: number;
  /** For an HTTP request step: what to write into `boundary`. */
  boundary?: {
    variables: Record<string, { enum: string[] } | { class: string }>;
    max_body_bytes: number;
    max_calls: number;
  };
  /** For a storage step: what to write into `s3.scope`. */
  s3_scope?: { key_prefix: string; max_bytes: number };
  /** What the proposal was read from, so a reviewer can weigh it. */
  evidence: { observations: number; sample: string; newest_at: string };
}

export interface UnproposableStep {
  step_id: string;
  /** Why nothing could be derived. Never a guess dressed as a boundary. */
  reason:
    | "no_history"
    | "path_not_comparable"
    | "values_not_describable"
    | "body_size_unknown"
    | "not_supported";
}

export interface BoundaryProposals {
  proposals: ProposedStepBoundary[];
  unproposable: UnproposableStep[];
}

/** One dispatch this workflow really made, as the runtime recorded it. */
interface Observation {
  step_key: string;
  url: string | null;
  key: string | null;
  /** How many pages this dispatch actually read, when it paginated. */
  pages: number | null;
  /**
   * The request a HELD step would have sent. A preview holds every write, so a
   * step that has only ever been previewed records no dispatch — but it does
   * record what it resolved to, target and content both. That is evidence of
   * the same quality: it is what this step addresses, decided by the same
   * resolver, and for a write it is the only place its size is written down.
   */
  held: { url?: string; key?: string; body?: unknown } | null;
  /** The same evidence from a preparation run, which records it differently. */
  prepared: { url?: string; redacted_request_json?: string } | null;
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
      // A step inside a loop records `read_page[6]`, one per iteration. Matching
      // the bare id found nothing for exactly the steps that run most often —
      // `list_raw` and twelve `read_page[…]` rows sat in the history while the
      // derivation reported "never ran".
      step_key: sql<string>`regexp_replace(${executionSteps.step_key}, '\\[[0-9]+\\]$', '')`,
      url: sql<string | null>`${executionSteps.request_meta} ->> 'url'`,
      key: sql<string | null>`${executionSteps.request_meta} ->> 'key'`,
      pages: sql<
        number | null
      >`nullif(${executionSteps.request_meta} ->> 'pages_fetched', '')::int`,
      // The SAME fact in two places, because two paths write it: a dry-run
      // preview leaves `held_request` in the result envelope, and the
      // preparation run the approval dialog triggers leaves
      // `prepared_request_review` in the request metadata. Reading only one of
      // them meant the run a reviewer had just been asked to perform produced
      // evidence this derivation could not see.
      prepared: sql<{ url?: string; redacted_request_json?: string } | null>`
        ${executionSteps.request_meta} -> 'extras' -> 'prepared_request_review'
      `,
      held: sql<{ url?: string; key?: string; body?: unknown } | null>`(
        select el -> ${executionSteps.step_key} -> 'held_request'
        from jsonb_array_elements(${executionSteps.output_preview}) el
        where jsonb_typeof(${executionSteps.output_preview}) = 'array'
          and jsonb_exists(el, ${executionSteps.step_key})
        limit 1
      )`,
      at: executions.created_at,
    })
    .from(executionSteps)
    .innerJoin(executions, eq(executions.id, executionSteps.execution_id))
    .where(
      and(
        eq(executionSteps.tenant_id, tenant_id),
        eq(executions.workflow_id, workflow_id),
        eq(executionSteps.status, "succeeded"),
        isNotNull(executionSteps.request_meta),
        sql`regexp_replace(${executionSteps.step_key}, '\\[[0-9]+\\]$', '') = ANY(${sql.param(step_ids as string[])}::text[])`,
      ),
    )
    .orderBy(desc(executions.created_at))
    .limit(EVIDENCE_ROWS);
  for (const row of rows) {
    if (!row.url && !row.key && !row.held?.url && !row.held?.key && !row.prepared?.url) continue;
    const list = byStep.get(row.step_key);
    if (list) list.push(row);
    else byStep.set(row.step_key, [row]);
  }
  return byStep;
}

/**
 * The authored path split the way the boundary compiler splits it, but keeping
 * only what this module needs: which positions vary and under which name.
 * A placeholder that is not a whole segment cannot be proposed for — the
 * compiler would refuse it too, and saying so is better than half a rule.
 */
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

/**
 * The concrete value each placeholder took, aligned from the RIGHT.
 *
 * A connector's base path may or may not be repeated in the authored path, and
 * the resolver dedupes it — so the recorded URL and the template agree on their
 * tail, never reliably on their head. Aligning from the end uses only what both
 * certainly share, and a template longer than the URL is simply not comparable.
 */
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
  const values = new Map<string, string>();
  for (const [index, part] of tail.entries()) {
    const seen = actual[offset + index] ?? "";
    if (typeof part === "string") {
      if (part !== seen) return null;
    } else values.set(part.var, seen);
  }
  return values;
}

/** The narrowest rule that covers every value this step really sent. */
function ruleFor(values: readonly string[]): { enum: string[] } | { class: string } | null {
  const distinct = [...new Set(values)].sort();
  if (distinct.length === 0 || distinct.some((value) => value.length === 0)) return null;
  for (const name of CLASS_ORDER) {
    if (distinct.every((value) => VALUE_CLASSES[name].test(value))) return { class: name };
  }
  // No class covers them: list what was seen, as long as that is a list a
  // person can read. Values carrying `/`, `?` or `%` are not a path segment.
  if (distinct.length > MAX_ENUM || distinct.some((value) => /[/?#%\\]/.test(value))) return null;
  return { enum: distinct };
}

/** The deepest folder that contains every key this step really touched. */
function commonPrefix(keys: readonly string[]): string | null {
  if (keys.length === 0) return null;
  const first = keys[0] ?? "";
  let end = first.length;
  for (const key of keys) {
    let index = 0;
    while (index < end && index < key.length && key[index] === first[index]) index += 1;
    end = index;
  }
  // Cut back to a folder: half a file name is not a folder, and a prefix that
  // ends inside a name would admit every sibling that shares those letters.
  const cut = first.slice(0, end).lastIndexOf("/");
  return cut < 0 ? null : first.slice(0, cut + 1);
}

/** Rounded up to whole kilobytes, with headroom, so one longer run is not a refusal. */
function bodyCeiling(bytes: number): number {
  return Math.min(10_000_000, Math.max(1024, Math.ceil((bytes * 2) / 1024) * 1024));
}

/**
 * How many pages one run may read, from how many it really read.
 *
 * `undefined` when the step needs no cap, `null` when it needs one and nothing
 * ever counted pages — a number nobody measured is exactly the kind of
 * plausible value this module exists not to produce.
 */
function derivedPageCap(
  step: RequestStep,
  seen: readonly Observation[],
): number | null | undefined {
  if (!step.pagination || step.pagination.max_pages !== undefined) return undefined;
  const pages = seen.flatMap((entry) => (entry.pages && entry.pages > 0 ? [entry.pages] : []));
  if (pages.length === 0) return null;
  return Math.min(1000, Math.max(5, Math.max(...pages) * 2));
}

function proposeRequestStep(
  step: RequestStep,
  seen: readonly Observation[],
): ProposedStepBoundary | UnproposableStep["reason"] {
  // A boundary a person already reviewed is theirs. When such a step is here it
  // is here for its page cap alone, and nothing else about it is touched.
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
  const parts = template(authored);
  if (!parts) return "path_not_comparable";
  const urls = seen.flatMap((entry) => {
    const url = entry.url ?? entry.held?.url ?? entry.prepared?.url;
    return url ? [{ ...entry, url }] : [];
  });
  if (urls.length === 0) return "no_history";
  const collected = new Map<string, string[]>();
  for (const part of parts) if (typeof part !== "string") collected.set(part.var, []);
  // A query placeholder is a second position for the same value; proposing for
  // it needs the recorded query, which the runtime stores only as key names.
  for (const value of Object.values(step.query ?? {}))
    if (typeof value === "string" && value.includes("${")) return "not_supported";
  let comparable = 0;
  for (const entry of urls) {
    const values = alignFromEnd(parts, entry.url as string);
    if (!values) continue;
    comparable += 1;
    for (const [name, value] of values) collected.get(name)?.push(value);
  }
  if (comparable === 0) return "path_not_comparable";
  const variables: Record<string, { enum: string[] } | { class: string }> = {};
  for (const [name, values] of collected) {
    const rule = ruleFor(values);
    if (!rule) return "values_not_describable";
    variables[name] = rule;
  }
  const method = (step.method ?? "GET").toUpperCase();
  // A body's size is not recorded, so a step that sends content cannot be given
  // a ceiling from evidence. A dispatched request does not record how large its
  // body was; a HELD one records the body itself, which is what a preview
  // leaves behind. Without either, no ceiling — an invented number refuses a
  // real run later, and that refusal looks like the workflow's fault.
  const sent = seen.flatMap((entry) => {
    if (entry.held?.body !== undefined) return [JSON.stringify(entry.held.body)?.length ?? 0];
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
  // Read from what this step really fetched, with headroom, so a slightly
  // larger week is not a refused run. A step that paginates and has never
  // recorded a page count stays unproposable rather than getting a number
  // nobody measured.
  const cap = derivedPageCap(step, seen);
  if (cap === null) return "no_history";
  return {
    step_id: step.id,
    ...(cap === undefined ? {} : { max_pages: cap }),
    boundary: { variables, max_body_bytes: body, max_calls: 1 },
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
  if (keys.length === 0) return "no_history";
  const key_prefix = commonPrefix(keys);
  if (!key_prefix) return "values_not_describable";
  // A declared folder that every observed key sits inside is the author's, and
  // stays theirs. Only a folder the step's own writes CONTRADICT is corrected —
  // one production workflow declared its sibling's folder and was refused
  // nightly, with the real key on every refusing row.
  const declared = step.s3?.scope?.key_prefix;
  if (declared !== undefined && keys.every((key) => key.startsWith(declared)))
    return "not_supported";
  const newest = seen.find((entry) => entry.key || entry.held?.key) as Observation;
  return {
    step_id: step.id,
    // The ceiling is the same shape the storage boundary already demands. It
    // bounds size, not content — the dialog says that in its own words.
    s3_scope: { key_prefix, max_bytes: bodyCeiling(64 * 1024) },
    evidence: {
      observations: keys.length,
      sample: (newest.key ?? "").slice(0, 300),
      newest_at: newest.at.toISOString(),
    },
  };
}

/**
 * What SubKit would declare for the steps of this version that declare nothing.
 *
 * Steps that already carry a boundary are left alone: a human approved that
 * text, and replacing it from history would quietly move a reviewed rule.
 */
export async function proposeBoundaries(
  db: Executor,
  params: { tenant_id: string; workflow_id: string; definition: WorkflowDef },
): Promise<BoundaryProposals> {
  // Three ways a step can be missing what it needs: it declares no limit at
  // all; it paginates without a page cap — which refuses the step even when its
  // boundary is perfect, because the extra requests come from the engine; or it
  // declares a folder its own writes contradict. The third is not a reviewed
  // choice being protected, it is a demonstrably wrong statement: the step is
  // refused on every run, and the key it really wrote is on the row that
  // refused it.
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
  const proposals: ProposedStepBoundary[] = [];
  const unproposable: UnproposableStep[] = [];
  for (const step of open) {
    const history = seen.get(step.id) ?? [];
    const result = step.s3
      ? proposeStorageStep(step, history)
      : step.sql || step.mcp || step.graphql || step.xml || step.multipart
        ? "not_supported"
        : proposeRequestStep(step, history);
    if (typeof result === "string") unproposable.push({ step_id: step.id, reason: result });
    else proposals.push(result);
  }
  return { proposals, unproposable };
}
