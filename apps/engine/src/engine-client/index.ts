import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Actor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { getAuditRowById, queryAuditLog } from "../audit/query.ts";
import type { AuditEntry } from "../audit/types.ts";
import { promoteConnector } from "../connectors/promotion.ts";
import {
  deleteConnector,
  getConnector,
  listConnectors,
  updateConnector,
} from "../connectors/service.ts";
import type { UpdateConnectorInput } from "../connectors/types.ts";
import type { Db } from "../db/client.ts";
import { getDb } from "../db/client.ts";
import {
  auditLog,
  connectorDocuments,
  connectors as connectorsTable,
  executions as executionsTable,
  llmUsage as llmUsageTable,
  patchCandidates as patchCandidatesTable,
  workflows as workflowsTable,
} from "../db/schema/index.ts";
import { type ListExecutionsOptions, listExecutions } from "../execution/list.ts";
import { loadExecutionOutcome } from "../execution/outcome.ts";
import * as identitySvc from "../identity/service.ts";
import { listKnowledgeChunks } from "../knowledge/bundle-service.ts";
import * as knowledgeSvc from "../knowledge/service.ts";
import type { CreateKnowledgeSourceInput, UpdateKnowledgeSourceInput } from "../knowledge/types.ts";
import {
  currentMonthBucket,
  monthlyBudgetFigures,
  monthlyUsage,
  monthlyUsageForUser,
  readTenantMonthlyBudget,
  resolveMonthlyBudget,
  resolveUserMonthlyBudget,
} from "../llm/accounting/index.ts";
import { describeConnectorPlaceholders } from "../llm/substitution/resolver.ts";
import * as rbacRoles from "../rbac/roles.ts";
import type { ScopeIssuer } from "../rbac/scope-issuance.ts";
import { loadTriggerBindings } from "../scheduler/trigger-bindings.ts";
import * as selfHealingSvc from "../self-healing/index.ts";
import * as skillCandidatesSvc from "../skill-candidates/service.ts";
import type { SkillCandidateStatus } from "../skill-candidates/types.ts";
import * as skillsSvc from "../skills/service.ts";
import type { CreateSkillInput, UpdateSkillInput } from "../skills/types.ts";
import { readLlmWindowCost, statsBucketFor } from "../stats/llm-cost.ts";
import * as inboundSvc from "../webhooks/inbound/service.ts";
import * as subscriptionsSvc from "../webhooks/outbound/service.ts";
import { loadCategoryVocabulary } from "../workflows/catalog-view.ts";
import { listConnectorRefs } from "../workflows/connector-refs.ts";
import {
  deleteWorkflow,
  getWorkflow,
  getWorkflowBySlug,
  listWorkflows,
  type UpdateWorkflowMetadataInput,
  updateWorkflowMetadata,
} from "../workflows/service.ts";

export type EngineClientActorType = "user" | "system_account" | "system" | "unknown";

interface EngineClientCtx {
  tenant_id: string;
  actor_id: string | null;
  actor_type?: EngineClientActorType;
  db?: Db;
}

export class EngineClient {
  private readonly tenant_id: string;
  private readonly actor_id: string | null;
  private readonly actor_type: EngineClientActorType;
  private readonly api_key_creator: identitySvc.ApiKeyCreator | null;
  private readonly db: Db;

  constructor(ctx: EngineClientCtx) {
    this.tenant_id = ctx.tenant_id;
    if (ctx.actor_type === "system") {
      this.actor_type = "system";
      this.actor_id = null;
    } else if (ctx.actor_type === "unknown") {
      this.actor_type = "unknown";
      this.actor_id = null;
    } else if (ctx.actor_type) {
      this.actor_type = ctx.actor_id ? ctx.actor_type : "unknown";
      this.actor_id = ctx.actor_id;
    } else {
      this.actor_type = ctx.actor_id ? "unknown" : "system";
      this.actor_id = null;
    }
    this.api_key_creator =
      this.actor_type === "system"
        ? { kind: "system", id: null }
        : (this.actor_type === "user" || this.actor_type === "system_account") && this.actor_id
          ? { kind: this.actor_type, id: this.actor_id }
          : null;
    this.db = ctx.db ?? getDb();
  }

  private get actor(): Actor | null {
    if (!this.actor_id || this.actor_type === "system" || this.actor_type === "unknown")
      return null;
    return { kind: this.actor_type, id: this.actor_id };
  }

  private get knowledgeActor(): Actor | { kind: "unknown" } | null {
    return this.actor_type === "unknown" ? { kind: "unknown" } : this.actor;
  }

