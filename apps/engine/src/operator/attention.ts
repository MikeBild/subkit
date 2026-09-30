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
// Where each item comes from lives in attention-readers.ts.

import type { ResolvedPrincipal } from "../auth/types.ts";
import type { Db } from "../db/client.ts";
import type { PreviewClassification } from "../execution/classify.ts";
import { can, resourceAccess } from "../rbac/evaluator.ts";
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
  /** What a held workflow's refused starts come from — a schedule or a named
   *  webhook — so the sentence names the thing that waits. Null unless held. */
  trigger: { kind: "schedule" | "inbound_hook"; name: string | null } | null;
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
  // A hook's name is inbound-hook data: without inbound_hook:read the item
  // still says a webhook waits, but not which one.
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
