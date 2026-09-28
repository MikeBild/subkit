// What needs a human now — asked once.
//
// Before this module the question had four answers. The operational overview
// counted buckets (blocked / failing / overdue / other), the health digest
// printed a headline over its own lists, the MCP connect instructions quoted
// that headline, and the cockpit's decisions page stitched a fifth list
// together from half a dozen endpoints — including every awaiting conversation
// of every person, not the reader's own. Each surface could be right about its
// own predicate and still disagree with the one beside it.
//
// `buildAttention` is the one list. Every item is one thing a person can act
// on, carries the facts a surface words for itself (subject, machine reason,
// counts, since, deadline) and the addresses where it is acted on. The engine
// writes no sentence a surface is meant to show as its own; `detail` is the
// engine's residual wording (a classifier cause, a connector's health reason)
// and is marked as such wherever it is shown.
//
// Two halves:
//   * tenant facts — the same for every reader of a tenant, cached for 10 s per
//     process (the overview's cadence). A build in which any source failed is
//     never cached: a failure must not outlive the read that saw it.
//   * per-reader — the reader's own waiting conversations and the permission
//     filter. Every item is checked with `can()` on its subject, so a resource
//     grant on one workflow shows that workflow's item and nothing else.
//
// A source the reader may not read at all is `not_permitted`, a source that
// threw is `failed`, and neither is ever reported as an empty answer: a list is
// only "all clear" when every source the reader may read has answered.
//
// Read-only. Building the list writes no audit row and advances no tracker.