  private get connectorActor(): Actor | { kind: "unknown" } | null {
    if (this.actor_type === "unknown") return { kind: "unknown" };
    return this.actor;
  }

  private get subscriptionActor(): Actor | { kind: "unknown" } | null {
    if (this.actor_type === "unknown") return { kind: "unknown" };
    return this.actor;
  }

  get context(): EngineClientCtx {
    return {
      tenant_id: this.tenant_id,
      actor_id: this.actor_id,
      actor_type: this.actor_type,
      db: this.db,
    };
  }

  workflows = {
    list: (opts?: {
      status?: "draft" | "active" | "archived";
      limit?: number;
      offset?: number;
      category?: string;
      connector?: string;
    }) => listWorkflows(this.tenant_id, opts ?? {}, this.db),
    categories: () => loadCategoryVocabulary(this.tenant_id, this.db),
    connectorRefs: () => listConnectorRefs(this.tenant_id, this.db),
    triggerBindings: (ids: readonly string[]) => loadTriggerBindings(this.tenant_id, ids, this.db),
    get: (id: string) => getWorkflow(this.tenant_id, id, this.db),
    getBySlug: (slug: string) => getWorkflowBySlug(this.tenant_id, slug, this.db),
    delete: (id: string) =>
      deleteWorkflow(this.tenant_id, id, this.actor_id, this.db, this.actor_type),
    update: (
      params: Pick<
        UpdateWorkflowMetadataInput,
        "id" | "slug" | "name" | "description" | "category" | "lifecycle"
      >,
    ) =>
      updateWorkflowMetadata(
        {
          tenant_id: this.tenant_id,
          id: params.id,
          ...(params.slug !== undefined ? { slug: params.slug } : {}),
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.description !== undefined ? { description: params.description } : {}),
          ...(params.category !== undefined ? { category: params.category } : {}),
          ...(params.lifecycle !== undefined ? { lifecycle: params.lifecycle } : {}),
          actor_id: this.actor_id,
          actor_type: this.actor_type,
        },
        this.db,
      ),
    count: async () => {
      const [row] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(workflowsTable)
        .where(
          and(eq(workflowsTable.tenant_id, this.tenant_id), isNull(workflowsTable.deleted_at)),
        );
      return Number(row?.c ?? 0);
    },
  };

  connectors = {
    list: (opts?: { environment?: "dev" | "prod"; category?: string; driver?: string }) =>
      listConnectors(this.tenant_id, opts ?? {}, this.db),
    get: (id: string) => getConnector(this.tenant_id, id, this.db),
    delete: (id: string, opts?: { orphaned_workflow_ids?: string[] }) =>
      deleteConnector(this.tenant_id, id, this.connectorActor, this.db, opts),
    update: (id: string, patch: UpdateConnectorInput) =>
      updateConnector(this.tenant_id, id, patch, this.connectorActor, this.db),
    promote: (id: string, strategy: "copy" | "move", idempotencyKey: string) =>
      promoteConnector(
        {
          tenant_id: this.tenant_id,
          source_connector_id: id,
          strategy,
          idempotency_key: idempotencyKey,
          actor_id: this.actor_id,
          actor_type: this.actor_type,
          request_source: "conversation_tool",
        },
        this.db,
      ),
    count: async () => {
      const [row] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(connectorsTable)
        .where(
          and(eq(connectorsTable.tenant_id, this.tenant_id), isNull(connectorsTable.deleted_at)),
        );
      return Number(row?.c ?? 0);
    },
    describePlaceholders: (slug: string, environment: "dev" | "prod" = "dev") =>
      describeConnectorPlaceholders(slug, {
        tenant_id: this.tenant_id,
        environment,
        db: this.db,
      }),
  };

  executions = {
    list: (opts?: ListExecutionsOptions) => listExecutions(this.tenant_id, opts ?? {}, this.db),
    get: async (id: string) => {
      const rows = await this.db
        .select()
        .from(executionsTable)
        .where(and(eq(executionsTable.tenant_id, this.tenant_id), eq(executionsTable.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },
    outcome: (row: Parameters<typeof loadExecutionOutcome>[1]) =>
      loadExecutionOutcome(this.tenant_id, row, this.db),
  };

  skills = {
    list: () => skillsSvc.listSkills({ tenant_id: this.tenant_id }, this.db),
    get: (id: string) => skillsSvc.getSkill(this.tenant_id, id, this.db),
    create: (input: CreateSkillInput) =>
      skillsSvc.createSkill(
        {
          tenant_id: this.tenant_id,
          input,
          actor_id: this.actor_id,
          actor_type: this.actor_type,
        },
        this.db,
      ),
    update: (id: string, patch: UpdateSkillInput) =>
      skillsSvc.updateSkill(this.tenant_id, id, patch, this.actor_id, this.db, this.actor_type),
    delete: (id: string) =>
      skillsSvc.deleteSkill(this.tenant_id, id, this.actor_id, this.db, this.actor_type),
  };

  skillCandidates = {
    list: (opts?: { limit?: number; offset?: number; status?: SkillCandidateStatus }) =>
      skillCandidatesSvc.listSkillCandidates({ tenant_id: this.tenant_id, ...opts }, this.db),
    count: (opts?: { status?: SkillCandidateStatus }) =>
      skillCandidatesSvc.countSkillCandidates({ tenant_id: this.tenant_id, ...opts }, this.db),
    get: (id: string) => skillCandidatesSvc.getSkillCandidate(this.tenant_id, id, this.db),
  };

  patchCandidates = {
    list: async (opts?: {
      limit?: number;
      status?: "proposed" | "applied" | "rejected" | "superseded" | "inapplicable";
    }) => {
      const limit = Math.min(opts?.limit ?? 50, 200);
      const tenantConds = [eq(patchCandidatesTable.tenant_id, this.tenant_id)];
      if (opts?.status) tenantConds.push(eq(patchCandidatesTable.status, opts.status));
      const rows = await this.db
        .select()
        .from(patchCandidatesTable)
        .where(and(...tenantConds))
        .orderBy(desc(patchCandidatesTable.created_at))
        .limit(limit);
      const readiness = await selfHealingSvc.readPatchReadinessBatch(this.tenant_id, rows, this.db);
      return rows.map((row, index) => ({
        ...row,
        reviewable: readiness[index]?.reviewable ?? false,
        review_reason: readiness[index]?.review_reason ?? null,
      }));
    },
    openDecisions: () =>
      selfHealingSvc.readOpenPatchDecisions(this.db, this.tenant_id, { limit: 0 }),
    get: async (id: string) => {
      const rows = await this.db
        .select()
        .from(patchCandidatesTable)
        .where(
          and(eq(patchCandidatesTable.tenant_id, this.tenant_id), eq(patchCandidatesTable.id, id)),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    preview: (id: string) => selfHealingSvc.previewPatchCandidate(this.tenant_id, id, this.db),
    dryRun: (id: string) =>
      selfHealingSvc.dryRunPatchCandidate(
        {
          tenant_id: this.tenant_id,
          candidate_id: id,
          actor_id: this.actor_id,
          actor_type: this.actor_type,
        },
        this.db,
      ),
  };

  knowledgeSources = {
    list: () => knowledgeSvc.listKnowledgeSources({ tenant_id: this.tenant_id }, this.db),
    get: (id: string) => knowledgeSvc.getKnowledgeSource(this.tenant_id, id, this.db),
    delete: (id: string) =>
      knowledgeSvc.deleteKnowledgeSource(
        this.tenant_id,
        id,
        this.actor_id,
        this.db,
        this.knowledgeActor,
      ),
    create: (params: {
      input: CreateKnowledgeSourceInput;
      upload: { buffer: Buffer | Uint8Array; filename: string; mime?: string };
      source_type_override?: "file_upload" | "inline" | "url";
      source_uri_override?: string;
    }) =>
      knowledgeSvc.createKnowledgeSource(
        {
          tenant_id: this.tenant_id,
          input: params.input,
          upload: params.upload,
          actor: this.actor,
          ...(params.source_type_override
            ? { source_type_override: params.source_type_override }
            : {}),
          ...(params.source_uri_override
            ? { source_uri_override: params.source_uri_override }
            : {}),
        },
        this.db,
      ),
    update: (id: string, patch: UpdateKnowledgeSourceInput) =>
      knowledgeSvc.updateKnowledgeSource(
        {
          tenant_id: this.tenant_id,
          id,
          patch,
          actor_id: this.actor_id,
          actor: this.knowledgeActor,
        },
        this.db,
      ),
    analyze: (id: string, opts?: { force?: boolean }) =>
      knowledgeSvc.analyzeKnowledgeSource(
        {
          tenant_id: this.tenant_id,
          id,
          actor_id: this.actor_id,
          actor: this.knowledgeActor,
          ...(opts?.force !== undefined ? { force: opts.force } : {}),
        },
        this.db,
      ),
    search: (query: string, opts?: { workflow_id?: string; tags?: string[]; limit?: number }) =>
      knowledgeSvc.searchKnowledge(
        {
          tenant_id: this.tenant_id,
          query,
          ...(opts?.workflow_id ? { workflow_id: opts.workflow_id } : {}),
          ...(opts?.tags ? { tags: opts.tags } : {}),
          ...(opts?.limit ? { limit: opts.limit } : {}),
        },
        this.db,
      ),
    chunks: (id: string, opts?: { path?: string; limit?: number; offset?: number }) =>
      listKnowledgeChunks(
        {
          tenant_id: this.tenant_id,
          knowledge_source_id: id,
          ...(opts?.path !== undefined ? { path: opts.path } : {}),
          ...(opts?.limit !== undefined ? { limit: opts.limit } : {}),
          ...(opts?.offset !== undefined ? { offset: opts.offset } : {}),
        },
        this.db,
      ),
  };

  connectorDocs = {
    list: async (connector_id: string, limit = 50) => {
      return await this.db
        .select()
        .from(connectorDocuments)
        .where(
          and(
            eq(connectorDocuments.tenant_id, this.tenant_id),
            eq(connectorDocuments.connector_id, connector_id),
          ),
        )
        .limit(limit);
    },
  };

  audit = {
    query: (
      filters?: Omit<Parameters<typeof queryAuditLog>[1], "tenant_id">,
      opts?: Parameters<typeof queryAuditLog>[2],
    ) => queryAuditLog(this.db, { ...(filters ?? {}), tenant_id: this.tenant_id }, opts),
    get: (id: string) => getAuditRowById(this.db, this.tenant_id, id),
  };

  metrics = {
    monthlyTokenUsage: () => monthlyUsage(this.tenant_id, this.db),
    tenantTokenBudget: () => resolveMonthlyBudget(this.tenant_id),
    currentMonthBucket: () => currentMonthBucket(),
    tenantMonthlyBudget: () => readTenantMonthlyBudget(this.tenant_id, this.db),
    monthlyBudgetFigures: (used: number, budget: number | null) =>
      monthlyBudgetFigures(used, budget),
    llmWindowCost: (window: { from: Date; to: Date; userId?: string | null }) =>
      readLlmWindowCost(this.db, {
        tenantId: this.tenant_id,
        bucket: statsBucketFor(window.from, window.to),
        from: window.from,
        to: window.to,
        tz: "UTC",
        userId: window.userId ?? undefined,
      }),
    llmUsageRecent: async (limit = 50) =>
      await this.db
        .select()
        .from(llmUsageTable)
        .where(eq(llmUsageTable.tenant_id, this.tenant_id))
        .orderBy(desc(llmUsageTable.created_at))
        .limit(Math.min(limit, 200)),
    monthlyTokenUsageForUser: (userId: string) =>
      monthlyUsageForUser(this.tenant_id, userId, this.db),
    userTokenBudget: (userId: string) => resolveUserMonthlyBudget(this.tenant_id, userId, this.db),
    llmUsageRecentForUser: async (userId: string, limit = 50) =>
      await this.db
        .select()
        .from(llmUsageTable)
        .where(
          and(
            eq(llmUsageTable.tenant_id, this.tenant_id),
            eq(llmUsageTable.user_id, userId),
            eq(llmUsageTable.actor_type, "user"),
          ),
        )
        .orderBy(desc(llmUsageTable.created_at))
        .limit(Math.min(limit, 200)),
  };

  identity = {
    whoami: () => identitySvc.getTenant(this.tenant_id, this.db),
    listUsers: (opts?: { limit?: number; offset?: number }) =>
      identitySvc.listUsers(this.tenant_id, opts ?? {}, this.db),
    getUser: (id: string) => identitySvc.getUser(this.tenant_id, id, this.db),
    listApiKeys: () => identitySvc.listApiKeys(this.tenant_id, this.db),
    getApiKey: (id: string) => identitySvc.getApiKey(this.tenant_id, id, this.db),
    issueApiKey: (input: {
      issuer: ScopeIssuer;
      owner_kind: "user" | "system_account";
      owner_id: string;
      scopes?: string[];
      allowed_workflows?: string[];
      allowed_connectors?: string[];
      expires_at?: Date;
    }) =>
      identitySvc.issueApiKey(
        {
          issuer: input.issuer,
          tenant_id: this.tenant_id,
          owner_kind: input.owner_kind,
          owner_id: input.owner_id,
          ...(input.scopes ? { scopes: input.scopes } : {}),
          ...(input.allowed_workflows ? { allowed_workflows: input.allowed_workflows } : {}),
          ...(input.allowed_connectors ? { allowed_connectors: input.allowed_connectors } : {}),
          ...(input.expires_at ? { expires_at: input.expires_at } : {}),
          actor: this.api_key_creator,
        },
        this.db,
      ),
    revokeApiKey: (id: string) =>
      identitySvc.revokeApiKey(
        {
          tenant_id: this.tenant_id,
          id,
          actor_id: this.actor_id,
          actor_kind: this.actor_type,
        },
        this.db,
      ),
    listPortalTokens: () => identitySvc.listPortalTokens(this.tenant_id, this.db),
    revokePortalToken: (id: string) =>
      identitySvc.revokePortalToken(
        {
          tenant_id: this.tenant_id,
          id,
          actor_id: this.actor_id,
          actor_kind: this.actor_type,
        },
        this.db,
      ),
    listSystemAccounts: (opts?: { limit?: number; offset?: number }) =>
      identitySvc.listSystemAccounts(this.tenant_id, opts ?? {}, this.db),
  };

  rbac = {
    listRoles: () => rbacRoles.listRoles(this.db, this.tenant_id),
    getRole: (id: string) => rbacRoles.getRole(this.db, this.tenant_id, id),
    listRolePermissions: (role_id: string) =>
      rbacRoles.listRolePermissions(this.db, this.tenant_id, role_id),
  };

  hooks = {
    listInbound: () => inboundSvc.listInbound(this.tenant_id, this.db),
    getInbound: (id: string) => inboundSvc.getInbound(this.tenant_id, id, this.db),
  };

  subscriptions = {
    list: () => subscriptionsSvc.listSubscriptions(this.tenant_id, this.db),
    get: (id: string) => subscriptionsSvc.getSubscription(this.tenant_id, id, this.db),
    delete: (id: string) =>
      subscriptionsSvc.deleteSubscription(this.tenant_id, id, this.subscriptionActor, this.db),
    update: (
      id: string,
      patch: Pick<
        subscriptionsSvc.UpdateSubscriptionInput,
        "event_pattern" | "target_url" | "active" | "secret" | "rotating_secret"
      >,
    ) =>
      subscriptionsSvc.updateSubscription(
        {
          tenant_id: this.tenant_id,
          id,
          actor_id: this.actor_id,
          actor: this.actor,
          actor_type: this.actor_type,
          ...(patch.event_pattern !== undefined ? { event_pattern: patch.event_pattern } : {}),
          ...(patch.target_url !== undefined ? { target_url: patch.target_url } : {}),
          ...(patch.active !== undefined ? { active: patch.active } : {}),
          ...(patch.secret !== undefined ? { secret: patch.secret } : {}),
          ...(patch.rotating_secret !== undefined
            ? { rotating_secret: patch.rotating_secret }
            : {}),
        },
        this.db,
      ),
  };

  status = {
    summary: async () => {
      const [wfCount, connCount, execRows, auditRows, openPatches] = await Promise.all([
        this.workflows.count(),
        this.connectors.count(),
        this.db
          .select({ c: sql<number>`count(*)::int` })
          .from(executionsTable)
          .where(eq(executionsTable.tenant_id, this.tenant_id)),
        this.db
          .select({ c: sql<number>`count(*)::int` })
          .from(auditLog)
          .where(eq(auditLog.tenant_id, this.tenant_id)),
        this.patchCandidates.openDecisions(),
      ]);
      return {
        tenant_id: this.tenant_id,
        workflows: wfCount,
        connectors: connCount,
        executions: Number(execRows[0]?.c ?? 0),
        audit_entries: Number(auditRows[0]?.c ?? 0),
        patch_decisions_open: openPatches.open_total,
      };
    },
  };

  async audit_write(params: {
    resource_type: string;
    resource_id: string;
    action: string;
    result: "success" | "denied" | "error";
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const entry = await auditAwait(
      {
        tenant_id: this.tenant_id,
        actor_type: this.actor_type,
        actor_id: this.actor_id,
        resource_type: params.resource_type,
        resource_id: params.resource_id,
        action: params.action as AuditEntry["action"],
        result: params.result,
        reason: params.reason ?? null,
        metadata: params.metadata ?? {},
      },
      this.db,
    );
    return entry.id;
  }
}
