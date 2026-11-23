import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import { activeApprover } from "../identity/setup-preferences.ts";
import { can, resourceAccess } from "../rbac/evaluator.ts";
import { readOwnConversations } from "./attention-conversations.ts";
import { withExecutionEnvironments } from "./attention-environment.ts";
import {
  type AttentionReaderOverrides,
  buildTenantFacts,
  type Candidate,
  type TenantFacts,
} from "./attention-readers.ts";
import { withWaitingOn } from "./attention-waiting-on.ts";
import {
  ATTENTION_SCHEMA_VERSION,
  ATTENTION_SOURCES,
  type AttentionItem,
  type AttentionSource,
  type AttentionSourceState,
  type AttentionV1,
  needsApproval,
  projectAttentionItems,
  splitSnoozed,
} from "./core/attention.ts";
import { withDeviceAttention, withDeviceFacts } from "./device-attention.ts";
import { withPairApprovals, withPendingPairRequests } from "./pair-approval-attention.ts";
import { activeSnoozes } from "./persistence/attention-snoozes.ts";
import { withPausedSchedules } from "./schedule-pause-attention.ts";
import {
  readTaskAttention,
  retargetRunConversations,
  type TaskAttentionReader,
  taskAttentionScope,
} from "./task-attention.ts";
import { registerTenantStateCache } from "./tenant-state.ts";

export {
  ATTENTION_REASONS,
  ATTENTION_SCHEMA_VERSION,
  ATTENTION_SOURCES,
  ATTENTION_SUBJECT_KINDS,
  type AttentionAction,
  type AttentionClass,
  type AttentionItem,
  type AttentionReason,
  type AttentionSeverity,
  type AttentionSource,
  type AttentionSourceState,
  type AttentionV1,
  type AttentionVerb,
  attentionAllClear,
  compareAttentionItems,
  type IntakeCategoryCount,
} from "./core/attention.ts";

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
  secret_approvals: { permission: "settings:read:global" },
  skills: { permission: "skill:read" },
  intake: { permission: "intake:read" },
  budget: { permission: "stats:read" },
  ai_access: { permission: "identity:write" },
  risk: { permission: "stats:read" },
  tasks: { permission: "task:read" },
};
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
  const value = buildTenantFacts(db, tenantId, now, {})
    .then((facts) => withPausedSchedules(db, tenantId, facts))
    .then((facts) => withExecutionEnvironments(db, tenantId, facts))
    .then((facts) => withPendingPairRequests(db, tenantId, facts, now))
    .then((facts) => withDeviceFacts(db, tenantId, facts, now))
    .then(
      (facts) => {
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

export interface BuildAttentionOptions {
  now?: Date;
  readers?: AttentionReaderOverrides;
  task_reader?: TaskAttentionReader;
}

export async function buildAttention(
  db: Db,
  principal: ResolvedPrincipal,
  opts: BuildAttentionOptions = {},
): Promise<AttentionV1> {
  const now = opts.now ?? new Date();
  const tenantId = principal.tenant_id;

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
          .then((built) => withPausedSchedules(db, tenantId, built))
          .then((built) => withExecutionEnvironments(db, tenantId, built))
          .then((built) => withPendingPairRequests(db, tenantId, built, now))
          .then((built) => withDeviceFacts(db, tenantId, built, now))
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

  let tasksState: "answered" | "failed" = "answered";
  if (permitted("tasks")) {
    try {
      const read = opts.task_reader ?? readTaskAttention;
      own = await retargetRunConversations(db, tenantId, own);
      own.push(...(await read(db, taskAttentionScope(principal), now)));
    } catch {
      tasksState = "failed";
    }
  }

  const sources = {} as Record<AttentionSource, AttentionSourceState>;
  for (const source of ATTENTION_SOURCES) {
    if (!permitted(source)) sources[source] = "not_permitted";
    else if (source === "conversations") sources[source] = conversationsState;
    else if (source === "tasks") sources[source] = tasksState;
    else sources[source] = facts.sources[source] ?? "failed";
  }

  const items: AttentionItem[] = own.map((candidate) => candidate.item);
  for (const candidate of facts.candidates) {
    const gate = access.get(candidate.source);
    if (!gate?.any) continue;
    if (candidate.resource && SOURCE_GATES[candidate.source].resource_type) {
      if (!gate.allows(candidate.resource.id)) continue;
    }
    items.push(candidate.item);
  }
  const mayReadHookNames = items.some(
    (item) => item.trigger?.kind === "inbound_hook" && item.trigger.name,
  )
    ? (await gateFor({ permission: "inbound_hook:read" })).any
    : true;
  const approver =
    principal.kind === "user" && items.some(needsApproval)
      ? await activeApprover(db, { tenant_id: tenantId, user_id: principal.id }).catch(() => null)
      : null;
  const projected = projectAttentionItems(items, mayReadHookNames);
  const waited = await withWaitingOn(db, tenantId, approver, projected).catch(() => projected);
  const paired = await withPairApprovals(db, principal, waited, facts.pair_requests, now).catch(
    () => waited,
  );
  const projectedItems = withDeviceAttention(principal, paired, facts);
  const snoozes =
    principal.kind === "user" && projectedItems.length > 0
      ? await activeSnoozes(db, { tenant_id: tenantId, user_id: principal.id }, now).catch(() => [])
      : [];
  const split = splitSnoozed(projectedItems, snoozes, now);

  return {
    schema_version: ATTENTION_SCHEMA_VERSION,
    generated_at: now.toISOString(),
    sources,
    status: (await gateFor({ permission: "stats:read" })).any ? facts.status : null,
    items: split.items,
    snoozed: split.snoozed,
  };
}