import { and, asc, eq, inArray, isNull, notExists, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { connectorCountsAgainstHealth } from "../connectors/health-ratio.ts";
import { listConnections } from "../credentials/connections/index.ts";
import type { Db } from "../db/client.ts";
import {
  connectors,
  conversationElicitations,
  conversationHidden,
  conversations,
  skillCandidates,
  workflows,
  workflowsSchedules,
} from "../db/schema/index.ts";
import type { PreviewClassification } from "../execution/classify.ts";
import { monthlyUsage, resolveMonthlyBudget } from "../llm/accounting/index.ts";
import { can, resourceAccess } from "../rbac/evaluator.ts";
import { listPendingSecretVersions } from "../runtime-config/pending-secrets.ts";
import { nextScheduleFire } from "../scheduler/next-fire.ts";
import { scheduleBindingState } from "../scheduler/trigger-bindings.ts";
import { readOpenPatchDecisions } from "../self-healing/open-decisions.ts";
import {
  collectFailureGroups,
  DECISION_FAILURE_WINDOW_HOURS,
  type DigestFailureGroup,
  failingScheduledGroups,
} from "./health-digest.ts";
import { getOperationalOverview, type HealthState } from "./operational-overview.ts";
import { computeRiskSignals, type RiskSignal } from "./risk-signals.ts";
import { registerTenantStateCache } from "./tenant-state.ts";

export const ATTENTION_SCHEMA_VERSION = "attention.v1" as const;

export const ATTENTION_SOURCES = [
  "conversations",
  "schedules",
  "freshness",
  "failures",
  "patches",
  "connectors",
  "connections",
  "secret_approvals",
  "skills",
  "budget",
  "risk",
] as const;
export type AttentionSource = (typeof ATTENTION_SOURCES)[number];
export type AttentionSourceState = "answered" | "failed" | "not_permitted";

export type AttentionClass = "stopped" | "failing" | "decide";
export type AttentionSeverity = "critical" | "urgent";
export type AttentionVerb =
  | "review"
  | "answer"
  | "reauth"
  | "renew"
  | "open_runs"
  | "chat"
  | "open";

export const ATTENTION_REASONS = [
  "awaiting_answer",
  "execution_authority_required",
  "execution_authority_unavailable",
  "scheduler_stale",
  "failing",
  "patch_proposed",
  "needs_reauth",
  "needs_update",
  "degraded",
  "unhealthy",
  "refresh_refused",
  "refresh_failed",
  "expired_no_refresh",
  "secret_unreadable",
  "secret_prepared",
  "skills_proposed",
  "budget_critical",
  "risk_critical",
] as const;
export type AttentionReason = (typeof ATTENTION_REASONS)[number];

export const ATTENTION_SUBJECT_KINDS = [
  "workflow",
  "conversation",
  "connector",
  "connection",
  "secret",
] as const;

export interface AttentionAction {
  verb: AttentionVerb;
  /** A router path under `/cockpit`. */
  href: string;
  primary: boolean;
  /** The permission acting here needs — the surface may disable, never hide, on a miss. */
  permission: string;
}

export interface AttentionItem {
  id: string;
  class: AttentionClass;
  severity: AttentionSeverity;
  /** What kind of thing needs attention — a subject kind, or a signal kind. */
  kind: string;
  subject: {
    kind: (typeof ATTENTION_SUBJECT_KINDS)[number];
    id: string;
    name: string | null;
  } | null;
  reason: AttentionReason;
  /** The run classifier's class behind a failing workflow, else null. */
  cause_class: PreviewClassification | null;
  counts: { patches?: number; failures?: number; skills?: number };
  since: string | null;
  deadline: string | null;
  /** Residual engine wording, or null. Never a sentence a surface passes off as its own. */
  detail: string | null;
  actions: AttentionAction[];
}

export interface AttentionV1 {
  schema_version: typeof ATTENTION_SCHEMA_VERSION;
  generated_at: string;
  sources: Record<AttentionSource, AttentionSourceState>;
  /** Only for a reader holding `stats:read`. */
  status: { health_state: HealthState; next_run_at: string | null } | null;
  items: AttentionItem[];
}

/** Whether nothing needs this reader: no item, and every source it may read answered. */
export function attentionAllClear(attention: AttentionV1): boolean {
  return (
    attention.items.length === 0 &&
    Object.values(attention.sources).every((state) => state !== "failed")
  );
}

// --------------------------------------------------------------------------
// Addresses — the cockpit's router paths. One place, so a renamed page is one
// edit and a test.

export const attentionHref = {
  // Item ids are `<kind>:<uuid>` or a bare word — query-safe as they stand, and
  // left readable (`?review=workflow:<id>`) rather than percent-encoded.
  review: (id: string) => `/cockpit?review=${id}`,
  conversation: (id: string) => `/cockpit/chat/${encodeURIComponent(id)}`,
  newChat: (workflowId: string, executionId: string) =>
    `/cockpit/chat/new?workflow_id=${encodeURIComponent(workflowId)}&execution_id=${encodeURIComponent(executionId)}`,
  connector: (id: string) => `/cockpit/connectors/${encodeURIComponent(id)}`,
  connections: "/cockpit/api-access?section=grants",
  failedRuns: (workflowId: string) =>
    `/cockpit/runs?workflow_id=${encodeURIComponent(workflowId)}&status=failed`,
  operations: "/cockpit/audit?scope=operations",
  // Prepared secret versions are decided on the settings page today.
  settings: "/cockpit/settings",
  usage: "/cockpit/usage",
} as const;

// --------------------------------------------------------------------------
// Gates: which permission reads a source, and on which resource type a grant
// reads part of it.

interface SourceGate {
  permission: string;
  resource_type?: string;
}

const SOURCE_GATES: Record<AttentionSource, SourceGate> = {
  conversations: { permission: "conversation:read" },
  schedules: { permission: "workflow:read", resource_type: "workflow" },
  freshness: { permission: "stats:read" },
  failures: { permission: "workflow:read", resource_type: "workflow" },
  patches: { permission: "workflow:read", resource_type: "workflow" },
  connectors: { permission: "connector:read", resource_type: "connector" },
  connections: { permission: "connection:read" },
  secret_approvals: { permission: "settings:read" },
  skills: { permission: "skill:read" },
  budget: { permission: "stats:read" },
  risk: { permission: "stats:read" },
};

/** One item as a tenant reader produced it, with the gate its reader must pass. */
interface Candidate {
  item: AttentionItem;
  source: AttentionSource;
  /** The resource the per-item check targets; absent for a tenant-level item. */
  resource?: { type: string; id: string };
}

interface TenantFacts {
  sources: Partial<Record<AttentionSource, "answered" | "failed">>;
  candidates: Candidate[];
  status: { health_state: HealthState; next_run_at: string | null } | null;
}

type TenantReader = (db: Db, tenantId: string, now: Date) => Promise<Candidate[]>;

// --------------------------------------------------------------------------
// Tenant readers. Each is isolated: a throw marks its source `failed` and never
// takes the build down.

interface HeldRow {
  workflow_id: string;
  name: string;
  hold: { reason_code: string; observed_at: string };
}

interface WorkflowFacts {
  id: string;
  name: string | null;
  held: HeldRow["hold"] | null;
  groups: DigestFailureGroup[];
  patches: { count: number; oldest: Date } | null;
}

/**
 * Held schedules, failing scheduled workflows and open patch decisions, merged
 * into one item per workflow. They are three facts about one subject; three
 * items would give one workflow three ids and three places to act on it.
 */
async function readWorkflowFacts(
  db: Db,
  tenantId: string,
  now: Date,
): Promise<{
  facts: Map<string, WorkflowFacts>;
  sources: Partial<Record<AttentionSource, "answered" | "failed">>;
}> {
  const facts = new Map<string, WorkflowFacts>();
  const sources: Partial<Record<AttentionSource, "answered" | "failed">> = {};
  const factFor = (id: string, name: string | null): WorkflowFacts => {
    const existing = facts.get(id);
    if (existing) {
      if (!existing.name && name) existing.name = name;
      return existing;
    }
    const created: WorkflowFacts = { id, name, held: null, groups: [], patches: null };
    facts.set(id, created);
    return created;
  };

  const [held, groups, patches] = await Promise.allSettled([
    // The overview's `blocked` predicate, row for row.
    db
      .select({
        workflow_id: workflows.id,
        name: workflows.name,
        hold: workflowsSchedules.admission_hold,
      })
      .from(workflowsSchedules)
      .innerJoin(
        workflows,
        and(
          eq(workflows.id, workflowsSchedules.workflow_id),
          eq(workflows.tenant_id, workflowsSchedules.tenant_id),
        ),
      )
      .where(
        and(
          eq(workflowsSchedules.tenant_id, tenantId),
          eq(workflowsSchedules.paused, false),
          sql`${workflowsSchedules.admission_hold} IS NOT NULL`,
          isNull(workflows.deleted_at),
          sql`${workflows.lifecycle} <> 'archived'`,
        ),
      ),
    collectFailureGroups(db, tenantId, DECISION_FAILURE_WINDOW_HOURS, now).then(
      failingScheduledGroups,
    ),
    readOpenPatchDecisions(db, tenantId),
  ]);

  if (held.status === "fulfilled") {
    sources.schedules = "answered";
    for (const row of held.value) {
      if (!row.hold) continue;
      factFor(row.workflow_id, row.name).held = row.hold;
    }
  } else sources.schedules = "failed";

  if (groups.status === "fulfilled") {
    sources.failures = "answered";
    // A group of an unsaved run has no workflow to act on — it is authoring
    // feedback, and failingScheduledGroups already keeps only scheduled runs.
    for (const group of groups.value) {
      if (!group.workflow_id) continue;
      factFor(group.workflow_id, group.workflow_name).groups.push(group);
    }
  } else sources.failures = "failed";

  if (patches.status === "fulfilled") {
    sources.patches = "answered";
    for (const { row } of patches.value.items) {
      const fact = factFor(row.workflow_id, null);
      if (!fact.patches) fact.patches = { count: 0, oldest: row.created_at };
      fact.patches.count += 1;
      if (row.created_at < fact.patches.oldest) fact.patches.oldest = row.created_at;
    }
  } else sources.patches = "failed";

  const unnamed = [...facts.values()].filter((fact) => !fact.name).map((fact) => fact.id);
  if (unnamed.length > 0) {
    const rows = await db
      .select({ id: workflows.id, name: workflows.name })
      .from(workflows)
      .where(and(eq(workflows.tenant_id, tenantId), inArray(workflows.id, unnamed)));
    for (const row of rows) {
      const fact = facts.get(row.id);
      if (fact) fact.name = row.name;
    }
  }
  return { facts, sources };
}

function minIso(values: ReadonlyArray<string | null | undefined>): string | null {
  const present = values.filter((value): value is string => typeof value === "string");
  return present.length === 0 ? null : present.reduce((a, b) => (b < a ? b : a));
}

/** The item for one workflow, most severe fact first. */
function workflowItem(fact: WorkflowFacts): Candidate {
  const failures = fact.groups.reduce((sum, group) => sum + group.count, 0);
  const patches = fact.patches?.count ?? 0;
  // Groups arrive most frequent first; the dominant cause speaks for the item.
  const lead = fact.groups[0] ?? null;
  const klass: AttentionClass = fact.held ? "stopped" : failures > 0 ? "failing" : "decide";
  const reason: AttentionReason = fact.held
    ? fact.held.reason_code === "execution_authority_unavailable"
      ? "execution_authority_unavailable"
      : "execution_authority_required"
    : failures > 0
      ? "failing"
      : "patch_proposed";
  const id = `workflow:${fact.id}`;

  // Remedy order: a held schedule and a proposed fix are decided in the review
  // sheet; an authentication failure is remedied at its connector; anything
  // else is a conversation about the newest failed run.
  const actions: AttentionAction[] = [];
  if (fact.held || patches > 0) {
    actions.push({
      verb: "review",
      href: attentionHref.review(id),
      primary: true,
      permission: "workflow:write",
    });
  } else if (lead?.cause_class === "auth_failed" && lead.connector_id) {
    actions.push({
      verb: "reauth",
      href: attentionHref.connector(lead.connector_id),
      primary: true,
      permission: "connector:oauth",
    });
  } else if (lead) {
    actions.push({
      verb: "chat",
      href: attentionHref.newChat(fact.id, lead.latest_execution_id),
      primary: true,
      permission: "conversation:write",
    });
  }
  if (failures > 0) {
    actions.push({
      verb: "open_runs",
      href: attentionHref.failedRuns(fact.id),
      primary: false,
      permission: "execution:read",
    });
  }

  const counts: AttentionItem["counts"] = {};
  if (failures > 0) counts.failures = failures;
  if (patches > 0) counts.patches = patches;
  return {
    source: fact.held ? "schedules" : failures > 0 ? "failures" : "patches",
    resource: { type: "workflow", id: fact.id },
    item: {
      id,
      class: klass,
      severity: klass === "stopped" ? "critical" : "urgent",
      kind: "workflow",
      subject: { kind: "workflow", id: fact.id, name: fact.name },
      reason,
      cause_class: lead?.cause_class ?? null,
      counts,
      since: minIso([
        fact.held?.observed_at,
        ...fact.groups.map((group) => group.first_seen),
        fact.patches?.oldest.toISOString(),
      ]),
      deadline: null,
      detail: lead?.cause ?? null,
      actions,
    },
  };
}

const CONNECTOR_REASON: Record<string, AttentionReason> = {
  needs_reauth: "needs_reauth",
  needs_update: "needs_update",
  degraded: "degraded",
};

const readConnectors: TenantReader = async (db, tenantId) => {
  const rows = await db
    .select({
      id: connectors.id,
      name: connectors.display_name,
      health_state: connectors.health_state,
      health_reason: connectors.health_reason,
      health_changed_at: connectors.health_changed_at,
      updated_at: connectors.updated_at,
      sunset_at: connectors.sunset_at,
    })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenantId), connectorCountsAgainstHealth()))
    .orderBy(asc(connectors.display_name), asc(connectors.id));
  return rows.map((row) => {
    const reason = CONNECTOR_REASON[row.health_state] ?? "unhealthy";
    const reauth = reason === "needs_reauth";
    return {
      source: "connectors",
      resource: { type: "connector", id: row.id },
      item: {
        id: `connector:${row.id}`,
        class: "failing",
        severity: "urgent",
        kind: "connector",
        subject: { kind: "connector", id: row.id, name: row.name },
        reason,
        cause_class: null,
        counts: {},
        since: (row.health_changed_at ?? row.updated_at).toISOString(),
        deadline: row.sunset_at?.toISOString() ?? null,
        // A state this build does not name is still said — as the engine's word.
        detail: row.health_reason ?? (reason === "unhealthy" ? row.health_state : null),
        actions: [
          {
            verb: reauth ? "reauth" : "open",
            href: attentionHref.connector(row.id),
            primary: true,
            permission: reauth ? "connector:oauth" : "connector:read",
          },
        ],
      },
    };
  });
};

