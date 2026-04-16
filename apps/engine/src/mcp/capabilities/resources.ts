// Connectors, Knowledge Sources, and Skill Candidates → MCP resources.
//
// Each domain object becomes a resource at its respective URI:
//   - `connector://<id>` — connector metadata (no credentials)
//   - `knowledge://<id>` — knowledge source metadata + chunk count
//   - `skill-candidate://<id>` — proposed skill improvement
//
// `resources/subscribe` is wired to outbox pub/sub: events for
// subscribed resources push `notifications/resources/updated`.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type Resource,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import * as connectorSvc from "../../connectors/service.ts";
import type { Db } from "../../db/client.ts";
import * as knowledgeSvc from "../../knowledge/service.ts";
import { logger } from "../../logging/logger.ts";
import { globalEmitter, type PubSubEmitter } from "../../pubsub/emitter.ts";
import type { EventEnvelope } from "../../pubsub/types.ts";
import { can } from "../../rbac/evaluator.ts";
import * as skillCandidateSvc from "../../skill-candidates/service.ts";

export interface RegisterResourcesParams {
  server: Server;
  db: Db;
  principal: ResolvedPrincipal;
  /** Optional emitter override — tests pass a private one for isolation. */
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

export function registerResourcesCapability(p: RegisterResourcesParams): void {
  const { server, db, principal } = p;
  const emitter = p.emitter ?? globalEmitter;
  const subscribed = new Set<string>();

  // Subscribe to the outbox channel for connector OAuth events. We only
  // forward updates whose event payload references a connector that this
  // session has explicitly subscribed to.
  const offConnectorOauth = emitter.on("connector.oauth", async (event: EventEnvelope<unknown>) => {
    if (event.tenant_id !== principal.tenant_id) return;
    const payload = (event.payload ?? {}) as { connector_id?: string };
    const connectorId = payload.connector_id;
    if (!connectorId) return;
    const uri = connectorUri(connectorId);
    if (!subscribed.has(uri)) return;
    try {
      await server.sendResourceUpdated({ uri });
      logger.debug({
        module: "mcp",
        action: "mcp.resource.updated",
        msg: "mcp resource update notification sent",
        uri,
        event_type: event.type,
      });
    } catch (err) {
      logger.warn({
        module: "mcp",
        action: "mcp.resource.updated.failed",
        msg: "failed to send mcp resource update",
        uri,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Subscribe to notification.emitted for knowledge + skill-candidate events.
  // Both event types flow through the generic notification channel.
  const offNotification = emitter.on(
    "notification.emitted",
    async (event: EventEnvelope<unknown>) => {
      if (event.tenant_id !== principal.tenant_id) return;
      const payload = (event.payload ?? {}) as Record<string, unknown>;

      // Knowledge source updates
      const ksId = payload.knowledge_source_id as string | undefined;
      if (ksId) {
        const uri = knowledgeUri(ksId);
        if (subscribed.has(uri)) {
          try {
            await server.sendResourceUpdated({ uri });
          } catch {
            /* best-effort */
          }
        }
      }

      // Skill candidate updates
      const scId = payload.skill_candidate_id as string | undefined;
      if (scId) {
        const uri = skillCandidateUri(scId);
        if (subscribed.has(uri)) {
          try {
            await server.sendResourceUpdated({ uri });
          } catch {
            /* best-effort */
          }
        }
      }
    },
  );

  // Tear down listeners when the server transport closes so we don't
  // leak handlers across reconnects.
  const priorOnClose = server.onclose;
  server.onclose = (): void => {
    offConnectorOauth();
    offNotification();
    subscribed.clear();
    if (typeof priorOnClose === "function") {
      try {
        priorOnClose();
      } catch {
        // ignore
      }
    }
  };

  server.registerCapabilities({
    resources: { listChanged: false, subscribe: true },
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const items = await connectorSvc.listConnectors(principal.tenant_id, {}, db);
    const resources: Resource[] = items
      .filter((cn) => {
        if (principal.allowed_connectors && principal.allowed_connectors !== "all") {
          return principal.allowed_connectors.includes(cn.id);
        }
        return true;
      })
      .map((cn) => ({
        uri: connectorUri(cn.id),
        name: cn.display_name,
        description: `${cn.driver} (${cn.environment})`,
        mimeType: "application/json",
      }));
    // Knowledge Sources
    const knowledgeSources = await knowledgeSvc.listKnowledgeSources(
      { tenant_id: principal.tenant_id, status: "active" },
      db,
    );
    for (const ks of knowledgeSources) {
      resources.push({
        uri: knowledgeUri(ks.id),
        name: ks.name,
        description: `Knowledge (${ks.scope}): ${ks.description ?? ks.source_uri}`,
        mimeType: "application/json",
      });
    }

    // Skill Candidates (proposed only)
    const candidates = await skillCandidateSvc.listSkillCandidates(
      { tenant_id: principal.tenant_id, status: "proposed" },
      db,
    );
    for (const sc of candidates) {
      resources.push({
        uri: skillCandidateUri(sc.id),
        name: `Suggestion: ${sc.title}`,
        description: `${sc.pattern_kind} (${sc.confidence}) — ${sc.body.slice(0, 120)}`,
        mimeType: "application/json",
      });
    }

    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;

    // Knowledge Sources
    if (uri.startsWith("knowledge://")) {
      const id = uri.slice("knowledge://".length);
      const ks = await knowledgeSvc.getKnowledgeSource(principal.tenant_id, id, db);
      if (!ks) throw new Error(`knowledge source not found: ${id}`);
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
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(
              {
                id: ks.id,
                name: ks.name,
                scope: ks.scope,
                source_type: ks.source_type,
                bytes_total: ks.bytes_total,
                chunk_count: ks.chunk_count,
                status: ks.status,
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    // Skill Candidates
    if (uri.startsWith("skill-candidate://")) {
      const id = uri.slice("skill-candidate://".length);
      const sc = await skillCandidateSvc.getSkillCandidate(principal.tenant_id, id, db);
      if (!sc) throw new Error(`skill candidate not found: ${id}`);
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

    if (!uri.startsWith("connector://")) {
      throw new Error(`unsupported uri: ${uri}`);
    }
    const id = uri.slice("connector://".length);
    const cn = await connectorSvc.getConnector(principal.tenant_id, id, db);
    if (!cn) {
      throw new Error(`connector not found: ${id}`);
    }
    // Pass-2 C6: gate resource reads on `connector:read`.
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
    subscribed.add(req.params.uri);
    return {};
  });
  server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribed.delete(req.params.uri);
    return {};
  });
}
