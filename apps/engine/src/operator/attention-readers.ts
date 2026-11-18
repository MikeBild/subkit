import { and, asc, eq, inArray, isNull, notExists, notInArray, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { connectorCountsAgainstHealth } from "../connectors/health-ratio.ts";
import { listConnections } from "../credentials/connections/index.ts";
import type { Db } from "../db/client.ts";
import {
  connectors,
  conversationElicitations,
  conversationHidden,
  conversations,
  intakeItems,
  skillCandidates,
  webhooksInbound,
  workflows,
  workflowsSchedules,
} from "../db/schema/index.ts";
import { monthlyUsage, resolveMonthlyBudget } from "../llm/accounting/index.ts";
import { listPendingSecretVersions } from "../runtime-config/pending-secrets.ts";
import { nextScheduleFire } from "../scheduler/next-fire.ts";
import { scheduleBindingState } from "../scheduler/trigger-bindings.ts";
import { readOpenPatchDecisions } from "../self-healing/open-decisions.ts";
import { LEARNING_PATTERN_KINDS } from "../skill-candidates/types.ts";
import { previewWorkflowAuthority } from "../workflows/execution-authorities.ts";
import { diagnoseWorkflow, type GateDiagnosis } from "../workflows/gate-diagnosis.ts";
import { readAiAccess } from "./ai-access-attention.ts";
import { type ApprovalFact, readApprovalFacts } from "./approval-readers.ts";
import type {
  AttentionAction,
  AttentionClass,
  AttentionItem,
  AttentionReason,
  AttentionSource,
} from "./attention.ts";
import { readFailureStreaks } from "./failure-streaks.ts";
import {
  collectFailureGroups,
  DECISION_FAILURE_WINDOW_HOURS,
  type DigestFailureGroup,
  failingScheduledGroups,
} from "./health-digest.ts";
import { cockpitRunsHref } from "./operating-figures.ts";
import { getOperationalOverview, type HealthState } from "./operational-overview.ts";
import { type ProviderOutage, readProviderOutage } from "./provider-outage.ts";
import { computeRiskSignals, type RiskSignal } from "./risk-signals.ts";

export const attentionHref = {
  review: (id: string) => `/cockpit?review=${id}`,
  automation: (workflowId: string) =>
    `/cockpit/workflows/${encodeURIComponent(workflowId)}#workflow-automation`,
  conversation: (id: string) => `/cockpit/chat/${encodeURIComponent(id)}`,
  newChat: (workflowId: string, executionId: string | null) =>
    `/cockpit/chat/new?workflow_id=${encodeURIComponent(workflowId)}${
      executionId ? `&execution_id=${encodeURIComponent(executionId)}` : ""
    }`,
  connector: (id: string) => `/cockpit/connectors/${encodeURIComponent(id)}`,
  connection: (connectorIds: readonly string[]) =>
    connectorIds.length === 1 && connectorIds[0]
      ? `/cockpit/connectors/${encodeURIComponent(connectorIds[0])}`
      : "/cockpit/connectors",
  failedRuns: (workflowId: string) => cockpitRunsHref({ workflowId, status: "failed" }),
  operations: "/cockpit/audit?scope=operations",
  settings: "/cockpit/settings",
  intake: "/cockpit/intake?category=all",
  usage: "/cockpit/usage",
} as const;

export interface Candidate {
  item: AttentionItem;
  source: AttentionSource;
  resource?: { type: string; id: string };
}

export interface TenantFacts {
  sources: Partial<Record<AttentionSource, "answered" | "failed">>;
  candidates: Candidate[];
  status: { health_state: HealthState; next_run_at: string | null } | null;
}

export type TenantReader = (db: Db, tenantId: string, now: Date) => Promise<Candidate[]>;

interface HeldRow {
  workflow_id: string;
  name: string;
  hold: { reason_code: string; observed_at: string };
}

interface WorkflowFacts {
  id: string;
  name: string | null;
  held: HeldRow["hold"] | null;
  trigger: AttentionItem["trigger"];
  groups: DigestFailureGroup[];
  consecutiveFailures?: number;
  patches: { count: number; oldest: Date } | null;
  approval: ApprovalFact | null;
  repair: NonNullable<AttentionItem["repair"]> | null;
}

const REMEDY_ORDER: Record<GateDiagnosis["remedy_kind"], number> = {
  author: 0,
  declare: 1,
  reconnect: 2,
  patch: 3,
  prepare: 4,
};

async function readRepairFacts(
  db: Db,
  tenantId: string,
  awaiting: ReadonlyArray<{ workflow_id: string; environment: "dev" | "prod" }>,
): Promise<Map<string, NonNullable<AttentionItem["repair"]>>> {
  const repairs = new Map<string, NonNullable<AttentionItem["repair"]>>();
  if (awaiting.length === 0) return repairs;
  const rows = await db
    .select({ id: workflows.id, version: workflows.current_version_id })
    .from(workflows)
    .where(
      and(
        eq(workflows.tenant_id, tenantId),
        inArray(
          workflows.id,
          awaiting.map((fact) => fact.workflow_id),
        ),
      ),
    );
  const versions = new Map(rows.map((row) => [row.id, row.version]));
  await Promise.all(
    awaiting.map(async (fact) => {
      const version_id = versions.get(fact.workflow_id);
      if (!version_id) return;
      const input = {
        tenant_id: tenantId,
        workflow_id: fact.workflow_id,
        workflow_version_id: version_id,
        execution_environment: fact.environment,
      };
      const preview = await previewWorkflowAuthority(input, db).catch(() => null);
      if (!preview || preview.eligible_for_repeated_runs) return;
      const diagnosis = await diagnoseWorkflow(db, tenantId, fact.workflow_id, fact.environment, {
        version_id,
        preview,
      }).catch(() => null);
      const entries = diagnosis?.diagnoses ?? [];
      const lead = [...entries].sort(
        (a, b) => REMEDY_ORDER[a.remedy_kind] - REMEDY_ORDER[b.remedy_kind],
      )[0];
      const issue = preview.manifest.issues[0];
      repairs.set(fact.workflow_id, {
        step_id: lead?.subject.step_id ?? issue?.step_id ?? null,
        code: lead?.code ?? issue?.code ?? null,
        remedy_kind: lead?.remedy_kind ?? "author",
        steps: Math.max(1, new Set(entries.map((entry) => entry.subject.step_id)).size),
        candidate_id: lead?.candidate_id ?? null,
        execution_id: lead?.evidence.execution_id ?? null,
      });
    }),
  );
  return repairs;
}

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
    const created: WorkflowFacts = {
      id,
      name,
      held: null,
      trigger: null,
      groups: [],
      patches: null,
      approval: null,
      repair: null,
    };
    facts.set(id, created);
    return created;
  };

  const [held, heldHooks, groups, patches, approvals] = await Promise.allSettled([
    db
      .select({
        workflow_id: workflows.id,
        name: workflows.name,
        hold: workflowsSchedules.admission_hold,
        environment: workflowsSchedules.execution_mode,
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
    db
      .select({
        workflow_id: workflows.id,
        name: workflows.name,
        hold: webhooksInbound.admission_hold,
        slug: webhooksInbound.slug,
      })
      .from(webhooksInbound)
      .innerJoin(
        workflows,
        and(
          eq(workflows.id, webhooksInbound.workflow_id),
          eq(workflows.tenant_id, webhooksInbound.tenant_id),
        ),
      )
      .where(
        and(
          eq(webhooksInbound.tenant_id, tenantId),
          eq(webhooksInbound.active, true),
          sql`${webhooksInbound.admission_hold} IS NOT NULL`,
          isNull(workflows.deleted_at),
          sql`${workflows.lifecycle} <> 'archived'`,
        ),
      ),
    collectFailureGroups(db, tenantId, DECISION_FAILURE_WINDOW_HOURS, now).then(
      failingScheduledGroups,
    ),
    readOpenPatchDecisions(db, tenantId),
    readApprovalFacts(db, tenantId, now),
  ]);

  if (
    held.status === "fulfilled" &&
    heldHooks.status === "fulfilled" &&
    approvals.status === "fulfilled"
  ) {
    sources.schedules = "answered";
    for (const fact of approvals.value.values())
      factFor(fact.workflow_id, fact.name).approval = fact;
    const holds = [
      ...held.value.map((row) => ({ ...row, trigger: { kind: "schedule" as const, name: null } })),
      ...heldHooks.value.map((row) => ({
        ...row,
        environment: "prod" as const,
        trigger: { kind: "inbound_hook" as const, name: row.slug },
      })),
    ];
    const repairTargets = new Map<string, { workflow_id: string; environment: "dev" | "prod" }>();
    for (const fact of approvals.value.values())
      if (fact.kind === "awaiting") repairTargets.set(fact.workflow_id, fact);
    for (const row of holds)
      if (
        row.hold?.reason_code === "execution_authority_required" &&
        !repairTargets.has(row.workflow_id)
      )
        repairTargets.set(row.workflow_id, row);
    const repairs = await readRepairFacts(db, tenantId, [...repairTargets.values()]);
    for (const [id, repair] of repairs) factFor(id, null).repair = repair;
    for (const row of holds) {
      if (!row.hold) continue;
      const fact = factFor(row.workflow_id, row.name);
      if (!fact.held) {
        fact.held = row.hold;
        fact.trigger = row.trigger;
      }
    }
  } else sources.schedules = "failed";

  if (groups.status === "fulfilled") {
    sources.failures = "answered";
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
  const failingIds = [...facts.values()]
    .filter((fact) => fact.groups.length > 0)
    .map((fact) => fact.id);
  const [streaks] = await Promise.allSettled([readFailureStreaks(db, tenantId, failingIds, now)]);
  if (streaks.status === "fulfilled") {
    for (const id of failingIds) {
      const fact = facts.get(id);
      if (fact) fact.consecutiveFailures = streaks.value.get(id) ?? 0;
    }
  } else {
    sources.failures = "failed";
  }
  return { facts, sources };
}

function minIso(values: ReadonlyArray<string | null | undefined>): string | null {
  const present = values.filter((value): value is string => typeof value === "string");
  return present.length === 0 ? null : present.reduce((a, b) => (b < a ? b : a));
}

function workflowItem(fact: WorkflowFacts): Candidate {
  const failures = fact.groups.reduce((sum, group) => sum + group.count, 0);
  const patches = fact.patches?.count ?? 0;
  const lead = fact.groups[0] ?? null;
  const klass: AttentionClass = fact.held ? "stopped" : failures > 0 ? "failing" : "decide";
  const approval = !fact.held && failures === 0 && patches === 0 ? fact.approval : null;
  const heldForRepair = fact.held?.reason_code === "execution_authority_required";
  const repair = approval?.kind === "awaiting" || heldForRepair ? fact.repair : null;
  const reason: AttentionReason = fact.held
    ? fact.held.reason_code === "execution_authority_unavailable"
      ? "execution_authority_unavailable"
      : "execution_authority_required"
    : failures > 0
      ? "failing"
      : approval
        ? repair
          ? "version_needs_repair"
          : approval.kind === "awaiting"
            ? "version_awaiting_approval"
            : "approval_expiring"
        : "patch_proposed";
  const id = `workflow:${fact.id}`;

  const actions: AttentionAction[] = [];
  if (patches > 0) {
    actions.push({
      verb: "review",
      href: attentionHref.review(id),
      primary: true,
      permission: "workflow:write",
    });
  } else if (fact.held && !repair) {
    actions.push({
      verb: "open",
      href: attentionHref.automation(fact.id),
      primary: true,
      permission: "workflow:write",
    });
  } else if (!fact.held && lead?.cause_class === "auth_failed" && lead.connector_id) {
    actions.push({
      verb: "reauth",
      href: attentionHref.connector(lead.connector_id),
      primary: true,
      permission: "connector:oauth",
    });
  } else if (!fact.held && lead) {
    actions.push({
      verb: "chat",
      href: attentionHref.newChat(fact.id, lead.latest_execution_id),
      primary: true,
      permission: "conversation:write",
    });
  } else if (repair) {
    if (repair.remedy_kind === "patch" && repair.candidate_id)
      actions.push({
        verb: "review",
        href: attentionHref.review(id),
        primary: true,
        permission: "workflow:write",
      });
    else if (repair.remedy_kind === "author" || repair.remedy_kind === "declare")
      actions.push({
        verb: "chat",
        href: attentionHref.newChat(fact.id, repair.execution_id),
        primary: true,
        permission: "conversation:write",
      });
    else
      actions.push({
        verb: "open",
        href: attentionHref.automation(fact.id),
        primary: true,
        permission: repair.remedy_kind === "prepare" ? "workflow:run" : "workflow:write",
      });
  } else if (approval) {
    actions.push({
      verb: "open",
      href: attentionHref.automation(fact.id),
      primary: true,
      permission: "workflow:write",
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
  if (fact.consecutiveFailures !== undefined)
    counts.consecutive_failures = fact.consecutiveFailures;
  if (patches > 0) counts.patches = patches;
  return {
    source: fact.held ? "schedules" : failures > 0 ? "failures" : "patches",
    resource: { type: "workflow", id: fact.id },
    item: {
      id,
      class: klass,
      severity:
        klass === "stopped" ? "critical" : approval?.kind === "expiring" ? "notice" : "urgent",
      kind: "workflow",
      subject: { kind: "workflow", id: fact.id, name: fact.name },
      reason,
      trigger: fact.held ? fact.trigger : (approval?.trigger ?? null),
      ...(approval
        ? {
            approval: {
              version: approval.version,
              environment: approval.environment,
              ...(approval.growth ? { growth: approval.growth } : {}),
            },
          }
        : {}),
      ...(repair ? { repair } : {}),
      cause_class: lead?.cause_class ?? null,
      counts,
      since: approval
        ? approval.since
        : minIso([
            fact.held?.observed_at,
            ...fact.groups.map((group) => group.first_seen),
            fact.patches?.oldest.toISOString(),
          ]),
      deadline: approval?.deadline ?? null,
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
      needs_reauth: connectors.needs_reauth,
      health_reason: connectors.health_reason,
      health_changed_at: connectors.health_changed_at,
      updated_at: connectors.updated_at,
      sunset_at: connectors.sunset_at,
    })
    .from(connectors)
    .where(and(eq(connectors.tenant_id, tenantId), connectorCountsAgainstHealth()))
    .orderBy(asc(connectors.display_name), asc(connectors.id));
  return rows.map((row) => {
    const reason = row.needs_reauth
      ? "needs_reauth"
      : (CONNECTOR_REASON[row.health_state] ?? "unhealthy");
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
        trigger: null,
        cause_class: null,
        counts: {},
        since: (row.health_changed_at ?? row.updated_at).toISOString(),
        deadline: row.sunset_at?.toISOString() ?? null,
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
    if (view.used_by.length === 0) return [];
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
          trigger: null,
          cause_class: null,
          counts: {},
          since: view.refresh_failed_at ?? view.expires_at ?? view.created_at,
          deadline: null,
          detail: view.last_error,
          actions: [
            {
              verb: "renew",
              href: attentionHref.connection(view.used_by.map((user) => user.connector_id)),
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
        trigger: null,
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
            permission: "settings:write:global",
          },
        ],
      },
    };
  });
};

const readSkills: TenantReader = async (db, tenantId) => {
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
        notInArray(skillCandidates.pattern_kind, [...LEARNING_PATTERN_KINDS]),
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
        trigger: null,
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

export const INTAKE_CATEGORY_LIMIT = 10;

export function intakeCandidates(
  rows: ReadonlyArray<{ category: string; count: number; oldest: Date | string | null }>,
): Candidate[] {
  const categories = rows
    .map((row) => ({ category: row.category, count: Number(row.count) }))
    .filter((row) => row.count > 0)
    .sort((a, b) =>
      b.count !== a.count
        ? b.count - a.count
        : a.category < b.category
          ? -1
          : a.category > b.category
            ? 1
            : 0,
    );
  const count = categories.reduce((sum, row) => sum + row.count, 0);
  if (count === 0) return [];
  const listed = categories.slice(0, INTAKE_CATEGORY_LIMIT);
  const omitted = categories.slice(INTAKE_CATEGORY_LIMIT).reduce((sum, row) => sum + row.count, 0);
  const oldest = rows.reduce<Date | null>((min, row) => {
    if (!row.oldest) return min;
    const at = new Date(row.oldest);
    return min === null || at < min ? at : min;
  }, null);
  return [
    {
      source: "intake",
      item: {
        id: "intake",
        class: "decide",
        severity: "notice",
        kind: "intake_items",
        subject: null,
        reason: "intake_collected",
        trigger: null,
        cause_class: null,
        counts: {
          intake: count,
          intake_by_category: listed,
          ...(omitted > 0 ? { intake_categories_omitted: omitted } : {}),
        },
        since: oldest?.toISOString() ?? null,
        deadline: null,
        detail: null,
        actions: [
          {
            verb: "review",
            href: attentionHref.intake,
            primary: true,
            permission: "intake:read",
          },
        ],
      },
    },
  ];
}

const readIntake: TenantReader = async (db, tenantId) => {
  const rows = await db
    .select({
      category: intakeItems.category,
      count: sql<number>`count(*)::int`,
      oldest: sql<Date | null>`min(${intakeItems.created_at})`,
    })
    .from(intakeItems)
    .where(
      and(
        eq(intakeItems.tenant_id, tenantId),
        inArray(intakeItems.state, ["collected", "reviewing"]),
      ),
    )
    .groupBy(intakeItems.category);
  return intakeCandidates(rows);
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
      trigger: null,
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

const readBudget: TenantReader = async (db, tenantId) => {
  const signals = computeRiskSignals({
    monthTokens: await monthlyUsage(tenantId, db),
    monthBudget: resolveMonthlyBudget(tenantId),
  });
  return signals
    .filter((signal) => signal.kind === "token_budget" && signal.severity === "critical")
    .map((signal) => signalItem(signal, "budget"));
};

function providerOutageItem(outage: ProviderOutage): Candidate {
  return {
    source: "risk",
    item: {
      id: `risk:${outage.kind}`,
      class: outage.kind === "llm_provider_quota" ? "stopped" : "failing",
      severity: "critical",
      kind: outage.kind,
      subject: null,
      reason: "risk_critical",
      trigger: null,
      cause_class: null,
      counts: { consecutive_failures: outage.failures },
      since: outage.since,
      deadline: null,
      detail: outage.last_error?.slice(0, 300) ?? null,
      actions: [
        { verb: "open", href: attentionHref.settings, primary: true, permission: "settings:read" },
      ],
    },
  };
}

const readRisk: TenantReader = async (db, tenantId, now) => {
  const outage = await readProviderOutage(db, tenantId, now);
  return [
    ...(outage ? [providerOutageItem(outage)] : []),
    ...computeRiskSignals()
      .filter((signal) => signal.severity === "critical")
      .map((signal) => signalItem(signal, "risk")),
  ];
};

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
          trigger: null,
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

type WorkflowSource = "conversations" | "schedules" | "freshness" | "failures" | "patches";

export type AttentionReaderOverrides = Partial<
  Record<Exclude<AttentionSource, WorkflowSource>, TenantReader>
>;

const TENANT_READERS: Required<AttentionReaderOverrides> = {
  connectors: readConnectors,
  connections: readConnections,
  secret_approvals: readSecretApprovals,
  skills: readSkills,
  intake: readIntake,
  budget: readBudget,
  ai_access: readAiAccess,
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
        trigger: null,
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
