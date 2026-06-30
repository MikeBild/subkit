// Connectors, Knowledge Sources, Skill Candidates, Workflows, and Files
// → MCP resources.
//
// Each domain object becomes a resource at its respective URI:
//   - `connector://<id>`       — connector metadata (no credentials)
//   - `knowledge://<id>`       — knowledge source metadata + chunk count
//   - `skill-candidate://<id>` — proposed skill improvement
//   - `workflow://<id>`        — committed workflow definition
//   - `file://<fid>`           — file metadata + content (text or base64)
//   - `fixture://<fid>`        — offloaded execution payload (read-only;
//                                emitted by `wf.*` tool results when the
//                                serialized body exceeds MCP_OFFLOAD_CHAR_CAP).
//                                Not enumerated in `ListResources` — the
//                                URI is handed to the client inside the
//                                tool envelope and read back on demand.
//
// `resources/subscribe` is wired to outbox pub/sub: events for
// subscribed resources push `notifications/resources/updated`.
//
// Delivery semantics. Per-channel forwarders and `resources/listChanged`
// are best-effort: a logger.warn on a failed notification is the only retry.
// Clients that need strict consistency on a `workflow://<id>` /
// `connector://<id>` / `knowledge://<id>` / `file://<fid>` resource should
// poll `readResource` on critical paths.
//
// Notification payload is empty by MCP spec. `sendResourceUpdated`
// carries only the URI; the lifecycle event's `type` discriminator
// (`workflow.deleted` vs `workflow.updated` vs `workflow.metadata_updated`
// vs `workflow.version_restored`) is dropped on the floor. Clients that
// need to distinguish delete from rename must re-fetch via `readResource`
// — or, for workflows specifically, observe the lifecycle audit row
// directly through the `/v1/audit-log` HTTP surface.
//
// Two defenses keep cross-tenant / cross-scope notifications from
// leaking via this channel:
//   1. Every forwarder enters through `forwardIfSubscribed`, which
//      checks `event.tenant_id === principal.tenant_id` before doing
//      anything else.
//   2. Forwarders that carry RBAC-sensitive payloads (today: the
//      workflow lifecycle channel, which can push lifecycle pings for
//      workflows a principal cannot `readResource`) pass an
//      `rbacCheck` callback to `forwardIfSubscribed`. The callback
//      runs the same `can()` decision the read handler uses, so
//      neither a portal token narrowed to one workflow nor a
//      custom-role principal lacking `workflow:read` can piggy-back
//      on a subscription URI it learned out-of-band. Always-on by
//      design — the prior portal-only short-circuit was a latent
//      timing-leak surface for custom roles.
//
// Subscribe DoS defenses: the subscribe handler rejects URIs
// outside the four known prefixes (so a client can't trick the
// lifecycle forwarder into a `can()` lookup for nonsense) and caps the
// per-session subscribed-Set at `SUBSCRIBE_CAP`.

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
import { paginate } from "./pagination.ts";

// MCP resources §Error Handling pins resource-not-found to JSON-RPC -32002.
// The SDK's `ErrorCode` enum does not include it (it stops at -32001), so we
// use the spec literal with a cast and a single named constant.
const RESOURCE_NOT_FOUND = -32002 as ErrorCode;

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
function workflowUri(id: string): string {
  return `workflow://${id}`;
}
function fileUri(id: string): string {
  return `file://${id}`;
}

/** Singleton read-only operator surface. Unlike the per-object resources
 *  above it has no id — there is exactly one health digest per tenant,
 *  computed on read. Gated on `stats:read`, mirroring the HTTP route. */
const OPERATOR_HEALTH_DIGEST_URI = "subkit://operator/health-digest";

/** Prefix set the subscribe handler accepts. Anything else is dropped at
 *  subscribe time so a misbehaving client can't grow `subscribed` with
 *  garbage. Keep this in sync with the URI helpers above. */
