import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  type ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type Resource,
  type ResourceTemplate,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { and, eq, isNull } from "drizzle-orm";
import {
  AuditAction,
  auditAwait,
  bucketSize,
  FileDownloadedMetadataSchema,
} from "../../audit/index.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import * as connectorSvc from "../../connectors/service.ts";
import type { Db } from "../../db/client.ts";
import { executionFixtures, files } from "../../db/schema/index.ts";
import { isTextLike } from "../../files/content-type.ts";
import { FileNotFoundError, requireFileForTenant, storageKey } from "../../files/resolver.ts";
import * as knowledgeSvc from "../../knowledge/service.ts";
import { logger } from "../../logging/logger.ts";
import { buildOperatorHealthDigest } from "../../operator/health-digest.ts";
import { globalEmitter, type PubSubEmitter } from "../../pubsub/emitter.ts";
import type { EventEnvelope } from "../../pubsub/types.ts";
import { can } from "../../rbac/evaluator.ts";
import * as skillCandidateSvc from "../../skill-candidates/service.ts";
import { getObjectStore } from "../../storage/object-store.ts";
import * as workflowSvc from "../../workflows/service.ts";
import { renderKnowledgeResourceText } from "./knowledge-resource.ts";
import { readOffloadedExecutionResource } from "./offloaded-resource.ts";
import { paginate } from "./pagination.ts";

const RESOURCE_NOT_FOUND = -32002 as ErrorCode;

export interface RegisterResourcesParams {
  server: Server;
  db: Db;
  principal: ResolvedPrincipal;
  emitter?: PubSubEmitter;
}

function connectorUri(id: string): string {
  return `connector://${id}`;
}
function knowledgeUri(id: string): string {
  return `knowledge://${id}`;
}
function skillCandidateUri(id: string): string {
  return `skill-candidate://${id}`;
}
function workflowUri(id: string): string {
  return `workflow://${id}`;
}
function fileUri(id: string): string {
  return `file://${id}`;
}

const OPERATOR_HEALTH_DIGEST_URI = "subkit://operator/health-digest";

const SUBSCRIBE_URI_PREFIXES: readonly string[] = [
  "connector://",
  "knowledge://",
  "skill-candidate://",
  "workflow://",
  "file://",
];

const SUBSCRIBE_CAP = 256;
const RESOURCE_LIST_CHANGED_DEBOUNCE_MS = 250;

