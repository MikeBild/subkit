export interface CriticToolResult {
  tool: string;
  ok: boolean;
  outcomes: Record<string, number>;
  ids: string[];
  processed_ids: string[];
  error?: string;
}

export type ToolClaimIssueKind = "count_mismatch" | "success_after_failure" | "unprocessed_id";

export interface ToolClaimIssue {
  kind: ToolClaimIssueKind;
  detail: string;
}

type ClaimClass = "removal" | "approval";

const CLASS_OUTCOMES: Record<ClaimClass, readonly string[]> = {
  removal: ["rejected", "discarded", "deleted", "removed"],
  approval: ["approved", "accepted", "admitted"],
};

const NON_SUCCESS_OUTCOMES = [
  "not_found",
  "already_decided",
  "not_discardable",
  "changed",
  "changed_since_review",
  "failed",
  "skipped",
  "error",
] as const;

const OUTCOME_KEYS = [
  ...CLASS_OUTCOMES.removal,
  ...CLASS_OUTCOMES.approval,
  ...NON_SUCCESS_OUTCOMES,
] as const;

const CLASS_VERBS: Record<ClaimClass, string> = {
  removal:
    "verworfen|abgelehnt|entfernt|gelöscht|aussortiert|rejected|discarded|removed|deleted|dismissed",
  approval: "genehmigt|freigegeben|übernommen|angenommen|approved|accepted|admitted",
};

const TOOL_CLASS_PATTERNS: Array<{ cls: ClaimClass; re: RegExp; outcome: string }> = [
  { cls: "approval", re: /^(approve|accept|admit)_/, outcome: "approved" },
  { cls: "removal", re: /^reject_/, outcome: "rejected" },
  { cls: "removal", re: /^discard_/, outcome: "discarded" },
  { cls: "removal", re: /^(delete|remove|dismiss)_/, outcome: "deleted" },
];

const HEDGE_RE =
  /(?<![\p{L}])(nicht|kein|keine|keinen|keiner|nichts|nie|niemals|not|no|none|never|failed|fehlgeschlagen|unable|sobald|wenn|falls|once|if|when|after|würde|würden|werden|wird|will|would|soll|sollen|sollte|should|kann|können|could|can)(?![\p{L}])/iu;

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function failureOf(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.error === "string") return record.error;
  if (typeof record.error_code === "string") return record.error_code;
  if (record.ok === false) return "ok:false";
  if (record.status === "failed") return "status:failed";
  return failureOf(record.data);
}

function collectIds(value: unknown, into: Set<string>, skipItem: (item: unknown) => boolean) {
  if (typeof value === "string") {
    for (const m of value.match(UUID_RE) ?? []) into.add(m.toLowerCase());
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) if (!skipItem(item)) collectIds(item, into, skipItem);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const v of Object.values(record)) collectIds(v, into, skipItem);
}

function itemOutcome(item: unknown): string | null {
  const record = asRecord(item);
  if (!record) return null;
  for (const key of ["outcome", "kind", "status"]) {
    const v = record[key];
    if (typeof v === "string" && (OUTCOME_KEYS as readonly string[]).includes(v)) return v;
  }
  return null;
}

function isNonSuccessItem(item: unknown): boolean {
  const outcome = itemOutcome(item);
  return outcome !== null && (NON_SUCCESS_OUTCOMES as readonly string[]).includes(outcome);
}

function toolClass(tool: string): { cls: ClaimClass; outcome: string } | null {
  const hit = TOOL_CLASS_PATTERNS.find((p) => p.re.test(tool));
  return hit ? { cls: hit.cls, outcome: hit.outcome } : null;
}

export function summarizeToolResult(tool: string, output: unknown): CriticToolResult {
  const outer = asRecord(output);
  const record = outer && outer._truncated === true ? (asRecord(outer.data) ?? outer) : outer;
  const failure = failureOf(output);
  const outcomes: Record<string, number> = {};
  if (record) {
    for (const key of OUTCOME_KEYS) {
      const v = record[key];
      if (typeof v === "number" && Number.isFinite(v)) outcomes[key] = v;
    }
    if (Array.isArray(record.results)) {
      const fromItems: Record<string, number> = {};
      for (const item of record.results) {
        const outcome = itemOutcome(item);
        if (outcome) fromItems[outcome] = (fromItems[outcome] ?? 0) + 1;
      }
      for (const [k, n] of Object.entries(fromItems))
        if (outcomes[k] === undefined) outcomes[k] = n;
    }
    const single = itemOutcome(record);
    if (single && Object.keys(outcomes).length === 0) outcomes[single] = 1;
  }
  const cls = toolClass(tool);
  if (failure === null && cls && Object.keys(outcomes).length === 0) outcomes[cls.outcome] = 1;
  const ids = new Set<string>();
  collectIds(output, ids, () => false);
  const processed = new Set<string>();
  if (failure === null) collectIds(output, processed, isNonSuccessItem);
  return {
    tool,
    ok: failure === null,
    outcomes,
    ids: [...ids],
    processed_ids: [...processed],
    ...(failure !== null ? { error: failure } : {}),
  };
}

