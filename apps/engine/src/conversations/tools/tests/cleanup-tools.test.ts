import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  apiKeys,
  auditLog,
  knowledgeSources,
  portalTokens,
  subscriptions,
  users,
} from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { tunnelRegistry } from "../../../tunnels/registry.ts";
import { fingerprintAgentToken, getTunnel, upsertTunnel } from "../../../tunnels/service.ts";
import type { TunnelSocket } from "../../../tunnels/types.ts";
import { createWorkflow } from "../../../workflows/service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import {
  deleteConnectorTool,
  deleteKnowledgeSourceTool,
  deleteSubscriptionTool,
  deleteTunnelTool,
  deleteWorkflowTool,
  revokeApiKeyTool,
  revokePortalTokenTool,
} from "../generated/writes/cleanup.ts";
import type { ToolContext } from "../index.ts";

let ctx: ConversationTestCtx;
let memberUserId: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("cleanup_tools");
  const [member] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: ctx.tenant_id,
      email: "member-cleanup@test.local",
      role: "member",
    })
    .returning();
  memberUserId = member!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeToolContext(
  actorId = ctx.user_id,
  actorType: "user" | "system_account" = "user",
): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: legacy; review before changing
    actor_id: actorId,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: actorId,
      actor_type: actorType,
      db: ctx.testDb.db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

async function countAudit(action: string, resourceId: string): Promise<number> {
  const rows = await ctx.testDb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenant_id),
        eq(auditLog.action, action),
        eq(auditLog.resource_id, resourceId),
      ),
    );
  return rows.length;
}

async function seedWorkflow(name: string, slug: string) {
  const result = await createWorkflow(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      def: {
        name,
        slug,
        steps: [{ id: "wait-1", kind: "wait", duration_ms: 1 }],
      },
    },
    ctx.testDb.db,
  );
  if ("errors" in result) throw new Error(result.errors.join(", "));
  return result.workflow;
}

function dummySocket(): TunnelSocket {
  return {
    send() {},
    close() {},
    readyState: 1,
  };
}