export function registerResourcesCapability(p: RegisterResourcesParams): void {
  const { server, db, principal } = p;
  const emitter = p.emitter ?? globalEmitter;
  const subscribed = new Set<string>();
  let listChangedTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleResourceListChanged(): void {
    if (listChangedTimer) return;
    listChangedTimer = setTimeout(() => {
      listChangedTimer = undefined;
      void server.sendResourceListChanged().catch((err: unknown) => {
        logger.warn({
          module: "mcp",
          action: "mcp.resources.list_changed.failed",
          msg: "failed to send mcp resources list_changed",
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, RESOURCE_LIST_CHANGED_DEBOUNCE_MS);
    listChangedTimer.unref?.();
  }

  async function forwardIfSubscribed(args: {
    event: EventEnvelope<unknown>;
    uri: string;
    rbacCheck?: () => Promise<boolean>;
  }): Promise<void> {
    if (args.event.tenant_id !== principal.tenant_id) return;
    if (!subscribed.has(args.uri)) return;
    if (args.rbacCheck) {
      const allow = await args.rbacCheck();
      if (!allow) {
        logger.info({
          module: "mcp",
          action: "mcp.resource.updated.rbac_denied",
          msg: "lifecycle forward suppressed by rbac re-check",
          uri: args.uri,
          event_type: args.event.type,
          principal_id: principal.id,
          principal_provider: principal.provider,
        });
        return;
      }
    }
    try {
      await server.sendResourceUpdated({ uri: args.uri });
      logger.debug({
        module: "mcp",
        action: "mcp.resource.updated",
        msg: "mcp resource update notification sent",
        uri: args.uri,
        event_type: args.event.type,
      });
    } catch (err) {
      logger.warn({
        module: "mcp",
        action: "mcp.resource.updated.failed",
        msg: "failed to send mcp resource update",
        uri: args.uri,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const offConnectorOauth = emitter.on("connector.oauth", async (event: EventEnvelope<unknown>) => {
    const payload = (event.payload ?? {}) as { connector_id?: string };
    const connectorId = payload.connector_id;
    if (!connectorId) return;
    scheduleResourceListChanged();
    await forwardIfSubscribed({ event, uri: connectorUri(connectorId) });
  });

  const offWorkflowLifecycle = emitter.on(
    "workflow.lifecycle",
    async (event: EventEnvelope<unknown>) => {
      const payload = (event.payload ?? {}) as { workflow_id?: string };
      const workflowId = payload.workflow_id;
      if (!workflowId) return;
      scheduleResourceListChanged();
      await forwardIfSubscribed({
        event,
        uri: workflowUri(workflowId),
        rbacCheck: async () => {
          const decision = await can(db, {
            tenant_id: principal.tenant_id,
            principal,
            permission: "workflow:read",
            resource: { type: "workflow", id: workflowId },
          });
          return decision.allow;
        },
      });
    },
  );

  const offNotification = emitter.on(
    "notification.emitted",
    async (event: EventEnvelope<unknown>) => {
      const payload = (event.payload ?? {}) as Record<string, unknown>;

      const ksId = payload.knowledge_source_id as string | undefined;
      if (ksId) {
        scheduleResourceListChanged();
        await forwardIfSubscribed({ event, uri: knowledgeUri(ksId) });
      }

      const scId = payload.skill_candidate_id as string | undefined;
      if (scId) {
        scheduleResourceListChanged();
        await forwardIfSubscribed({ event, uri: skillCandidateUri(scId) });
      }

      const fileId = payload.file_id as string | undefined;
      if (fileId) {
        scheduleResourceListChanged();
        await forwardIfSubscribed({
          event,
          uri: fileUri(fileId),
          rbacCheck: async () => {
            const decision = await can(db, {
              tenant_id: principal.tenant_id,
              principal,
              permission: "file:read",
              resource: { type: "file", id: fileId },
            });
            return decision.allow;
          },
        });
      }
    },
  );

  const priorOnClose = server.onclose;
  server.onclose = (): void => {
    offConnectorOauth();
    offNotification();
    offWorkflowLifecycle();
    subscribed.clear();
    if (listChangedTimer) {
      clearTimeout(listChangedTimer);
      listChangedTimer = undefined;
    }
    if (typeof priorOnClose === "function") {
      try {
        priorOnClose();
      } catch {}
    }
  };

  server.registerCapabilities({
    resources: { listChanged: true, subscribe: true },
  });

  server.setRequestHandler(ListResourcesRequestSchema, async (req) => {
    const { rows: items } = await connectorSvc.listConnectors(principal.tenant_id, {}, db);
    const resources: Resource[] = [];
    for (const cn of items) {
      if (principal.allowed_connectors && principal.allowed_connectors !== "all") {
        if (!principal.allowed_connectors.includes(cn.id)) continue;
      }
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "connector:read",
        resource: { type: "connector", id: cn.id },
        quiet: true,
      });
      if (!decision.allow) continue;
      resources.push({
        uri: connectorUri(cn.id),
        name: cn.display_name,
        title: cn.display_name,
        description: `${cn.driver} (${cn.environment})`,
        mimeType: "application/json",
      });
    }
    const knowledgeSources = await knowledgeSvc.listKnowledgeSources(
      { tenant_id: principal.tenant_id, status: "active" },
      db,
    );
    for (const ks of knowledgeSources) {
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "knowledge:read",
        resource: { type: "knowledge", id: ks.id },
        quiet: true,
      });
      if (!decision.allow) continue;
      resources.push({
        uri: knowledgeUri(ks.id),
        name: ks.name,
        title: ks.name,
        description: `Knowledge (${ks.scope})${ks.tags.length > 0 ? ` [${ks.tags.join(", ")}]` : ""}: ${ks.description ?? ks.source_uri}`,
        mimeType: "text/markdown",
      });
    }

    const candidates = await skillCandidateSvc.listSkillCandidates(
      { tenant_id: principal.tenant_id, status: "proposed" },
      db,
    );
    for (const sc of candidates) {
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "skill:read",
        resource: { type: "skill_candidate", id: sc.id },
        quiet: true,
      });
      if (!decision.allow) continue;
      resources.push({
        uri: skillCandidateUri(sc.id),
        name: `Suggestion: ${sc.title}`,
        title: sc.title,
        description: `${sc.pattern_kind} (${sc.confidence}) — ${sc.body.slice(0, 120)}`,
        mimeType: "application/json",
      });
    }

    const { rows: workflowList } = await workflowSvc.listWorkflowSummaries(
      principal.tenant_id,
      { status: "active" },
      db,
    );
    for (const wf of workflowList) {
      if (principal.allowed_workflows && principal.allowed_workflows !== "all") {
        if (!principal.allowed_workflows.includes(wf.id)) continue;
      }
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "workflow:read",
        resource: { type: "workflow", id: wf.id },
        quiet: true,
      });
      if (!decision.allow) continue;
      resources.push({
        uri: workflowUri(wf.id),
        name: wf.name,
        title: wf.name,
        description: `Workflow (${wf.slug}) — v${wf.current_version ?? 0}, ${wf.step_count} steps`,
        mimeType: "application/json",
      });
    }

    const fileRows = await db
      .select({
        id: files.id,
        filename: files.filename,
        content_type: files.content_type,
        size_bytes: files.size_bytes,
      })
      .from(files)
      .where(
        and(
          eq(files.tenant_id, principal.tenant_id),
          eq(files.status, "ready"),
          isNull(files.deleted_at),
        ),
      );
    for (const f of fileRows) {
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "file:read",
        resource: { type: "file", id: f.id },
        quiet: true,
      });
      if (!decision.allow) continue;
      resources.push({
        uri: fileUri(f.id),
        name: f.filename,
        title: f.filename,
        description: `File (${f.content_type ?? "application/octet-stream"}, ${f.size_bytes} bytes)`,
        mimeType: f.content_type ?? "application/octet-stream",
        size: f.size_bytes,
      });
    }

    const digestDecision = await can(db, {
      tenant_id: principal.tenant_id,
      principal,
      permission: "stats:read",
      quiet: true,
    });
    if (digestDecision.allow) {
      resources.push({
        uri: OPERATOR_HEALTH_DIGEST_URI,
        name: "Operator health digest",
        title: "Operator health digest",
        description:
          "Deterministic, LLM-free summary of failing runs, pending self-healing fixes, and leading-indicator risk signals.",
        mimeType: "application/json",
      });
    }

    const page = paginate("resources/list", resources, req.params?.cursor);
    return {
      resources: page.page,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async (req) => {
    const templates: ResourceTemplate[] = [];
    const checks: Array<{
      permission: string;
      template: ResourceTemplate;
    }> = [
      {
        permission: "connector:read",
        template: {
          uriTemplate: "connector://{id}",
          name: "Connector",
          title: "Connector",
          description: "Tenant connector metadata without credentials.",
          mimeType: "application/json",
        },
      },
      {
        permission: "knowledge:read",
        template: {
          uriTemplate: "knowledge://{id}",
          name: "Knowledge source",
          title: "Knowledge source",
          description: "Tenant knowledge source metadata.",
          mimeType: "application/json",
        },
      },
      {
        permission: "skill:read",
        template: {
          uriTemplate: "skill-candidate://{id}",
          name: "Skill candidate",
          title: "Skill candidate",
          description: "Proposed skill improvement awaiting operator approval.",
          mimeType: "application/json",
        },
      },
      {
        permission: "workflow:read",
        template: {
          uriTemplate: "workflow://{id}",
          name: "Workflow",
          title: "Workflow",
          description: "Committed workflow definition.",
          mimeType: "application/json",
        },
      },
      {
        permission: "file:read",
        template: {
          uriTemplate: "file://{id}",
          name: "File",
          title: "File",
          description: "Tenant file metadata and content.",
          mimeType: "application/octet-stream",
        },
      },
      {
        permission: "execution:read",
        template: {
          uriTemplate: "fixture://{id}",
          name: "Execution fixture",
          title: "Execution fixture",
          description: "Offloaded execution payload returned from a tool result.",
          mimeType: "application/json",
        },
      },
      {
        permission: "stats:read",
        template: {
          uriTemplate: OPERATOR_HEALTH_DIGEST_URI,
          name: "Operator health digest",
          title: "Operator health digest",
          description: "Singleton tenant operator health digest.",
          mimeType: "application/json",
        },
      },
    ];
    for (const check of checks) {
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: check.permission,
        quiet: true,
      });
      if (decision.allow) templates.push(check.template);
    }
    const page = paginate("resources/templates/list", templates, req.params?.cursor);
    return {
      resourceTemplates: page.page,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;

    if (uri === OPERATOR_HEALTH_DIGEST_URI) {
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "stats:read",
      });
      if (!decision.allow) {
        const err = new Error(decision.reason ?? "permission_denied") as Error & { code?: number };
        err.code = -32001;
        throw err;
      }
      const digest = await buildOperatorHealthDigest(db, principal);
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(digest, null, 2),
          },
        ],
      };
    }

    if (uri.startsWith("file://")) {
      const fid = uri.slice("file://".length);
      let row: Awaited<ReturnType<typeof requireFileForTenant>>;
      try {
        row = await requireFileForTenant(db, principal.tenant_id, fid);
      } catch (err) {
        if (err instanceof FileNotFoundError) {
          throw new McpError(RESOURCE_NOT_FOUND, `file not found: ${fid}`);
        }
        throw err;
      }
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "file:read",
        resource: { type: "file", id: row.id },
      });
      if (!decision.allow) {
        const err = new Error(decision.reason ?? "permission_denied") as Error & {
          code?: number;
        };
        err.code = -32001;
        throw err;
      }
      await auditAwait(
        {
          tenant_id: principal.tenant_id,
          actor_type: principal.kind === "user" ? "user" : "system_account",
          actor_id: principal.id,
          action: AuditAction.FILE_DOWNLOADED,
          resource_type: "file",
          resource_id: row.id,
          result: "success",
          metadata: FileDownloadedMetadataSchema.parse({
            file_id: row.id,
            content_type: row.content_type,
            size_bytes_bucket: bucketSize(row.size_bytes),
            range: false,
            request_source: "mcp",
          }),
        },
        db,
      );
      const stream = await getObjectStore().openRead(storageKey(row.storage_uri));
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const mimeType = row.content_type ?? "application/octet-stream";
      const body = isTextLike(row.content_type)
        ? { uri, mimeType, text: buf.toString("utf8") }
        : { uri, mimeType, blob: buf.toString("base64") };
      return { contents: [body] };
    }

    if (uri.startsWith("knowledge://")) {
      const id = uri.slice("knowledge://".length);
      const ks = await knowledgeSvc.getKnowledgeSource(principal.tenant_id, id, db);
      if (!ks) throw new McpError(RESOURCE_NOT_FOUND, `knowledge source not found: ${id}`);
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "knowledge:read",
        resource: { type: "knowledge", id: ks.id },
      });
      if (!decision.allow) {
        const err = new Error(decision.reason ?? "permission_denied") as Error & { code?: number };
        err.code = -32001;
        throw err;
      }
      const text = await renderKnowledgeResourceText(ks, principal.tenant_id, db);
      return {
        contents: [{ uri, mimeType: "text/markdown", text }],
      };
    }

    if (uri.startsWith("skill-candidate://")) {
      const id = uri.slice("skill-candidate://".length);
      const sc = await skillCandidateSvc.getSkillCandidate(principal.tenant_id, id, db);
      if (!sc) throw new McpError(RESOURCE_NOT_FOUND, `skill candidate not found: ${id}`);
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "skill:read",
        resource: { type: "skill_candidate", id: sc.id },
      });
      if (!decision.allow) {
        const err = new Error(decision.reason ?? "permission_denied") as Error & { code?: number };
        err.code = -32001;
        throw err;
      }
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                id: sc.id,
                title: sc.title,
                body: sc.body,
                pattern_kind: sc.pattern_kind,
                confidence: sc.confidence,
                evidence_count: sc.evidence_count,
                scope: sc.scope,
                status: sc.status,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (uri.startsWith("workflow://")) {
      const id = uri.slice("workflow://".length);
      const wf = await workflowSvc.getWorkflow(principal.tenant_id, id, db);
      if (!wf) throw new McpError(RESOURCE_NOT_FOUND, `workflow not found: ${id}`);
      const decision = await can(db, {
        tenant_id: principal.tenant_id,
        principal,
        permission: "workflow:read",
        resource: { type: "workflow", id: wf.id },
      });
      if (!decision.allow) {
        const err = new Error(decision.reason ?? "permission_denied") as Error & {
          code?: number;
        };
        err.code = -32001;
        throw err;
      }
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                id: wf.id,
                slug: wf.slug,
                name: wf.name,
                description: wf.description ?? wf.definition.description ?? null,
                lifecycle: wf.lifecycle,
                current_version: wf.current_version,
                definition: wf.definition,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (uri.startsWith("s3://")) {
      const { executionId, body } = await readOffloadedExecutionResource(db, principal, uri);
      logger.debug({
        module: "mcp",
        action: "mcp.resource.read",
        msg: "mcp read object-store offload",
        execution_id: executionId,
      });
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(body),
          },
        ],
      };
    }

    if (uri.startsWith("fixture://")) {
      const id = uri.slice("fixture://".length);
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        throw new Error(`invalid fixture id: ${id}`);
      }
      const rows = await db
        .select({
          id: executionFixtures.id,
          execution_id: executionFixtures.execution_id,
          body: executionFixtures.body,
          kind: executionFixtures.kind,
          byte_size: executionFixtures.byte_size,
        })
        .from(executionFixtures)
        .where(
          and(eq(executionFixtures.tenant_id, principal.tenant_id), eq(executionFixtures.id, id)),
        )
        .limit(1);
      const row = rows[0];
      if (!row) throw new McpError(RESOURCE_NOT_FOUND, `fixture not found: ${id}`);
      if (row.execution_id) {
        const decision = await can(db, {
          tenant_id: principal.tenant_id,
          principal,
          permission: "execution:read",
          resource: { type: "execution", id: row.execution_id },
        });
        if (!decision.allow) {
          const err = new Error(decision.reason ?? "permission_denied") as Error & {
            code?: number;
          };
          err.code = -32001;
          throw err;
        }
      }
      logger.debug({
        module: "mcp",
        action: "mcp.resource.read",
        msg: "mcp read fixture",
        fixture_id: row.id,
        execution_id: row.execution_id ?? null,
        kind: row.kind,
        bytes: row.byte_size ?? null,
      });
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(row.body ?? null),
          },
        ],
      };
    }

    if (!uri.startsWith("connector://")) {
      throw new Error(`unsupported uri: ${uri}`);
    }
    const id = uri.slice("connector://".length);
    const cn = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!cn) {
      throw new McpError(RESOURCE_NOT_FOUND, `connector not found: ${id}`);
    }
    const decision = await can(db, {
      tenant_id: principal.tenant_id,
      principal,
      permission: "connector:read",
      resource: { type: "connector", id: cn.id },
    });
    if (!decision.allow) {
      const err = new Error(decision.reason ?? "permission_denied") as Error & {
        code?: number;
      };
      err.code = -32001;
      throw err;
    }
    logger.debug({
      module: "mcp",
      action: "mcp.resource.read",
      msg: "mcp read connector",
      connector_id: cn.id,
      principal_id: principal.id,
    });
    const body = {
      id: cn.id,
      name: cn.display_name,
      slug: cn.slug,
      driver: cn.driver,
      environment: cn.environment,
      auth_type: cn.auth_type,
      base_url: cn.base_url,
    };
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(body, null, 2),
        },
      ],
    };
  });

  server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    const uri = req.params.uri;
    if (!SUBSCRIBE_URI_PREFIXES.some((p) => uri.startsWith(p))) {
      logger.debug({
        module: "mcp",
        action: "mcp.resource.subscribe.rejected",
        msg: "subscribe rejected — unsupported uri prefix",
        uri,
        principal_id: principal.id,
      });
      return {};
    }
    if (!subscribed.has(uri) && subscribed.size >= SUBSCRIBE_CAP) {
      logger.warn({
        module: "mcp",
        action: "mcp.resource.subscribe.capped",
        msg: "subscribe rejected — per-session cap reached",
        uri,
        cap: SUBSCRIBE_CAP,
        principal_id: principal.id,
      });
      return {};
    }
    subscribed.add(uri);
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribed.delete(req.params.uri);
    return {};
  });
}
