// In-process EngineClient — same API as `apps/sk/src/engine-client.ts`
// (which hits HTTP), but calls underlying services directly.
//
// Every method is tenant-scoped. The tenant_id + actor_id are captured
// once at construction so individual tool executions don't have to
// re-thread them. RBAC enforcement is delegated to the underlying
// services (most services already tenant-filter); write tools should
// additionally call into `rbac/` helpers before dispatching.

import { and, desc, eq, isNull, sql } from "drizzle-orm";
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
import { listExecutions } from "../execution/list.ts";
import * as identitySvc from "../identity/service.ts";
import { listKnowledgeChunks } from "../knowledge/bundle-service.ts";
import * as knowledgeSvc from "../knowledge/service.ts";
import type { CreateKnowledgeSourceInput, UpdateKnowledgeSourceInput } from "../knowledge/types.ts";
import {
  currentMonthBucket,
  monthlyUsage,
  monthlyUsageForUser,
  resolveUserMonthlyBudget,
} from "../llm/accounting/index.ts";
import { describeConnectorPlaceholders } from "../llm/substitution/resolver.ts";
import * as rbacRoles from "../rbac/roles.ts";
import * as selfHealingSvc from "../self-healing/index.ts";
import * as skillCandidatesSvc from "../skill-candidates/service.ts";
import * as skillsSvc from "../skills/service.ts";
import type { CreateSkillInput, UpdateSkillInput } from "../skills/types.ts";
import * as inboundSvc from "../webhooks/inbound/service.ts";
import * as subscriptionsSvc from "../webhooks/outbound/service.ts";
import { loadCategoryIndex } from "../workflows/catalog-view.ts";
import { listConnectorRefs } from "../workflows/connector-refs.ts";
import {
  deleteWorkflow,
  getWorkflow,
  getWorkflowBySlug,
  listWorkflows,
  type UpdateWorkflowMetadataInput,
  updateWorkflowMetadata,
} from "../workflows/service.ts";

export type EngineClientActorType = "user" | "system_account" | "system";

export interface EngineClientCtx {
  tenant_id: string;
  actor_id: string | null;
  /**
   * Actor kind for audit rows. Defaults to `system` when no actor_id is
   * supplied, `user` when one is. Callers with API-key principals (most
   * operator CLI + MCP paths) should pass `"system_account"` explicitly
   * to match the audit_log CHECK constraint.
   */
  actor_type?: EngineClientActorType;
  db?: Db;
}

export class EngineClient {
  private readonly tenant_id: string;
  private readonly actor_id: string | null;
  private readonly actor_type: EngineClientActorType;
  private readonly db: Db;

