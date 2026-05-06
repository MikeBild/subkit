// In-process EngineClient — same API as `apps/sk/src/engine-client.ts`
// (which hits HTTP), but calls underlying services directly.
//
// Every method is tenant-scoped. The tenant_id + actor_id are captured
// once at construction so individual tool executions don't have to
// re-thread them. RBAC enforcement is delegated to the underlying
// services (most services already tenant-filter); write tools should
// additionally call into `rbac/` helpers before dispatching.

import { and, desc, eq, sql } from "drizzle-orm";
import { getAuditRowById, queryAuditLog } from "../audit/query.ts";
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
import * as identitySvc from "../identity/service.ts";
import * as knowledgeSvc from "../knowledge/service.ts";
import type { UpdateKnowledgeSourceInput } from "../knowledge/types.ts";
import { currentMonthBucket, monthlyUsage } from "../llm/accounting/index.ts";
import { describeConnectorPlaceholders } from "../llm/substitution/resolver.ts";
import * as rbacRoles from "../rbac/roles.ts";
import * as skillCandidatesSvc from "../skill-candidates/service.ts";
import * as skillsSvc from "../skills/service.ts";
import * as tunnelsSvc from "../tunnels/service.ts";
import * as inboundSvc from "../webhooks/inbound/service.ts";
import * as subscriptionsSvc from "../webhooks/outbound/service.ts";
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
    list: (opts?: { status?: "draft" | "active" | "archived"; limit?: number; offset?: number }) =>
      listWorkflows(this.tenant_id, opts ?? {}, this.db),
    get: (id: string) => getWorkflow(this.tenant_id, id, this.db),
    getBySlug: (slug: string) => getWorkflowBySlug(this.tenant_id, slug, this.db),
    delete: (id: string) => deleteWorkflow(this.tenant_id, id, this.actor_id, this.db),
    update: (params: Pick<UpdateWorkflowMetadataInput, "id" | "slug" | "name" | "lifecycle">) =>
      updateWorkflowMetadata(
        {
          tenant_id: this.tenant_id,
          id: params.id,
          ...(params.slug !== undefined ? { slug: params.slug } : {}),
          ...(params.name !== undefined ? { name: params.name } : {}),
          ...(params.lifecycle !== undefined ? { lifecycle: params.lifecycle } : {}),
          actor_id: this.actor_id,
        },
        this.db,
      ),
    count: async () => {
      const [row] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(workflowsTable)
        .where(eq(workflowsTable.tenant_id, this.tenant_id));
      return Number(row?.c ?? 0);
    },
  };

  connectors = {
    list: () => listConnectors(this.tenant_id, {}, this.db),
    get: (id: string) => getConnector(this.tenant_id, id, this.db),
    delete: (id: string) => deleteConnector(this.tenant_id, id, this.actor_id, this.db),
    update: (id: string, patch: UpdateConnectorInput) =>
      updateConnector(this.tenant_id, id, patch, this.actor_id, this.db),
    count: async () => {
      const [row] = await this.db
        .select({ c: sql<number>`count(*)::int` })
        .from(connectorsTable)
        .where(eq(connectorsTable.tenant_id, this.tenant_id));
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
    list: async (opts?: { limit?: number; workflow_id?: string }) => {
      const limit = Math.min(opts?.limit ?? 50, 200);
      const tenantConds = [eq(executionsTable.tenant_id, this.tenant_id)];
      if (opts?.workflow_id) tenantConds.push(eq(executionsTable.workflow_id, opts.workflow_id));
      return await this.db
        .select()
        .from(executionsTable)
        .where(and(...tenantConds))
        .orderBy(desc(executionsTable.created_at))
        .limit(limit);
    },
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
  };

  knowledgeSources = {
    list: () => knowledgeSvc.listKnowledgeSources({ tenant_id: this.tenant_id }, this.db),
    get: (id: string) => knowledgeSvc.getKnowledgeSource(this.tenant_id, id, this.db),
    delete: (id: string) =>
      knowledgeSvc.deleteKnowledgeSource(this.tenant_id, id, this.actor_id, this.db),
    update: (id: string, patch: UpdateKnowledgeSourceInput) =>
      knowledgeSvc.updateKnowledgeSource(
        { tenant_id: this.tenant_id, id, patch, actor_id: this.actor_id },
        this.db,
      ),
    search: (query: string, opts?: { workflow_id?: string; limit?: number }) =>
      knowledgeSvc.searchKnowledge(
        {
          tenant_id: this.tenant_id,
          query,
          ...(opts?.workflow_id ? { workflow_id: opts.workflow_id } : {}),
          ...(opts?.limit ? { limit: opts.limit } : {}),
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
      filters?: Parameters<typeof queryAuditLog>[1],
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

  tunnels = {
    list: () => tunnelsSvc.listTunnels(this.tenant_id, this.db),
    get: (id: string) => tunnelsSvc.getTunnel(this.tenant_id, id, this.db),
    delete: (id: string) => tunnelsSvc.deleteTunnel(this.tenant_id, id, this.actor_id, this.db),
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
   */
  async audit_write(params: {
    resource_type: string;
    resource_id: string;
    action: string;
    result: "success" | "denied" | "error";
    reason?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.db.insert(auditLog).values({
      id,
      tenant_id: this.tenant_id,
      actor_type: this.actor_type,
      actor_id: this.actor_id,
      resource_type: params.resource_type,
      resource_id: params.resource_id,
      action: params.action,
      result: params.result,
      reason: params.reason ?? null,
      metadata: params.metadata ?? {},
    });
    return id;
  }
}
