import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import type { PreviewClassification } from "../execution/classify.ts";
import { can, resourceAccess } from "../rbac/evaluator.ts";
import type { BoundaryGrowth } from "../workflows/authority-growth.ts";
import {
  type AttentionReaderOverrides,
  buildTenantFacts,
  type Candidate,
  readOwnConversations,
  type TenantFacts,
} from "./attention-readers.ts";
import type { HealthState } from "./operational-overview.ts";
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
  "intake",
  "budget",
  "risk",
] as const;
export type AttentionSource = (typeof ATTENTION_SOURCES)[number];
export type AttentionSourceState = "answered" | "failed" | "not_permitted";

export type AttentionClass = "stopped" | "failing" | "decide";
export type AttentionSeverity = "critical" | "urgent" | "notice";
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
  "version_awaiting_approval",
  "version_needs_repair",
  "approval_expiring",
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
  "intake_collected",
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
  href: string;
  primary: boolean;
  permission: string;
}

export interface AttentionItem {
  id: string;
  class: AttentionClass;
  severity: AttentionSeverity;
  kind: string;
  subject: {
    kind: (typeof ATTENTION_SUBJECT_KINDS)[number];
    id: string;
    name: string | null;
  } | null;
  reason: AttentionReason;
  trigger: { kind: "schedule" | "inbound_hook"; name: string | null } | null;
  approval?: {
    version: number;
    environment: "dev" | "prod";
    growth?: BoundaryGrowth[];
  };
  repair?: {
    step_id: string | null;
    code: string | null;
    remedy_kind: "patch" | "prepare" | "declare" | "reconnect" | "author";
    steps: number;
    candidate_id: string | null;
    execution_id: string | null;
  };
  cause_class: PreviewClassification | null;
  counts: {
    patches?: number;
    failures?: number;
    consecutive_failures?: number;
    skills?: number;
    intake?: number;
  };
  since: string | null;
  deadline: string | null;
  detail: string | null;
  actions: AttentionAction[];
}

export interface AttentionV1 {
  schema_version: typeof ATTENTION_SCHEMA_VERSION;
  generated_at: string;
  sources: Record<AttentionSource, AttentionSourceState>;
  status: { health_state: HealthState; next_run_at: string | null } | null;
  items: AttentionItem[];
}

export function attentionAllClear(attention: AttentionV1): boolean {
  return (
    attention.items.length === 0 &&
    Object.values(attention.sources).every((state) => state !== "failed")
  );
}

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
  intake: { permission: "intake:read" },
  budget: { permission: "stats:read" },
  risk: { permission: "stats:read" },
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
  const value = buildTenantFacts(db, tenantId, now, {}).then(
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

const CLASS_RANK: Record<AttentionClass, number> = { stopped: 0, failing: 1, decide: 2 };

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
  readers?: AttentionReaderOverrides;
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

  const items: AttentionItem[] = own.map((candidate) => candidate.item);
  for (const candidate of facts.candidates) {
    const gate = access.get(candidate.source);
    if (!gate?.any) continue;
    if (candidate.resource && SOURCE_GATES[candidate.source].resource_type) {
      if (!gate.allows(candidate.resource.id)) continue;
    }
    items.push(candidate.item);
  }
  if (items.some((item) => item.trigger?.kind === "inbound_hook" && item.trigger.name)) {
    const hooks = await gateFor({ permission: "inbound_hook:read" });
    if (!hooks.any) {
      for (const item of items) {
        if (item.trigger?.kind === "inbound_hook") item.trigger = { ...item.trigger, name: null };
      }
    }
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
