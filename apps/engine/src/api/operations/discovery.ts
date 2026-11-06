import { z } from "@hono/zod-openapi";
import { actorOf } from "../../audit/actor.ts";
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
import { defineOperation, reject } from "./index.ts";

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
});

export const approveDiscoveryArtifactOperation = defineOperation<string, ApproveResult>({
  id: "discovery.approve_artifact",
  summary: "Approve a discovery artifact",
  permission: APPROVE,
  effect: "write",
  audit: AuditAction.DISCOVERY_ARTIFACT_APPROVED,
  async handler(scope, id) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const result = await approveDiscoveryArtifact(
      {
        tenant_id: scope.tenant_id,
        artifact_id: id,
        actor_id: principal.id,
        actor: actorOf(principal),
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
});

export const resolveCapabilityGapOperation = defineOperation<ResolveInput, CapabilityGapView>({
  id: "discovery.resolve_capability_gap",
  summary: "Mark an open or accepted capability gap as resolved",
  permission: APPROVE,
  effect: "write",
  audit: AuditAction.DISCOVERY_ARTIFACT_SUPERSEDED,
  async handler(scope, { id, note }) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const gap = await resolveCapabilityGap(
      {
        tenant_id: scope.tenant_id,
        artifact_id: id,
        note,
        actor_id: principal.id,
        actor: actorOf(principal),
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
