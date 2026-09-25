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

import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Executor } from "../db/client.ts";
import { connectors, executionSteps, executions } from "../db/schema/index.ts";
import { pathValueAllowed, VALUE_CLASSES } from "./request-boundary.ts";
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
  /**
   * The same request, written so it can be reviewed: the query moved out of the
   * path. Offered only when an URL this step really sent proves the two forms
   * agree.
   */
  path_rewrite?: { path: string; query: Record<string, string> };
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
  /** How large this write really was, measured by the runtime. */
  bytes: number | null;
  /** The folder a listing really read. A LIST records this instead of a key. */
  prefix: string | null;
  /**
   * The request a HELD step would have sent. A preview holds every write, so a
   * step that has only ever been previewed records no dispatch — but it does
   * record what it resolved to, target and content both. That is evidence of
   * the same quality: it is what this step addresses, decided by the same
   * resolver, and for a write it is the only place its size is written down.
   */
  held: { url?: string; key?: string; body?: unknown } | null;
  /** The same evidence from a preparation run, which records it differently. */
  prepared: { url?: string; redacted_request_json?: string; body_bytes?: number } | null;
  /** Which run this dispatch belonged to. Several rows of one run are what
   *  makes a per-run request count derivable at all. */
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
      bytes: sql<number | null>`nullif(${executionSteps.request_meta} ->> 'bytes_out', '')::int`,
      prefix: sql<string | null>`${executionSteps.request_meta} ->> 'prefix'`,
      // The SAME fact in two places, because two paths write it: a dry-run
      // preview leaves `held_request` in the result envelope, and the
      // preparation run the approval dialog triggers leaves
      // `prepared_request_review` in the request metadata. Reading only one of
      // them meant the run a reviewer had just been asked to perform produced
      // evidence this derivation could not see.
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
        // A refused write is the strongest evidence there is: the runtime
        // measured the content and refused it BECAUSE the declared scope does
        // not cover it. Reading only successful rows meant the one row that
        // proves the contradiction was the one row excluded — and the step
        // that can never succeed until it is fixed could never be fixed.
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

/**
 * The authored path split the way the boundary compiler splits it, but keeping
 * only what this module needs: which positions vary and under which name.
 * A placeholder that is not a whole segment cannot be proposed for — the
 * compiler would refuse it too, and saying so is better than half a rule.
 */
/**
 * A step whose query sits INSIDE its path, split into the two fields the
 * dispatcher and the boundary compiler both expect.
 *
 * `/startups?page=${item.n}&limit=10` is the same request as
 * `path: "/startups"` with `query: {page: "${item.n}", limit: "10"}` — but only
 * the second form can be reviewed, because a boundary states a target and an
 * exact key set, and a `?` inside the path is neither. The compiler refuses the
 * first form outright, and the remedy has always said what to do; a person had
 * to do it by hand, in a chat, through a model that paraphrases.
 *
 * This is a rewrite of the definition, not of what it may do, so it is held to
 * a harder rule than a boundary: `verifiedAgainst` must find an URL this step
 * really sent that the rewritten form reproduces exactly. Same path, same keys,
 * same values. Anything less and no rewrite is offered.
 */
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
    // A key that varies, or text around a placeholder, cannot be held to a
    // rule — the compiler refuses both, so proposing them would be theatre.
    if (key.includes("${") || (value.includes("${") && !/^\$\{[^}]+\}$/.test(value))) return null;
    if (key in query) return null;
    query[key] = value;
  }
  return Object.keys(query).length > 0 ? { path, query } : null;
}

/**
 * True when the rewritten form reproduces a request this step really sent.
 * The one guard that makes a definition rewrite safe to offer.
 */
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
    // A placeholder key only has to be PRESENT: its value is what the rule
    // bounds, and that rule is derived from these same observations.
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
  // The URL is deeper than the template, and the template opens with a
  // variable. That variable did not take the one segment sitting at this
  // offset — it took all of them, and reading only the last is how a step whose
  // real value was `/blog/a` gets proposed a rule fitting `a`. The boundary
  // would pass review and the step would be refused at dispatch, with the
  // refusal reading as the workflow's fault. A whole-path template is handled
  // by `wholePathValues`; anything else is not comparable, which is the honest
  // answer rather than a narrower one.
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

/**
 * The whole path a single-placeholder template really took.
 *
 * `path: "${item.path}"` is one variable standing for the entire address, so
 * there is nothing to align: the value IS the pathname. Kept apart from
 * `alignFromEnd` because the two answer different questions, and letting one
 * fall into the other is precisely the narrowing above.
 */
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