const readConnections: TenantReader = async (db, tenantId) => {
  const views = await listConnections(db, tenantId);
  return views.flatMap((view): Candidate[] => {
    if (view.state !== "expired" && view.state !== "unreadable") return [];
    return [
      {
        source: "connections",
        item: {
          id: `connection:${view.id}`,
          class: "failing",
          severity: "urgent",
          kind: "connection",
          subject: { kind: "connection", id: view.id, name: view.name },
          reason:
            view.state_reason ??
            (view.state === "unreadable" ? "secret_unreadable" : "refresh_failed"),
          cause_class: null,
          counts: {},
          since: view.refresh_failed_at ?? view.expires_at ?? view.created_at,
          deadline: null,
          detail: view.last_error,
          actions: [
            {
              verb: "renew",
              href: attentionHref.connections,
              primary: true,
              permission: "connection:write",
            },
          ],
        },
      },
    ];
  });
};

const readSecretApprovals: TenantReader = async (db) => {
  // Installation-wide operator state: the registry has no tenant column.
  const pending = await listPendingSecretVersions(db);
  return pending.map((secret) => {
    const ref = `${secret.name}@${secret.version}`;
    return {
      source: "secret_approvals",
      item: {
        id: `secret-approval:${ref}`,
        class: "decide",
        severity: "urgent",
        kind: "secret_version",
        subject: { kind: "secret", id: ref, name: secret.name },
        reason: "secret_prepared",
        cause_class: null,
        counts: {},
        since: secret.pending_since.toISOString(),
        deadline: null,
        detail: null,
        actions: [
          {
            verb: "open",
            href: attentionHref.settings,
            primary: true,
            permission: "settings:write",
          },
        ],
      },
    };
  });
};

