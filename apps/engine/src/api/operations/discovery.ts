import { z } from "@hono/zod-openapi";
import { type Actor, actorOf } from "../../audit/actor.ts";
import { AuditAction } from "../../audit/types.ts";
import {
  approveDiscoveryArtifact,
  getDiscoveryArtifact,
  getDiscoveryRun,
  listCapabilityGaps,
  listDiscoveryArtifacts,
  listDiscoveryRuns,
  rejectDiscoveryArtifact,
  resolveCapabilityGap,
  toCapabilityGapView,
} from "../../discovery/service.ts";
import {
  DiscoveryArtifactSchema,
  type DiscoveryArtifactView,
  DiscoveryRunSchema,
  type DiscoveryRunView,
} from "../../discovery/types.ts";
import { defineOperation, isRejection, type OperationActor, reject } from "./index.ts";

const TAGS = ["discovery"] as const;
const READ = "discovery:read";
const APPROVE = "discovery:approve";

const RunIdParam = z.object({ id: z.string().uuid() });
const ArtifactIdParam = z.object({ id: z.string().uuid() });

const ArtifactStatusSchema = z.enum(["proposed", "approved", "rejected", "superseded"]);

const ListRunsQuery = z
  .object({
    status: z.enum(["pending", "analyzing", "synthesizing", "completed", "failed"]).optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .openapi("ListDiscoveryRunsQuery");

const ListArtifactsQuery = z
  .object({
    kind: z.enum(["connector", "skill", "knowledge_source"]).optional(),
    status: ArtifactStatusSchema.optional(),
    limit: z.coerce.number().int().positive().max(200).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .openapi("ListDiscoveryArtifactsQuery");

const ListGapsQuery = z.object({
  status: ArtifactStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const DiscoveryRunListResponse = z
  .object({ items: z.array(DiscoveryRunSchema) })
  .openapi("DiscoveryRunListResponse");

const DiscoveryArtifactListResponse = z
  .object({ items: z.array(DiscoveryArtifactSchema) })
  .openapi("DiscoveryArtifactListResponse");

const ApproveResponse = z
  .object({
    approved: z.boolean(),
    materialized_id: z.string().nullable(),
    materialized_type: z.string().nullable(),
  })
  .openapi("ApproveDiscoveryArtifactResponse");

const RejectBody = z
  .object({ reason: z.string().optional() })
  .openapi("RejectDiscoveryArtifactBody");

const RejectResponse = z.object({ rejected: z.boolean() });

const CapabilityGapSchema = z
  .object({
    id: z.string(),
    status: ArtifactStatusSchema,
    state: z.enum(["open", "accepted", "declined", "resolved"]),
    missing_capability: z.string().nullable(),
    requested: z.string(),
    suggested_kind: z.enum(["connector", "workflow", "knowledge", "unknown"]),
    occurrences: z.number().int(),
    resolution: z.object({ note: z.string(), resolved_at: z.string() }).nullable(),
    decline_reason: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("CapabilityGap");

const CapabilityGapList = z
  .object({ items: z.array(CapabilityGapSchema) })
  .openapi("CapabilityGapList");

const ResolveBody = z
  .object({ note: z.string().trim().min(1).max(2000) })
  .openapi("ResolveCapabilityGapBody");

const ListArtifactsToolInput = z
  .object({
    run_id: z.string().uuid(),
    kind: z.enum(["connector", "skill", "knowledge_source"]).optional(),
    status: ArtifactStatusSchema.optional(),
    limit: z.number().int().min(1).max(200).default(50),
    offset: z.number().int().min(0).default(0),
  })
  .openapi("ListDiscoveryArtifactsInput");

const GetArtifactToolInput = z
  .object({ id: z.string().uuid() })
  .openapi("GetDiscoveryArtifactInput");

const ListGapsToolInput = z
  .object({
    status: z
      .enum(["proposed", "approved", "rejected", "superseded", "all"])
      .optional()
      .describe(
        "Gap status: proposed = open, approved = accepted, rejected = declined, superseded = resolved. Default proposed; all lists every status.",
      ),
    limit: z.number().int().positive().max(200).default(50),
  })
  .openapi("ListCapabilityGapsToolInput");

type ListRunsInput = z.infer<typeof ListRunsQuery>;
type ListArtifactsInput = z.infer<typeof ListArtifactsQuery> & { readonly run_id: string };
type ListGapsInput = z.infer<typeof ListGapsQuery>;
type CapabilityGapView = ReturnType<typeof toCapabilityGapView>;

interface IdInput {
  readonly id: string;
}

interface RejectInput extends IdInput {
  readonly reason?: string | undefined;
}

interface ResolveInput extends IdInput {
  readonly note: string;
}

interface ApproveResult {
  readonly materialized_id: string | null;
  readonly materialized_type: string | null;
}

function auditActorOf(actor: OperationActor): Actor | null {
  if (!actor.id || (actor.type !== "user" && actor.type !== "system_account")) return null;
  return { id: actor.id, kind: actor.type };
}

const ApproveToolInput = z
  .object({ id: z.string().uuid() })
  .openapi("ApproveDiscoveryArtifactInput");

const ResolveGapToolInput = z
  .object({
    id: z.string().uuid(),
    note: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .describe("What now covers this gap, in one or two sentences, without secrets."),
  })
  .openapi("ResolveCapabilityGapInput");

function idOf(param: unknown): string {
  return (param as IdInput).id;
}

export const listDiscoveryRunsOperation = defineOperation<ListRunsInput, DiscoveryRunView[]>({
  id: "discovery.list_runs",
  summary: "List discovery runs",
  permission: READ,
  effect: "read",
  handler: async (scope, q) =>
    await listDiscoveryRuns(
      {
        tenant_id: scope.tenant_id,
        ...(q.status ? { status: q.status } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      scope.db,
    ),
  http: {
    method: "get",
    path: "/v1/discovery/runs",
    tags: TAGS,
    query: ListRunsQuery,
    response: DiscoveryRunListResponse,
    toInput: ({ query }) => query as ListRunsInput,
    toBody: (items) => ({ items }),
  },
});

export const getDiscoveryRunOperation = defineOperation<string, DiscoveryRunView>({
  id: "discovery.get_run",
  summary: "Get a discovery run",
  permission: READ,
  effect: "read",
  async handler(scope, id) {
    const run = await getDiscoveryRun(scope.tenant_id, id, scope.db);
    return run ?? reject.notFound("discovery_run");
  },
  http: {
    method: "get",
    path: "/v1/discovery/runs/{id}",
    tags: TAGS,
    params: RunIdParam,
    response: DiscoveryRunSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => idOf(param),
    toBody: (run) => run,
  },
});

export const listDiscoveryArtifactsOperation = defineOperation<
  ListArtifactsInput,
  DiscoveryArtifactView[]
>({
  id: "discovery.list_artifacts",
  summary: "List artifacts for a discovery run",
  permission: READ,
  effect: "read",
  handler: async (scope, q) =>
    await listDiscoveryArtifacts(
      {
        tenant_id: scope.tenant_id,
        run_id: q.run_id,
        ...(q.kind ? { kind: q.kind } : {}),
        ...(q.status ? { status: q.status } : {}),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      },
      scope.db,
    ),
  http: {
    method: "get",
    path: "/v1/discovery/runs/{id}/artifacts",
    tags: TAGS,
    params: RunIdParam,
    query: ListArtifactsQuery,
    response: DiscoveryArtifactListResponse,
    toInput: ({ param, query }) => ({
      ...(query as z.infer<typeof ListArtifactsQuery>),
      run_id: idOf(param),
    }),
    toBody: (items) => ({ items }),
  },
  tool: {
    name: "list_discovery_artifacts",
    description:
      "List proposals produced by a discovery run — connectors, skills, knowledge sources extracted from uploaded artifacts.",
    use_case:
      "After uploading a spec / docs / code sample via @file: or via the discovery flow, list what the engine auto-proposed so you can triage with the operator before calling approve_discovery_artifact.",
    important_notes: [
      "Scoped to a single `run_id`; call list_discovery_runs (via engine-client) if you need to find recent runs.",
      "Status defaults to all — filter with {status:'proposed'} when looking for work items.",
      "Ordered newest-first; hard cap 200.",
    ],
    input: ListArtifactsToolInput,
    gate: "deferred",
    toInput: (raw) => raw as ListArtifactsInput,
    toResult: (outcome) => {
      if (isRejection(outcome)) return { ok: false, data: { error: outcome.code } };
      return {
        ok: true,
        data: {
          persistence: "none" as const,
          artifacts: outcome.map((r) => ({
            id: r.id,
            kind: r.kind,
            status: r.status,
            title: r.title,
            description: r.description,
            confidence: r.confidence,
            materialized_id: r.materialized_id,
            materialized_type: r.materialized_type,
            created_at: r.created_at,
          })),
        },
      };
    },
  },
});

export const getDiscoveryArtifactOperation = defineOperation<string, DiscoveryArtifactView>({
  id: "discovery.get_artifact",
  summary: "Get a discovery artifact",
  permission: READ,
  effect: "read",
  async handler(scope, id) {
    const artifact = await getDiscoveryArtifact(scope.tenant_id, id, scope.db);
    return artifact ?? reject.notFound("discovery_artifact");
  },
  http: {
    method: "get",
    path: "/v1/discovery/artifacts/{id}",
    tags: TAGS,
    params: ArtifactIdParam,
    response: DiscoveryArtifactSchema,
    errors: { 404: "Not found" },
    toInput: ({ param }) => idOf(param),
    toBody: (artifact) => artifact,
  },
  tool: {
    name: "get_discovery_artifact",
    description: "Fetch a single discovery artifact including its draft + evidence excerpts.",
    use_case:
      "Call before approving to inspect what the engine auto-proposed. The `draft` field is a complete CreateConnectorInput / CreateSkillInput / KnowledgeDraft ready to materialise.",
    important_notes: [
      "Evidence carries file_ids + excerpts — use them to cite the source to the operator before asking for approval.",
      "Returns null-equivalent (`artifact_not_found`) when the id is invalid for this tenant.",
    ],
    input: GetArtifactToolInput,
    gate: "deferred",
    toInput: (raw) => (raw as IdInput).id,
    toResult: (outcome) => {
      if (isRejection(outcome)) {
        return {
          ok: false,
          data: {
            persistence: "none" as const,
            error: { code: "artifact_not_found", message: "no discovery artifact with that id" },
          },
        };
      }
      return { ok: true, data: { persistence: "none" as const, artifact: outcome } };
    },
  },
});

export const approveDiscoveryArtifactOperation = defineOperation<string, ApproveResult>({
  id: "discovery.approve_artifact",
  summary: "Approve a discovery artifact",
  permission: APPROVE,
  effect: "write",
  audit: AuditAction.DISCOVERY_ARTIFACT_APPROVED,
  async handler(scope, id) {
    const actor = scope.actor;
    const result = await approveDiscoveryArtifact(
      {
        tenant_id: scope.tenant_id,
        artifact_id: id,
        actor_id: actor.id,
        actor: auditActorOf(actor),
      },
      scope.db,
    );
    return result ?? reject.notFound("discovery_artifact");
  },
  http: {
    method: "post",
    path: "/v1/discovery/artifacts/{id}/approve",
    tags: TAGS,
    params: ArtifactIdParam,
    response: ApproveResponse,
    errors: { 404: "Not found" },
    toInput: ({ param }) => idOf(param),
    toBody: (result) => ({ approved: true, ...result }),
  },
  tool: {
    name: "approve_discovery_artifact",
    description:
      "Approve a proposed discovery artifact (connector / skill / knowledge source). Records the human decision; materialisation is performed by downstream tools.",
    use_case:
      "After the operator has reviewed a proposed artifact via get_discovery_artifact, flip it to approved. This is a human gate — only call after `ask_user_confirm` returns confirmed=true.",
    important_notes: [
      "Artifact must be in `proposed` status; already-approved / rejected rows return `already_materialized` or `not_found`.",
      "Approval alone does NOT create the downstream row — a follow-up call (start_connector_from_description or start_connector_from_template / knowledge upsert) materialises the draft; a skill is collected with save_learning and becomes a skill only after a person confirms it in Intake.",
      "Writes an audit entry under action=discovery.artifact_approved.",
    ],
    input: ApproveToolInput,
    gate: "enforced",
    permission: { resourceType: "discovery_artifact" },
    toInput: (raw) => (raw as IdInput).id,
    toResult: (outcome, id) => {
      if (isRejection(outcome)) {
        return {
          ok: false,
          data: {
            persistence: "none" as const,
            error: {
              code: "already_materialized",
              message: "artifact not in `proposed` status (may be missing or already resolved)",
            },
          },
        };
      }
      return {
        ok: true,
        data: {
          persistence: "saved" as const,
          resource_type: "discovery_artifact",
          resource_id: id,
          materialized_id: outcome.materialized_id,
          materialized_type: outcome.materialized_type,
        },
      };
    },
  },
});

export const listCapabilityGapsOperation = defineOperation<ListGapsInput, CapabilityGapView[]>({
  id: "discovery.list_capability_gaps",
  summary: "List capability gaps with their state",
  permission: READ,
  effect: "read",
  async handler(scope, q) {
    const gaps = await listCapabilityGaps(
      {
        tenant_id: scope.tenant_id,
        ...(q.status ? { status: q.status } : {}),
        ...(q.limit ? { limit: q.limit } : {}),
      },
      scope.db,
    );
    return gaps.map(toCapabilityGapView);
  },
  http: {
    method: "get",
    path: "/v1/discovery/capability-gaps",
    tags: TAGS,
    query: ListGapsQuery,
    response: CapabilityGapList,
    toInput: ({ query }) => query as ListGapsInput,
    toBody: (items) => ({ items }),
  },
  tool: {
    name: "list_capability_gaps",
    description:
      "List recorded capability gaps — requests the assistant could not serve because no connector, workflow, or knowledge source exists for them (captured from cannot_help). Returns a deduped backlog ranked by how often each gap recurred, so the operator can prioritise what to build next. Each gap carries its state (open, accepted, declined, resolved) and, once resolved, the resolution note.",
    input: ListGapsToolInput,
    gate: "enforced",
    permission: { resourceType: "capability_gap" },
    toInput: (raw) => {
      const args = ListGapsToolInput.parse(raw);
      return {
        ...(args.status === "all" ? {} : { status: args.status ?? "proposed" }),
        limit: args.limit,
      };
    },
    toResult: (outcome) => {
      if (isRejection(outcome)) return { ok: false, data: { error: outcome.code } };
      return { ok: true, data: { gaps: outcome } };
    },
  },
});

export const resolveCapabilityGapOperation = defineOperation<ResolveInput, CapabilityGapView>({
  id: "discovery.resolve_capability_gap",
  summary: "Mark an open or accepted capability gap as resolved",
  permission: APPROVE,
  effect: "write",
  audit: AuditAction.DISCOVERY_ARTIFACT_SUPERSEDED,
  async handler(scope, { id, note }) {
    const actor = scope.actor;
    const gap = await resolveCapabilityGap(
      {
        tenant_id: scope.tenant_id,
        artifact_id: id,
        note,
        actor_id: actor.id,
        actor: auditActorOf(actor),
      },
      scope.db,
    );
    return gap ? toCapabilityGapView(gap) : reject.notFound("capability_gap");
  },
  http: {
    method: "post",
    path: "/v1/discovery/capability-gaps/{id}/resolve",
    tags: TAGS,
    params: ArtifactIdParam,
    body: ResolveBody,
    response: CapabilityGapSchema,
    errors: { 404: "Not found" },
    toInput: ({ param, json }) => ({ id: idOf(param), note: (json as ResolveInput).note }),
    toBody: (gap) => gap,
  },
  tool: {
    name: "resolve_capability_gap",
    description:
      "Mark an open or accepted capability gap as resolved, with a short note on what now covers it. The gap stays listed under status `superseded` (state resolved); a later cannot_help for the same capability opens a new gap.",
    use_case:
      "After the operator confirms that a recorded gap is no longer a gap — a connector, workflow, tool or product change now covers it — record that decision so the backlog shows what is still open.",
    important_notes: [
      "Only gaps in `proposed` (open) or `approved` (accepted) status can be resolved; others return `not_resolvable`.",
      "Writes an audit entry under action=discovery.artifact_superseded.",
    ],
    input: ResolveGapToolInput,
    gate: "enforced",
    permission: { resourceType: "capability_gap" },
    toInput: (raw) => {
      const args = raw as ResolveInput;
      return { id: args.id, note: args.note };
    },
    toResult: (outcome, { id }) => {
      if (isRejection(outcome)) {
        return {
          ok: false,
          data: {
            persistence: "none" as const,
            error: {
              code: "not_resolvable",
              message: "no open or accepted capability gap with this id",
            },
          },
        };
      }
      return {
        ok: true,
        data: {
          persistence: "saved" as const,
          resource_type: "discovery_artifact",
          resource_id: id,
          gap: outcome,
        },
      };
    },
  },
});

export const rejectDiscoveryArtifactOperation = defineOperation<RejectInput, true>({
  id: "discovery.reject_artifact",
  summary: "Reject a discovery artifact",
  permission: APPROVE,
  effect: "write",
  audit: AuditAction.DISCOVERY_ARTIFACT_REJECTED,
  async handler(scope, { id, reason }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const rejected = await rejectDiscoveryArtifact(
      {
        tenant_id: scope.tenant_id,
        artifact_id: id,
        actor_id: principal.id,
        actor: actorOf(principal),
        ...(reason ? { reason } : {}),
      },
      scope.db,
    );
    return rejected ? true : reject.notFound("discovery_artifact");
  },
  http: {
    method: "post",
    path: "/v1/discovery/artifacts/{id}/reject",
    tags: TAGS,
    params: ArtifactIdParam,
    body: RejectBody,
    response: RejectResponse,
    errors: { 404: "Not found" },
    toInput: ({ param, json }) => ({ id: idOf(param), reason: (json as RejectInput).reason }),
    toBody: () => ({ rejected: true }),
  },
});