const SUBSCRIBE_URI_PREFIXES: readonly string[] = [
  "connector://",
  "knowledge://",
  "skill-candidate://",
  "workflow://",
  "file://",
];

/** Cap per-session subscribed-URI tracking so a malicious or buggy
 *  client cannot grow the in-process Set unboundedly via a subscribe
 *  loop. 256 is well above any realistic legitimate client subscribing
 *  to every workflow and connector in a large tenant. Excess
 *  subscriptions are rejected with a logged warn — the legitimate
 *  client sees no behavioural change. */
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

  /**
   * Single forwarder for every emitter → MCP notification path.
   *
   * Guarantees, in order:
   *   1. Cross-tenant events drop silently.
   *   2. Notifications for URIs this session never subscribed to drop
   *      silently — no information leaks via timing or log volume.
   *   3. RBAC re-check (when supplied) runs before `sendResourceUpdated`
   *      so a session that subscribed to a URI it learned out-of-band
   *      (e.g. a portal-scoped principal with a narrow `allowed_*`
   *      list) cannot piggy-back on a notification it could not read.
   *   4. Send failures are logged once at `warn` and swallowed —
   *      at-most-once delivery; clients poll on critical paths (see
   *      file header).
   */
  async function forwardIfSubscribed(args: {
    event: EventEnvelope<unknown>;
    uri: string;
    rbacCheck?: () => Promise<boolean>;
  }): Promise<void> {
    if (args.event.tenant_id !== principal.tenant_id) return;
    if (!subscribed.has(args.uri)) return;
    // Always run the rbacCheck when wired. The earlier optimisation
    // (skip for principals without a portal-scope narrowing) was a
    // latent leak vector: a tenant can mint a custom role that omits
    // `workflow:read` and that principal would still observe the
    // existence + timing of lifecycle events for any guessed
    // `workflow://<id>`. The MCP notification carries no payload —
    // only the URI — but timing alone is signal. The conservative
    // choice is to run `can()` every time and let the permissions
    // cache absorb the cost.
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

  // Subscribe to the outbox channel for connector OAuth events. We only
  // forward updates whose event payload references a connector that this
  // session has explicitly subscribed to.
  const offConnectorOauth = emitter.on("connector.oauth", async (event: EventEnvelope<unknown>) => {
    const payload = (event.payload ?? {}) as { connector_id?: string };
    const connectorId = payload.connector_id;
    if (!connectorId) return;
    scheduleResourceListChanged();
    await forwardIfSubscribed({ event, uri: connectorUri(connectorId) });
  });

  // workflow.lifecycle channel. Every committed
  // create/update/delete/restore/metadata-patch in workflows/service.ts
  // emits here. An `rbacCheck` is wired so that even a portal-scoped
  // principal that learned a workflow id out-of-band cannot subscribe
  // and receive lifecycle pings for workflows it cannot `readResource`.
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

  // Subscribe to notification.emitted for knowledge + skill-candidate events.
  // Both event types flow through the generic notification channel.
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

      // File finalize / status-change pings — matches `knowledge://` /
      // `skill-candidate://` shape. The forwarder is gated on
      // `file:read` so a custom-role principal that subscribed to a
      // `file://<fid>` it learned out-of-band cannot piggy-back on the
      // lifecycle event.
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

  // Tear down listeners when the server transport closes so we don't
  // leak handlers across reconnects.
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
      } catch {
        // ignore
      }
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
    // Knowledge Sources
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
        mimeType: "application/json",
      });
    }

    // Skill Candidates (proposed only)
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

    // Workflows (active only, tenant-scoped).
    //
    // Portal-scoped principals carry `allowed_workflows`; we mirror the
    // connector-block filter above so a portal token narrowed to one
    // workflow cannot enumerate slugs / names of unrelated workflows in
    // the same tenant via `listResources()`. `readResource` is already
    // gated by `workflow:read` RBAC; this is the matching list-side
    // narrowing.
    //
    // Uses `listWorkflowSummaries` (not `listWorkflows`) so each row is
    // a single Postgres-side projection — no `dag` parse per workflow.
    // The MCP list view only needs name / slug / version /
    // step_count anyway.
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

    // Files (ready + not soft-deleted, tenant-scoped). Soft-deleted
    // files are filtered at the SQL layer: once `deleted_at` is set
    // the cleanup cron will reap the row + bytes within the 7-day
    // grace, and the resource must not advertise an id that's about
    // to vanish.
    // `pending` / `uploading` / `scanning` / `failed` / `expired` rows
    // are also filtered — `list_resources` is the MCP surface for
    // *readable* files only.
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

    // Operator health digest — the one read-only operator surface. Enumerate
    // it ONLY for a principal that can actually read it (`stats:read`), the
    // same gate the read handler enforces. Enumerating it for everyone would
    // disclose by listing that the host exposes operator-tier telemetry to a
    // tenant principal (e.g. a portal token) that can never read it — a soft
    // tenant-isolation drift. Gate the listing too, so visibility == access.
    const digestDecision = await can(db, {
      tenant_id: principal.tenant_id,
      principal,
      permission: "stats:read",
      // Probe-style visibility check run on every resources/list (every MCP
      // connect): a principal without stats:read is normal, not an incident.
      // Quiet so it logs at DEBUG instead of an `rbac.denied` WARN per connect.
      // The read handler below stays LOUD — an actual read attempt is
      // operator-actionable.
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
    return { resources: page.page, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
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

    // Operator health digest. Fixed singleton URI, computed on read,
    // tenant-scoped via the principal. Gated on `stats:read` to match the
    // HTTP `/v1/operator/health-digest` surface — this exposes
    // cross-workflow operational posture, not a single object.
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
      const digest = await buildOperatorHealthDigest(db, principal.tenant_id);
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

    // Files. Streams content from the object store after a
    // tenant-isolated lookup. `requireFileForTenant` is the single
    // tenant-isolation chokepoint — a cross-tenant fid throws
    // `FileNotFoundError`, which we surface as `not_found` so existence
    // of another tenant's file never leaks via timing or error text.
    //
    // Text vs blob shape is decided by `isTextLike` against the row's
    // declared `content_type`; the MCP resource-contents envelope
    // supports both branches. Unknown / null content types fall through
    // to the text branch by design (see content-type.ts).
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
      // Awaited like the HTTP route — durable per-read audit row,
      // MCP read volume tax is acceptable for the compliance
      // guarantee. `range` is always `false` here — the MCP envelope
      // returns the full payload; there is no `Range` semantics at
      // this layer.
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

    // Knowledge Sources
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

    // Workflows
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

    // Execution Fixtures (offloaded `wf.*` tool payloads).
    //
    // When a workflow tool result exceeds MCP_OFFLOAD_CHAR_CAP the engine
    // writes the body to `execution_fixtures` and returns an envelope
    // with `uri: fixture://<id>` (apps/engine/src/mcp/capabilities/tools.ts
    // and apps/engine/src/execution/offload.ts). That URI MUST be readable
    // by the same MCP client — anything less is a protocol-level
    // inconsistency where the engine advertises a URI it can't honour.
    //
    // Tenant isolation: the `execution_fixtures.tenant_id` column is the
    // chokepoint; cross-tenant ids return `fixture not found` so
    // existence of another tenant's offload never leaks via timing or
    // error text. RBAC: gated on `execution:read` for the parent
    // execution, mirroring the HTTP `/v1/executions/:id` surface.
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
    const uri = req.params.uri;
    // W-1: only accept URIs we actually forward. An unrecognised
    // prefix would burn a `can()` call on every lifecycle event for
    // nothing — silent free-DoS surface across sibling sessions of
    // the same tenant.
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
    // W-1: cap the per-session subscribed-URI Set. Beyond the cap we
    // refuse silently so a legitimate client at the boundary still
    // works for the URIs it added first; a misbehaving client just
    // stops growing memory.
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