const readSkills: TenantReader = async (db, tenantId) => {
  // The overview's decision predicate for skills: proposed, and not one of the
  // two pattern kinds that are feedback rather than a decision.
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${skillCandidates.created_at})`,
    })
    .from(skillCandidates)
    .where(
      and(
        eq(skillCandidates.tenant_id, tenantId),
        eq(skillCandidates.status, "proposed"),
        sql`${skillCandidates.pattern_kind} NOT IN ('failure_pattern', 'authoring_capability')`,
      ),
    );
  const count = Number(row?.count ?? 0);
  if (count === 0) return [];
  const oldest = row?.oldest ? new Date(row.oldest) : null;
  return [
    {
      source: "skills",
      item: {
        id: "skills",
        class: "decide",
        severity: "urgent",
        kind: "skill_candidates",
        subject: null,
        reason: "skills_proposed",
        cause_class: null,
        counts: { skills: count },
        since: oldest?.toISOString() ?? null,
        deadline: null,
        detail: null,
        actions: [
          {
            verb: "review",
            href: attentionHref.review("skills"),
            primary: true,
            permission: "skill:write",
          },
        ],
      },
    },
  ];
};

function signalItem(signal: RiskSignal, source: "budget" | "risk"): Candidate {
  const budget = source === "budget";
  return {
    source,
    item: {
      id: budget ? "budget" : `risk:${signal.kind}`,
      class: "failing",
      severity: "critical",
      kind: signal.kind,
      subject: null,
      reason: budget ? "budget_critical" : "risk_critical",
      cause_class: null,
      counts: {},
      since: null,
      deadline: null,
      detail: signal.headline,
      actions: [
        {
          verb: "open",
          href: budget ? attentionHref.usage : attentionHref.operations,
          primary: true,
          permission: budget ? "stats:read" : "audit:read",
        },
      ],
    },
  };
}

/** Critical month allowance — the same 90 % line the usage page calls critical. */
const readBudget: TenantReader = async (db, tenantId) => {
  const signals = computeRiskSignals({
    monthTokens: await monthlyUsage(tenantId, db),
    monthBudget: resolveMonthlyBudget(tenantId),
  });
  return signals
    .filter((signal) => signal.kind === "token_budget" && signal.severity === "critical")
    .map((signal) => signalItem(signal, "budget"));
};

/** Critical host signals. Warnings are trends, not something to act on now. */
const readRisk: TenantReader = async () =>
  computeRiskSignals()
    .filter((signal) => signal.severity === "critical")
    .map((signal) => signalItem(signal, "risk"));

/**
 * Stale scheduler heartbeats, and the health state the empty list's status line
 * names — both read from the operational overview, so the list and the
 * overview can never disagree about either. A heartbeat that never beat
 * (`missing`, a fresh installation) is not a stopped scheduler.
 */
async function readFreshnessAndStatus(
  db: Db,
  tenantId: string,
): Promise<{ candidates: Candidate[]; health_state: HealthState }> {
  const overview = await getOperationalOverview(db, tenantId);
  const candidates = overview.core.data_freshness.sources
    .filter((source) => source.state === "stale")
    .map(
      (source): Candidate => ({
        source: "freshness",
        item: {
          id: `freshness:${source.id}`,
          class: "stopped",
          severity: "critical",
          kind: source.id,
          subject: null,
          reason: "scheduler_stale",
          cause_class: null,
          counts: {},
          since: source.updated_at,
          deadline: null,
          detail: null,
          actions: [
            {
              verb: "open",
              href: attentionHref.operations,
              primary: true,
              permission: "audit:read",
            },
          ],
        },
      }),
    );
  return { candidates, health_state: overview.core.health.state };
}

/** The next moment a schedule of this tenant really fires, or null. */
async function readNextRun(db: Db, tenantId: string, now: Date): Promise<string | null> {
  const rows = await db
    .select({
      cron: workflowsSchedules.cron,
      timezone: workflowsSchedules.timezone,
      input: workflowsSchedules.input,
      paused: workflowsSchedules.paused,
      admission_hold: workflowsSchedules.admission_hold,
      last_enqueued_at: workflowsSchedules.last_enqueued_at,
      created_at: workflowsSchedules.created_at,
      lifecycle: workflows.lifecycle,
      current_version_id: workflows.current_version_id,
    })
    .from(workflowsSchedules)
    .innerJoin(
      workflows,
      and(
        eq(workflows.id, workflowsSchedules.workflow_id),
        eq(workflows.tenant_id, workflowsSchedules.tenant_id),
      ),
    )
    .where(and(eq(workflowsSchedules.tenant_id, tenantId), isNull(workflows.deleted_at)));
  return minIso(
    rows.map((row) => (scheduleBindingState(row) === "active" ? nextScheduleFire(row, now) : null)),
  );
}

/** Test seam: replace one tenant reader to make its source fail. Bypasses the cache. */
export type AttentionReaderOverrides = Partial<
  Record<
    "connectors" | "connections" | "secret_approvals" | "skills" | "budget" | "risk",
    TenantReader
  >
>;

const TENANT_READERS: Required<AttentionReaderOverrides> = {
  connectors: readConnectors,
  connections: readConnections,
  secret_approvals: readSecretApprovals,
  skills: readSkills,
  budget: readBudget,
  risk: readRisk,
};

async function buildTenantFacts(
  db: Db,
  tenantId: string,
  now: Date,
  overrides: AttentionReaderOverrides,
): Promise<TenantFacts> {
  const sources: TenantFacts["sources"] = {};
  const candidates: Candidate[] = [];
  const readers = { ...TENANT_READERS, ...overrides };
  const simple = Object.entries(readers) as Array<[keyof typeof readers, TenantReader]>;

  const [workflowFacts, freshness, nextRun, ...simpleResults] = await Promise.allSettled([
    readWorkflowFacts(db, tenantId, now),
    readFreshnessAndStatus(db, tenantId),
    readNextRun(db, tenantId, now),
    ...simple.map(([, reader]) => reader(db, tenantId, now)),
  ]);

  if (workflowFacts.status === "fulfilled") {
    Object.assign(sources, workflowFacts.value.sources);
    for (const fact of workflowFacts.value.facts.values()) candidates.push(workflowItem(fact));
  } else {
    sources.schedules = "failed";
    sources.failures = "failed";
    sources.patches = "failed";
  }

  let status: TenantFacts["status"] = null;
  if (freshness.status === "fulfilled") {
    sources.freshness = "answered";
    candidates.push(...freshness.value.candidates);
    status = {
      health_state: freshness.value.health_state,
      next_run_at: nextRun.status === "fulfilled" ? nextRun.value : null,
    };
  } else sources.freshness = "failed";

  simple.forEach(([source], index) => {
    const result = simpleResults[index];
    if (result?.status === "fulfilled") {
      sources[source] = "answered";
      candidates.push(...(result.value as Candidate[]));
    } else sources[source] = "failed";
  });

  return { sources, candidates, status };
}

const CACHE_MS = 10_000;
const cache = new Map<string, { until: number; value: Promise<TenantFacts> }>();

export function invalidateAttention(tenantId?: string): void {
  if (tenantId) cache.delete(tenantId);
  else cache.clear();
}
registerTenantStateCache(invalidateAttention);

function tenantFacts(db: Db, tenantId: string, now: Date): Promise<TenantFacts> {
  const at = Date.now();
  const existing = cache.get(tenantId);
  if (existing && existing.until > at) return existing.value;
  const value = buildTenantFacts(db, tenantId, now, {}).then(
    (facts) => {
      // A partial build is not a snapshot worth serving to the next reader.
      if (Object.values(facts.sources).includes("failed")) cache.delete(tenantId);
      return facts;
    },
    (error) => {
      cache.delete(tenantId);
      throw error;
    },
  );
  cache.set(tenantId, { until: at + CACHE_MS, value });
  return value;
}

// --------------------------------------------------------------------------
// Per reader.

/** The reader's own conversations that wait for its answer — never anyone else's. */
async function readOwnConversations(db: Db, principal: ResolvedPrincipal): Promise<Candidate[]> {
  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      updated_at: conversations.updated_at,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.tenant_id, principal.tenant_id),
        eq(conversations.owner_id, principal.id),
        eq(conversations.status, "awaiting_input"),
        notExists(
          db
            .select({ one: sql`1` })
            .from(conversationHidden)
            .where(
              and(
                eq(conversationHidden.tenant_id, principal.tenant_id),
                eq(conversationHidden.conversation_id, conversations.id),
                eq(conversationHidden.user_id, principal.id),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(conversations.updated_at));
  if (rows.length === 0) return [];
  const pending = await db
    .select({
      conversation_id: conversationElicitations.conversation_id,
      created_at: conversationElicitations.created_at,
      expires_at: conversationElicitations.expires_at,
    })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, principal.tenant_id),
        inArray(
          conversationElicitations.conversation_id,
          rows.map((row) => row.id),
        ),
        eq(conversationElicitations.status, "pending"),
      ),
    );
  const byConversation = new Map<string, { created_at: Date; expires_at: Date }>();
  for (const row of pending) {
    const prior = byConversation.get(row.conversation_id);
    if (!prior || row.created_at > prior.created_at) byConversation.set(row.conversation_id, row);
  }
  return rows.map((row) => {
    const question = byConversation.get(row.id);
    return {
      source: "conversations",
      resource: { type: "conversation", id: row.id },
      item: {
        id: `conversation:${row.id}`,
        class: "stopped",
        severity: "urgent",
        kind: "conversation",
        subject: { kind: "conversation", id: row.id, name: row.title },
        reason: "awaiting_answer",
        cause_class: null,
        counts: {},
        since: (question?.created_at ?? row.updated_at).toISOString(),
        deadline: question?.expires_at.toISOString() ?? null,
        detail: null,
        actions: [
          {
            verb: "answer",
            href: attentionHref.conversation(row.id),
            primary: true,
            permission: "conversation:write",
          },
        ],
      },
    };
  });
}

const CLASS_RANK: Record<AttentionClass, number> = { stopped: 0, failing: 1, decide: 2 };

/** Class (stopped → failing → decide), then nearest deadline, then oldest, then id. */
export function compareAttentionItems(a: AttentionItem, b: AttentionItem): number {
  const byClass = CLASS_RANK[a.class] - CLASS_RANK[b.class];
  if (byClass !== 0) return byClass;
  if (a.deadline !== b.deadline) {
    if (a.deadline === null) return 1;
    if (b.deadline === null) return -1;
    return a.deadline < b.deadline ? -1 : 1;
  }
  if (a.since !== b.since) {
    if (a.since === null) return 1;
    if (b.since === null) return -1;
    return a.since < b.since ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface BuildAttentionOptions {
  now?: Date;
  /** Test seam: replace tenant readers; the build then skips the cache. */
  readers?: AttentionReaderOverrides;
}

/**
 * The one answer to "what needs this person now". Read-only: no audit row, no
 * tracker advanced.
 */
export async function buildAttention(
  db: Db,
  principal: ResolvedPrincipal,
  opts: BuildAttentionOptions = {},
): Promise<AttentionV1> {
  const now = opts.now ?? new Date();
  const tenantId = principal.tenant_id;

  // One permission read per distinct gate, not per source and never per item.
  // Hiding what a reader may not see is the expected outcome, not an incident:
  // every probe is quiet, or each filtered item would log a WARN.
  //   * a resource-typed gate (workflows, connectors) reads the reader's
  //     tenant-wide decision and its grants once (`resourceAccess`); the
  //     source is readable when that reaches ANY resource, and each item is
  //     then checked in memory. A key whose scopes exclude the permission
  //     reaches nothing, grants or not — counting it as answered would turn
  //     that refusal into a false "all clear".
  //   * a tenant-level gate is one `can()`.
  const gates = new Map<string, Promise<{ any: boolean; allows: (id: string) => boolean }>>();
  const gateFor = (gate: SourceGate) => {
    const key = `${gate.permission}|${gate.resource_type ?? ""}`;
    let pending = gates.get(key);
    if (!pending) {
      pending = gate.resource_type
        ? resourceAccess(db, {
            tenant_id: tenantId,
            principal,
            permission: gate.permission,
            resource_type: gate.resource_type,
            quiet: true,
          })
        : can(db, {
            tenant_id: tenantId,
            principal,
            permission: gate.permission,
            quiet: true,
          }).then((decision) => ({ any: decision.allow, allows: () => decision.allow }));
      gates.set(key, pending);
    }
    return pending;
  };

  const [access, facts] = await Promise.all([
    Promise.all(
      ATTENTION_SOURCES.map(
        async (source) => [source, await gateFor(SOURCE_GATES[source])] as const,
      ),
    ).then((entries) => new Map(entries)),
    opts.readers
      ? buildTenantFacts(db, tenantId, now, opts.readers)
      : tenantFacts(db, tenantId, now),
  ]);
  const permitted = (source: AttentionSource) => access.get(source)?.any === true;

  let conversationsState: "answered" | "failed" = "answered";
  let own: Candidate[] = [];
  if (permitted("conversations")) {
    try {
      own = await readOwnConversations(db, principal);
    } catch {
      conversationsState = "failed";
    }
  }

  const sources = {} as Record<AttentionSource, AttentionSourceState>;
  for (const source of ATTENTION_SOURCES) {
    if (!permitted(source)) sources[source] = "not_permitted";
    else if (source === "conversations") sources[source] = conversationsState;
    else sources[source] = facts.sources[source] ?? "failed";
  }

  // Conversations are the reader's own: the owner filter is the gate.
  const items: AttentionItem[] = own.map((candidate) => candidate.item);
  for (const candidate of facts.candidates) {
    const gate = access.get(candidate.source);
    if (!gate?.any) continue;
    // A merged workflow item is read through its workflow, whichever of its
    // facts named it — every workflow source shares the same gate.
    if (candidate.resource && SOURCE_GATES[candidate.source].resource_type) {
      if (!gate.allows(candidate.resource.id)) continue;
    }
    items.push(candidate.item);
  }
  items.sort(compareAttentionItems);

  return {
    schema_version: ATTENTION_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    sources,
    status: (await gateFor({ permission: "stats:read" })).any ? facts.status : null,
    items,
  };
}
