// The attention list's readers — where each item comes from.
//
// Split from attention.ts, which keeps the contract, the cache, the
// per-reader permission filter and the ordering. Every function here reads;
// none writes. The tenant readers are isolated by `buildTenantFacts`: one that
// throws marks its source `failed` and never takes the build down.

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
import { monthlyUsage, resolveMonthlyBudget } from "../llm/accounting/index.ts";
import { listPendingSecretVersions } from "../runtime-config/pending-secrets.ts";
import { nextScheduleFire } from "../scheduler/next-fire.ts";
import { scheduleBindingState } from "../scheduler/trigger-bindings.ts";
import { readOpenPatchDecisions } from "../self-healing/open-decisions.ts";
import type {
  AttentionAction,
  AttentionClass,
  AttentionItem,
  AttentionReason,
  AttentionSource,
} from "./attention.ts";
import {
  collectFailureGroups,
  DECISION_FAILURE_WINDOW_HOURS,
  type DigestFailureGroup,
  failingScheduledGroups,
} from "./health-digest.ts";
import { getOperationalOverview, type HealthState } from "./operational-overview.ts";
import { computeRiskSignals, type RiskSignal } from "./risk-signals.ts";

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

/** One item as a tenant reader produced it, with the gate its reader must pass. */
export interface Candidate {
  item: AttentionItem;
  source: AttentionSource;
  /** The resource the per-item check targets; absent for a tenant-level item. */
  resource?: { type: string; id: string };
}

export interface TenantFacts {
  sources: Partial<Record<AttentionSource, "answered" | "failed">>;
  candidates: Candidate[];
  status: { health_state: HealthState; next_run_at: string | null } | null;
}

export type TenantReader = (db: Db, tenantId: string, now: Date) => Promise<Candidate[]>;
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

export async function buildTenantFacts(
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

// --------------------------------------------------------------------------
// Per reader.

/** The reader's own conversations that wait for its answer — never anyone else's. */
export async function readOwnConversations(
  db: Db,
  principal: ResolvedPrincipal,
): Promise<Candidate[]> {
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
