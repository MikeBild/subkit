// Connectors → MCP resources.
//
// Each connector row becomes a resource at `connector://<id>`. `resources/read`
// returns a JSON envelope with the connector's metadata (no credentials).
// `resources/subscribe` is now wired up to the outbox pub/sub: when an
// event arrives on the `connector.oauth` channel for a subscribed
// connector, we push a `notifications/resources/updated` frame down the
// session's transport. Subscriptions are tracked per server instance and
// cleared automatically when the underlying transport closes.

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
import { logger } from "../../logging/logger.ts";
import { globalEmitter, type PubSubEmitter } from "../../pubsub/emitter.ts";
import type { EventEnvelope } from "../../pubsub/types.ts";
import { can } from "../../rbac/evaluator.ts";

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

  // Tear down the listener when the server transport closes so we don't
  // leak handlers across reconnects.
  const priorOnClose = server.onclose;
  server.onclose = (): void => {
    offConnectorOauth();
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
    return { resources };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
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
