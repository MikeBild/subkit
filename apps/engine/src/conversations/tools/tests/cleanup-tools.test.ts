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
import { builtinRoleId } from "../../../rbac/roles.ts";
import { getTestNow } from "../../../test-helpers/determinism/clock.ts";
import { createWorkflow } from "../../../workflows/service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import {
  deleteConnectorTool,
  deleteKnowledgeSourceTool,
  deleteSubscriptionTool,
  deleteWorkflowTool,
  revokeApiKeyTool,
  revokePortalTokenTool,
} from "../engine-api/writes/cleanup.ts";
import type { ToolContext } from "../index.ts";
import { checkToolPermission } from "../permission-gate.ts";

const TEST_NOW_MS = getTestNow();

let ctx: ConversationTestCtx;
let memberUserId: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("cleanup_tools");
  const [member] = await ctx.testDb.db
    .insert(users)
    .values({
      tenant_id: ctx.tenant_id,
      email: "member-cleanup@test.local",
      role_id: await builtinRoleId(ctx.testDb.db, "member"),
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

// The central RBAC gate (wrapOne → checkToolPermission) is the enforcement
// point now that the tools carry declarative `permission` descriptors. Drive it
// directly with real principals (the tool bodies no longer self-gate).
describe("central RBAC gate — deny + policy.denied audit", () => {
  test("member lacking api_key:revoke is denied and a policy.denied audit row is written", async () => {
    const memberCtx = makeToolContext(memberUserId, "user");
    const perm = revokeApiKeyTool.permission;
    if (!perm) throw new Error("revoke_api_key lost its permission descriptor");
    // Resource ids are UUIDs (resource_grants.resource_id is a uuid column).
    const apiKeyId = crypto.randomUUID(); // allow-random: test fixture id
    const result = await checkToolPermission(memberCtx, perm, { id: apiKeyId });
    expect(result.allow).toBe(false);
    if (!result.allow) expect(result.permission).toBe("api_key:revoke");
    // audit written against the resolved resource id.
    expect(await countAudit("policy.denied", apiKeyId)).toBe(1);
  });

  test("admin is allowed for the same action and no policy.denied row is written", async () => {
    const adminCtx = makeToolContext(ctx.user_id, "user");
    const perm = revokeApiKeyTool.permission;
    if (!perm) throw new Error("revoke_api_key lost its permission descriptor");
    const apiKeyId = crypto.randomUUID(); // allow-random: test fixture id
    const result = await checkToolPermission(adminCtx, perm, { id: apiKeyId });
    expect(result.allow).toBe(true);
    expect(await countAudit("policy.denied", apiKeyId)).toBe(0);
  });
});

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

  test("delete_workflow now allowed for a member (members own the lifecycle of their workflows)", async () => {
    // Pre-fix this test pinned `permission_denied:workflow:delete`
    // for the member role. Session 0aed284f showed that was the
    // actual product bug — operators couldn't delete the workflows
    // they had just created. The member role now has
    // `workflow:delete` and the test inverts: a member SHOULD be
    // able to delete a workflow they have access to.
    const workflow = await seedWorkflow("Member-Owned Workflow", "member-owned-workflow");
    const result = await deleteWorkflowTool.execute(makeToolContext(memberUserId), {
      id: workflow.id,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ deleted: true });
    expect(await countAudit("workflow.deleted", workflow.id)).toBe(1);
    expect(await countAudit("conversation.delete_workflow", workflow.id)).toBe(1);
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
        expires_at: new Date(TEST_NOW_MS + 60_000),
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