  constructor(ctx: EngineClientCtx) {
    this.tenant_id = ctx.tenant_id;
    this.actor_id = ctx.actor_id;
    this.actor_type = ctx.actor_type ?? (ctx.actor_id ? "user" : "system");
    this.db = ctx.db ?? getDb();
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
    /** Derived catalog block per slug, over the whole catalog (see
     *  `workflows/categorize.ts`). Callers enrich list rows with it. */
    categories: () => loadCategoryIndex(this.tenant_id, this.db),
    /** Connector slugs referenced per workflow id (`connector-refs.ts`). */
    connectorRefs: () => listConnectorRefs(this.tenant_id, this.db),
    get: (id: string) => getWorkflow(this.tenant_id, id, this.db),
    getBySlug: (slug: string) => getWorkflowBySlug(this.tenant_id, slug, this.db),
    delete: (id: string) => deleteWorkflow(this.tenant_id, id, this.actor_id, this.db),
    update: (
      params: Pick<
        UpdateWorkflowMetadataInput,
        "id" | "slug" | "name" | "description" | "lifecycle"
      >,
    ) =>
      updateWorkflowMetadata(
        {
          tenant_id: this.tenant_id,
          id: params.id,
          ...(params.slug !== undefined ? { slug: params.slug } : {}),
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.description !== undefined ? { description: params.description } : {}),
          ...(params.lifecycle !== undefined ? { lifecycle: params.lifecycle } : {}),
          actor_id: this.actor_id,
        },
        this.db,
      ),
    count: async () => {
      // Live rows only — a soft-deleted workflow must not inflate the
      // tenant summary (same ground-truth-cardinality contract as the
      // list services).
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
    list: (opts?: { environment?: "dev" | "prod"; category?: string }) =>
      listConnectors(this.tenant_id, opts ?? {}, this.db),
    get: (id: string) => getConnector(this.tenant_id, id, this.db),
    delete: (id: string, opts?: { orphaned_workflow_ids?: string[] }) =>
      deleteConnector(this.tenant_id, id, this.actor_id, this.db, opts),
    update: (id: string, patch: UpdateConnectorInput) =>
      updateConnector(this.tenant_id, id, patch, this.actor_id, this.db),
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
      // Live rows only — mirrors workflows.count.
      const [row] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(connectorsTable)
        .where(
          and(eq(connectorsTable.tenant_id, this.tenant_id), isNull(connectorsTable.deleted_at)),
        );
      return Number(row?.c ?? 0);
    },
    // Describe the placeholder tokens a workflow author (the LLM, usually)
    // should use to reference this connector's URL, credentials, and config
    // without ever inlining a secret. See `llm/substitution/*`.
    describePlaceholders: (slug: string, environment: "dev" | "prod" = "dev") =>
      describeConnectorPlaceholders(slug, {
        tenant_id: this.tenant_id,
        environment,
        db: this.db,
      }),
  };

  executions = {
    list: (opts?: { limit?: number; offset?: number; workflow_id?: string }) =>
      listExecutions(this.tenant_id, opts ?? {}, this.db),
    get: async (id: string) => {
      const rows = await this.db
        .select()
        .from(executionsTable)
        .where(and(eq(executionsTable.tenant_id, this.tenant_id), eq(executionsTable.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },
  };

  skills = {
    list: () => skillsSvc.listSkills({ tenant_id: this.tenant_id }, this.db),
    get: (id: string) => skillsSvc.getSkill(this.tenant_id, id, this.db),
    create: (input: CreateSkillInput) =>
      skillsSvc.createSkill({ tenant_id: this.tenant_id, input, actor_id: this.actor_id }, this.db),
    update: (id: string, patch: UpdateSkillInput) =>
      skillsSvc.updateSkill(this.tenant_id, id, patch, this.actor_id, this.db),
    delete: (id: string) => skillsSvc.deleteSkill(this.tenant_id, id, this.actor_id, this.db),
  };

  skillCandidates = {
    list: () => skillCandidatesSvc.listSkillCandidates({ tenant_id: this.tenant_id }, this.db),
    get: (id: string) => skillCandidatesSvc.getSkillCandidate(this.tenant_id, id, this.db),
  };

  patchCandidates = {
    list: async (opts?: {
      limit?: number;
      status?: "proposed" | "applied" | "rejected" | "superseded";
    }) => {
      const limit = Math.min(opts?.limit ?? 50, 200);
      const tenantConds = [eq(patchCandidatesTable.tenant_id, this.tenant_id)];
      if (opts?.status) tenantConds.push(eq(patchCandidatesTable.status, opts.status));
      return await this.db
        .select()
        .from(patchCandidatesTable)
        .where(and(...tenantConds))
        .orderBy(desc(patchCandidatesTable.created_at))
        .limit(limit);
    },
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
        { tenant_id: this.tenant_id, candidate_id: id, actor_id: this.actor_id },
        this.db,
      ),
  };

  knowledgeSources = {
    list: () => knowledgeSvc.listKnowledgeSources({ tenant_id: this.tenant_id }, this.db),
    get: (id: string) => knowledgeSvc.getKnowledgeSource(this.tenant_id, id, this.db),
    delete: (id: string) =>
      knowledgeSvc.deleteKnowledgeSource(this.tenant_id, id, this.actor_id, this.db),
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
          actor_id: this.actor_id,
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
        { tenant_id: this.tenant_id, id, patch, actor_id: this.actor_id },
        this.db,
      ),
    analyze: (id: string, opts?: { force?: boolean }) =>
      knowledgeSvc.analyzeKnowledgeSource(
        {
          tenant_id: this.tenant_id,
          id,
          actor_id: this.actor_id,
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
    // tenant_id is injected here from the bound principal — callers must NOT
    // supply it (Omit keeps it off the caller-facing type so a tenant can never
    // query another tenant's audit log).
    query: (
      filters?: Omit<Parameters<typeof queryAuditLog>[1], "tenant_id">,
      opts?: Parameters<typeof queryAuditLog>[2],
    ) => queryAuditLog(this.db, { ...(filters ?? {}), tenant_id: this.tenant_id }, opts),
    get: (id: string) => getAuditRowById(this.db, this.tenant_id, id),
  };

  metrics = {
    monthlyTokenUsage: () => monthlyUsage(this.tenant_id, this.db),
    currentMonthBucket: () => currentMonthBucket(),
    llmUsageRecent: async (limit = 50) =>
      await this.db
        .select()
        .from(llmUsageTable)
        .where(eq(llmUsageTable.tenant_id, this.tenant_id))
        .orderBy(desc(llmUsageTable.created_at))
        .limit(Math.min(limit, 200)),
    // Per-user variants — tenant predicate FIRST, then user_id narrowing.
    monthlyTokenUsageForUser: (userId: string) =>
      monthlyUsageForUser(this.tenant_id, userId, this.db),
    userTokenBudget: (userId: string) => resolveUserMonthlyBudget(this.tenant_id, userId, this.db),
    llmUsageRecentForUser: async (userId: string, limit = 50) =>
      await this.db
        .select()
        .from(llmUsageTable)
        .where(and(eq(llmUsageTable.tenant_id, this.tenant_id), eq(llmUsageTable.user_id, userId)))
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
      owner_kind: "user" | "system_account";
      owner_id: string;
      scopes?: string[];
      allowed_workflows?: string[];
      allowed_connectors?: string[];
      expires_at?: Date;
    }) =>
      identitySvc.issueApiKey(
        {
          tenant_id: this.tenant_id,
          owner_kind: input.owner_kind,
          owner_id: input.owner_id,
          ...(input.scopes ? { scopes: input.scopes } : {}),
          ...(input.allowed_workflows ? { allowed_workflows: input.allowed_workflows } : {}),
          ...(input.allowed_connectors ? { allowed_connectors: input.allowed_connectors } : {}),
          ...(input.expires_at ? { expires_at: input.expires_at } : {}),
          actor_id: this.actor_id,
        },
        this.db,
      ),
    revokeApiKey: (id: string) =>
      identitySvc.revokeApiKey({ tenant_id: this.tenant_id, id, actor_id: this.actor_id }, this.db),
    listPortalTokens: () => identitySvc.listPortalTokens(this.tenant_id, this.db),
    revokePortalToken: (id: string) =>
      identitySvc.revokePortalToken(
        { tenant_id: this.tenant_id, id, actor_id: this.actor_id },
        this.db,
      ),
    listSystemAccounts: (opts?: { limit?: number; offset?: number }) =>
      identitySvc.listSystemAccounts(this.tenant_id, opts ?? {}, this.db),
  };

  rbac = {
    listRoles: () => rbacRoles.listRoles(this.db, this.tenant_id),
    getRole: (id: string) => rbacRoles.getRole(this.db, this.tenant_id, id),
    listRolePermissions: (role_id: string) => rbacRoles.listRolePermissions(this.db, role_id),
  };

  hooks = {
    listInbound: () => inboundSvc.listInbound(this.tenant_id, this.db),
    getInbound: (id: string) => inboundSvc.getInbound(this.tenant_id, id, this.db),
  };

  subscriptions = {
    list: () => subscriptionsSvc.listSubscriptions(this.tenant_id, this.db),
    get: (id: string) => subscriptionsSvc.getSubscription(this.tenant_id, id, this.db),
    delete: (id: string) =>
      subscriptionsSvc.deleteSubscription(this.tenant_id, id, this.actor_id, this.db),
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
      const [wfCount, connCount, execRows, auditRows] = await Promise.all([
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
      ]);
      return {
        tenant_id: this.tenant_id,
        workflows: wfCount,
        connectors: connCount,
        executions: Number(execRows[0]?.c ?? 0),
        audit_entries: Number(auditRows[0]?.c ?? 0),
      };
    },
  };

  /**
   * Record a tool-driven audit entry. Conversation write tools call this
   * before / after a tenant-mutating action.
   *
   * LOCAL-SK-ZWEITER-AUDIT-SCHREIBER — this method used to hold its own
   * `insert(auditLog)`. That made it a SECOND writer for the append-only
   * trail, and it reached the table without `scrubSecrets`: measured with a
   * real client, `prompt` and `api_token` landed in the row verbatim across
   * all ~32 call sites. It now goes through `auditAwait`, the same entry
   * point `audit()` uses, so the scrub, the logger mirror, the trace id and
   * the written-rows metric apply to both writers identically. There is no
   * direct insert left here — see the `audit_log has a single writer`
   * invariant.
   */
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