describe("cleanup write conversation tools", () => {
  test("delete_workflow deletes by slug and writes domain + conversation audit rows", async () => {
    const workflow = await seedWorkflow("Cleanup Workflow", "cleanup-workflow");
    const result = await deleteWorkflowTool.execute(makeToolContext(), { slug: workflow.slug });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      deleted: true,
      workflow: { id: workflow.id, slug: workflow.slug, name: workflow.name },
    });
    const data = result.data as { audit_log_id?: string };
    expect(typeof data.audit_log_id).toBe("string");
    expect(
      await ctx.testDb.db.select().from(auditLog).where(eq(auditLog.id, data.audit_log_id!)),
    ).toHaveLength(1);
    expect(await countAudit("workflow.deleted", workflow.id)).toBe(1);
    expect(await countAudit("conversation.delete_workflow", workflow.id)).toBe(1);
  });

  test("delete_workflow denies a member and records policy.denied", async () => {
    const workflow = await seedWorkflow("Protected Workflow", "protected-workflow");
    const result = await deleteWorkflowTool.execute(makeToolContext(memberUserId), {
      id: workflow.id,
    });
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      error: "permission_denied",
      permission: "workflow:delete",
    });
    const stillThere = await makeToolContext().engineClient.workflows.get(workflow.id);
    expect(stillThere?.id).toBe(workflow.id);
    expect(await countAudit("policy.denied", workflow.id)).toBe(1);
    expect(await countAudit("workflow.deleted", workflow.id)).toBe(0);
  });

  test("delete_connector soft-deletes the seeded connector", async () => {
    const result = await deleteConnectorTool.execute(makeToolContext(), { id: ctx.connector_id });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      deleted: true,
      connector: { id: ctx.connector_id },
    });
    expect(await countAudit("connector.deleted", ctx.connector_id)).toBe(1);
    expect(await countAudit("conversation.delete_connector", ctx.connector_id)).toBe(1);
  });

  test("delete_knowledge_source soft-deletes a knowledge source", async () => {
    const [source] = await ctx.testDb.db
      .insert(knowledgeSources)
      .values({
        tenant_id: ctx.tenant_id,
        name: "Cleanup KB",
        slug: "cleanup-kb",
        source_type: "inline",
        source_uri: "inline://cleanup-kb",
        version: "v1",
      })
      .returning();
    const result = await deleteKnowledgeSourceTool.execute(makeToolContext(), { id: source!.id });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      deleted: true,
      knowledge_source: { id: source!.id, slug: "cleanup-kb" },
    });
    expect(await countAudit("knowledge_source.deleted", source!.id)).toBe(1);
    expect(await countAudit("conversation.delete_knowledge_source", source!.id)).toBe(1);
  });

  test("delete_subscription deletes an outbound subscription", async () => {
    const [subscription] = await ctx.testDb.db
      .insert(subscriptions)
      .values({
        tenant_id: ctx.tenant_id,
        event_pattern: "workflow.*",
        target_url: "https://example.test/hook",
        secret_ciphertext: Buffer.from("cipher"),
        secret_iv: Buffer.from("iv"),
        secret_auth_tag: Buffer.from("tag"),
      })
      .returning();
    const result = await deleteSubscriptionTool.execute(makeToolContext(), {
      id: subscription!.id,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      deleted: true,
      subscription: { id: subscription!.id, event_pattern: "workflow.*" },
    });
    expect(await countAudit("subscription.deleted", subscription!.id)).toBe(1);
    expect(await countAudit("conversation.delete_subscription", subscription!.id)).toBe(1);
  });

  test("delete_tunnel unregisters the tunnel and detaches live registry targets", async () => {
    const { tunnel } = await upsertTunnel(
      {
        tenant_id: ctx.tenant_id,
        name: "cleanup-tunnel",
        agent_token_sha256: fingerprintAgentToken("cleanup-token"),
        state: "registered",
        targets: [{ name: "internal-api", local_base_url: "http://internal" }],
      },
      ctx.testDb.db,
    );
    tunnelRegistry.attach({
      tunnel_id: tunnel.id,
      tenant_id: ctx.tenant_id,
      tunnel_name: tunnel.name,
      target: "internal-api",
      socket: dummySocket(),
      concurrency_cap: 8,
    });

    const result = await deleteTunnelTool.execute(makeToolContext(), { id: tunnel.id });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      deleted: true,
      tunnel: { id: tunnel.id, name: tunnel.name, target_count: 1 },
    });
    expect(tunnelRegistry.get(ctx.tenant_id, "internal-api")).toBeUndefined();
    expect(await getTunnel(ctx.tenant_id, tunnel.id, ctx.testDb.db)).toBeNull();
    expect(await countAudit("tunnel.unregistered", tunnel.id)).toBe(1);
    expect(await countAudit("conversation.delete_tunnel", tunnel.id)).toBe(1);
  });

  test("revoke_api_key revokes a key and records both audit rows", async () => {
    const [apiKey] = await ctx.testDb.db
      .insert(apiKeys)
      .values({
        tenant_id: ctx.tenant_id,
        user_id: ctx.user_id,
        prefix: "sk_cleanup_key",
        token_sha256: "sha256-api-key",
        scopes: [],
      })
      .returning();
    const result = await revokeApiKeyTool.execute(makeToolContext(), { id: apiKey!.id });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      revoked: true,
      api_key: { id: apiKey!.id, prefix: "sk_cleanup_key" },
    });
    expect(await countAudit("api_key.revoked", apiKey!.id)).toBe(1);
    expect(await countAudit("conversation.revoke_api_key", apiKey!.id)).toBe(1);
  });

  test("revoke_portal_token revokes a token and records both audit rows", async () => {
    const [portalToken] = await ctx.testDb.db
      .insert(portalTokens)
      .values({
        tenant_id: ctx.tenant_id,
        enduser_ref: "enduser-1",
        prefix: "pt_cleanup_token",
        token_sha256: "sha256-portal-token",
        allowed_workflows: [],
        expires_at: new Date(Date.now() + 60_000),
      })
      .returning();
    const result = await revokePortalTokenTool.execute(makeToolContext(), { id: portalToken!.id });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      revoked: true,
      portal_token: { id: portalToken!.id, prefix: "pt_cleanup_token", enduser_ref: "enduser-1" },
    });
    expect(await countAudit("portal_token.revoked", portalToken!.id)).toBe(1);
    expect(await countAudit("conversation.revoke_portal_token", portalToken!.id)).toBe(1);
  });
});