/**
 * How many requests one run may make, from how many it really made.
 *
 * `1` was hardcoded. For a step inside a `for_each` over thirty targets that is
 * a boundary the step breaks on its first real run — and it was presented as
 * derived from evidence, which is the part that matters: a number nobody
 * measured, wearing the clothes of one that was.
 *
 * Counted per run, because that is what `max_calls` bounds. Doubled, so a
 * slightly larger week is not a refusal, and floored at 1 for a step that
 * genuinely dispatches once. A step with no history keeps 1: there is nothing
 * to derive, and 1 is the narrowest honest answer rather than a guess upward.
 */
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
  // A query inside the path is the same request written in a form no boundary
  // can describe. Rewriting it is offered only when an URL this step really
  // sent proves the two forms agree.
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
  // A query placeholder is a second position for the same value; proposing for
  // it needs the recorded query, which the runtime stores only as key names.
  // A rewrite brings its own, and those ARE derivable from the same URLs.
  for (const value of Object.values(step.query ?? {}))
    if (typeof value === "string" && value.includes("${")) return "not_supported";
  for (const [key, value] of Object.entries(rewrite?.query ?? {})) {
    const whole = /^\$\{([^}]+)\}$/.exec(value);
    if (whole?.[1]) collected.set(whole[1], []);
    void key;
  }
  // A rewritten query's placeholders are bounded by the same evidence: the
  // value that key really carried, read off the same URLs.
  const queryVars = new Map(
    Object.entries(rewrite?.query ?? {}).flatMap(([key, value]) => {
      const whole = /^\$\{([^}]+)\}$/.exec(value);
      return whole?.[1] ? [[key, whole[1]] as const] : [];
    }),
  );
  // A template that is one placeholder and nothing else varies the WHOLE path.
  // Derived here rather than through `ruleFor`, which only knows segments:
  // falling through to it produced `values_not_describable` on a step that is
  // perfectly describable, and before that a rule fitting one segment of a
  // value that was never one segment.
  const wholePathVar = (() => {
    const tail = parts.filter((part, index) => index > 0 || part !== "");
    const only = tail.length === 1 ? tail[0] : undefined;
    return only !== undefined && typeof only !== "string" ? only.var : null;
  })();
  if (wholePathVar) {
    // `resolveUrl` strips a base path the author repeated, and that decision
    // must rest on literals only — so a whole-path placeholder cannot sit
    // under a connector whose base carries a path. The compiler refuses such a
    // boundary with `variable_in_base_prefix`; proposing one anyway would hand
    // a reviewer a statement the engine will not accept.
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
    } catch {
      // An URL that will not parse contributed nothing above either.
    }
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
    // Measured at dispatch when the request really went out; from the held
    // request when a preview resolved it but sent nothing.
    if (entry.bytes && entry.bytes > 0) return [entry.bytes];
    if (entry.held?.body !== undefined) return [JSON.stringify(entry.held.body)?.length ?? 0];
    // The size is recorded even when the content is deliberately not: an
    // opaque body may carry credentials, its length may not.
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
  // Read from what this step really fetched, with headroom, so a slightly
  // larger week is not a refused run. A step that paginates and has never
  // recorded a page count stays unproposable rather than getting a number
  // nobody measured.
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
  // A listing records the folder it read, under `prefix`, because it addresses
  // no single object. Reading only `key` meant every LIST and HEAD step looked
  // as if it had never run — and those are exactly the steps whose folder is
  // written down most plainly.
  const prefixes = seen.flatMap((entry) => (entry.prefix ? [entry.prefix] : []));
  if (keys.length === 0 && prefixes.length === 0) return "no_history";
  // A refused write is evidence too — the strongest kind. The step is refused
  // BECAUSE its declared scope is too small, so a rule that only reads
  // successful writes can never see the contradiction that causes the refusal.
  // A prefix IS a folder already; a key has to be cut back to one.
  const key_prefix =
    keys.length > 0 ? commonPrefix(keys) : commonPrefix(prefixes.map((p) => `${p}x`));
  if (!key_prefix) return "values_not_describable";
  // A declared scope the step's own history fits is the author's and stays
  // theirs. Only one its writes CONTRADICT is corrected — and a scope has two
  // halves that can be contradicted. One production workflow declared its
  // sibling's FOLDER and was refused nightly with the real key on every
  // refusing row; another declared a CEILING below what it really writes and
  // was refused for the same reason, in the same place, with the real size in
  // the same message.
  const declared = step.s3?.scope;
  const written = seen.flatMap((entry) => (entry.bytes && entry.bytes > 0 ? [entry.bytes] : []));
  const folderFits =
    declared === undefined ||
    [...keys, ...prefixes].every((value) => value.startsWith(declared.key_prefix));
  const ceilingFits =
    declared === undefined || written.length === 0 || Math.max(...written) <= declared.max_bytes;
  if (declared !== undefined && folderFits && ceilingFits) return "not_supported";
  const newest = seen.find((entry) => entry.key || entry.prefix || entry.held?.key) as Observation;
  // Measured, never assumed. This was a constant — 64 KiB, chosen by nobody
  // and verified against nothing — and it refused a step that really writes
  // 337 KB on the first scheduled run after the approval. A ceiling below what
  // the step demonstrably produces is not a limit, it is a defect with a
  // number in it. Without a measurement there is no ceiling to propose.
  const isWrite = (step.method ?? "GET").toUpperCase() === "PUT";
  if (isWrite && written.length === 0) return "body_size_unknown";
  return {
    step_id: step.id,
    // Bounds size, not content — the dialog says that in its own words. The
    // folder the author declared is kept whenever it fits; only the half the
    // history contradicts is replaced.
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
  // A whole-path rule cannot sit under a connector whose base carries a path —
  // the compiler refuses that boundary outright — so the derivation has to know
  // the base before it proposes one. Read once for the steps in hand.
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