function resultsInClass(
  results: ReadonlyArray<CriticToolResult>,
  cls: ClaimClass,
): CriticToolResult[] {
  return results.filter(
    (r) =>
      toolClass(r.tool)?.cls === cls ||
      CLASS_OUTCOMES[cls].some((k) => r.outcomes[k] !== undefined),
  );
}

function outcomeSummary(results: ReadonlyArray<CriticToolResult>): string {
  const totals: Record<string, number> = {};
  for (const r of results)
    for (const [k, n] of Object.entries(r.outcomes)) totals[k] = (totals[k] ?? 0) + n;
  const parts = Object.entries(totals).map(([k, n]) => `${k}=${n}`);
  return parts.length > 0 ? parts.join(", ") : "no outcome counts";
}

function clauses(text: string): string[] {
  return text
    .split(/[.!?;,\n]+|\s[–—-]\s/u)
    .map((c) => c.trim())
    .filter(Boolean);
}

function verbRe(cls: ClaimClass, flags = "iu"): RegExp {
  return new RegExp(`(?<![\\p{L}])(?:${CLASS_VERBS[cls]})(?![\\p{L}])`, flags);
}

function countClaims(clause: string, cls: ClaimClass): number[] {
  const verbs = CLASS_VERBS[cls];
  const forward = new RegExp(
    `(?<![\\p{L}\\d.,/])(\\d{1,6})\\s+((?:[\\p{L}][\\p{L}-]*\\s+){0,3}?)(?:${verbs})(?![\\p{L}])`,
    "giu",
  );
  const backward = new RegExp(
    `(?<![\\p{L}])(?:${verbs})(?:\\s*:\\s*|\\s+)(\\d{1,6})(?![\\d.,/])`,
    "giu",
  );
  const out: number[] = [];
  for (const m of clause.matchAll(forward)) {
    const before = clause.slice(0, m.index ?? 0);
    if (/(?:von|of|aus|\/)\s*$/iu.test(before)) continue;
    out.push(Number.parseInt(m[1] ?? "", 10));
  }
  for (const m of clause.matchAll(backward)) out.push(Number.parseInt(m[1] ?? "", 10));
  return out;
}

export function detectToolClaimMismatches(
  text: string,
  results: ReadonlyArray<CriticToolResult>,
): ToolClaimIssue[] {
  if (results.length === 0) return [];
  const issues: ToolClaimIssue[] = [];
  const assertive = clauses(text).filter((c) => !HEDGE_RE.test(c));
  const processed = new Set(results.flatMap((r) => r.processed_ids));

  for (const cls of ["removal", "approval"] as const) {
    const relevant = resultsInClass(results, cls);
    if (relevant.length === 0) continue;
    const total = relevant.reduce(
      (sum, r) => sum + CLASS_OUTCOMES[cls].reduce((s, k) => s + (r.outcomes[k] ?? 0), 0),
      0,
    );
    const claimed = assertive.filter((c) => verbRe(cls).test(c));

    for (const clause of claimed) {
      for (const n of countClaims(clause, cls)) {
        if (n !== total) {
          issues.push({
            kind: "count_mismatch",
            detail: `text claims ${n} ${CLASS_OUTCOMES[cls][0]} ("${clause}") but tool results show ${outcomeSummary(relevant)}`,
          });
        }
      }
    }

    const failedTools = new Map<string, CriticToolResult>();
    for (const r of relevant) {
      if (!toolClass(r.tool)) continue;
      if (r.ok) failedTools.delete(r.tool);
      else if (!relevant.some((o) => o.tool === r.tool && o.ok)) failedTools.set(r.tool, r);
    }
    if (failedTools.size > 0 && claimed.length > 0) {
      for (const r of failedTools.values()) {
        issues.push({
          kind: "success_after_failure",
          detail: `text reports success ("${claimed[0]}") but ${r.tool} returned ok:false${r.error ? ` (${r.error})` : ""}`,
        });
      }
    }

    for (const clause of claimed) {
      for (const id of clause.match(UUID_RE) ?? []) {
        if (processed.has(id.toLowerCase())) continue;
        issues.push({
          kind: "unprocessed_id",
          detail: `id ${id} is reported as processed but no successful tool result contains it`,
        });
      }
    }
  }
  return issues;
}

export function toolResultIds(results: ReadonlyArray<CriticToolResult>): Set<string> {
  return new Set(results.flatMap((r) => r.ids));
}
