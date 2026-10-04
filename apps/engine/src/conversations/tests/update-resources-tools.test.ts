import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { auditLog, connectors, knowledgeSources, subscriptions } from "../../db/schema/index.ts";
import { updateConnectorTool } from "../tools/engine-api/writes/update-connector.ts";
import { updateKnowledgeSourceTool } from "../tools/engine-api/writes/update-knowledge-source.ts";
import { updateSubscriptionTool } from "../tools/engine-api/writes/update-subscription.ts";
import type { ToolContext } from "../tools/index.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("update_resources_tools");
});

afterAll(async () => {
  await ctx.cleanup();
});

function toolCtx(): ToolContext {
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub matching ToolContext for in-process service calls
  const engineClientStub: any = {
    context: { actor_id: ctx.user_id, actor_type: "user" },
    connectors: {
      // biome-ignore lint/suspicious/noExplicitAny: in-process service forwarding
      update: async (id: string, patch: any) => {
        const { updateConnector } = await import("../../connectors/service.ts");
        return updateConnector(ctx.tenant_id, id, patch, ctx.user_id, ctx.testDb.db);
      },
    },
    knowledgeSources: {
      // biome-ignore lint/suspicious/noExplicitAny: in-process service forwarding
      update: async (id: string, patch: any) => {
        const { updateKnowledgeSource } = await import("../../knowledge/service.ts");
        return updateKnowledgeSource(
          { tenant_id: ctx.tenant_id, id, patch, actor_id: ctx.user_id },
          ctx.testDb.db,
        );
      },
    },
    subscriptions: {
      // biome-ignore lint/suspicious/noExplicitAny: in-process service forwarding
      update: async (id: string, patch: any) => {
        const { updateSubscription } = await import("../../webhooks/outbound/service.ts");
        return updateSubscription(
          {
            tenant_id: ctx.tenant_id,
            id,
            actor_id: ctx.user_id,
            ...patch,
          },
          ctx.testDb.db,
        );
      },
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal audit stub
    audit_write: async (entry: any) => {
      const { auditAwait } = await import("../../audit/audit.ts");
      const { AuditAction } = await import("../../audit/types.ts");
      const enumByResource = {
        connector: AuditAction.CONNECTOR_UPDATED,
        knowledge_source: AuditAction.KNOWLEDGE_SOURCE_UPDATED,
        subscription: AuditAction.SUBSCRIPTION_UPDATED,
        workflow: AuditAction.WORKFLOW_UPDATED,
      } as const;
      const action =
        enumByResource[entry.resource_type as keyof typeof enumByResource] ??
        AuditAction.CONNECTOR_UPDATED;
      return auditAwait(
        {
          tenant_id: ctx.tenant_id,
          actor_type: "user",
          actor_id: ctx.user_id,
          action,
          resource_type: String(entry.resource_type),
          resource_id: String(entry.resource_id),
          result: (entry.result as "success" | "error" | "denied") ?? "success",
          metadata: {
            via_action: String(entry.action),
            ...((entry.metadata as Record<string, unknown>) ?? {}),
          },
        },
        ctx.testDb.db,
      );
    },
  };
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: "00000000-0000-0000-0000-000000000000",
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    permission_mode: "auto",
    engineClient: engineClientStub,
    getDraft: () => ({ workflow: { name: "", steps: [] } }) as never,
    setDraft: async () => {},
  };
}

describe("update_connector tool — chat-native metadata patch", () => {
  test("renames a connector via the name field", async () => {
    const result = await updateConnectorTool.execute(toolCtx(), {
      id: ctx.connector_id,
      name: "API Renamed",
    });

    expect(result.ok).toBe(true);
    const data = result.data as { connector: { id: string; display_name: string } };
    expect(data.connector.display_name).toBe("API Renamed");

    const refetched = await ctx.testDb.db
      .select({ display_name: connectors.display_name })
      .from(connectors)
      .where(eq(connectors.id, ctx.connector_id))
      .limit(1);
    expect(refetched[0]?.display_name).toBe("API Renamed");

    const auditRows = await ctx.testDb.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.resource_id, ctx.connector_id));
    expect(auditRows.some((r) => r.action === "connector.updated")).toBe(true);
  });

  test("rejects an empty patch (no fields)", () => {
    const parsed = updateConnectorTool.inputSchema.safeParse({ id: ctx.connector_id });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toMatch(/at least one of/i);
    }
  });
});

describe("update_knowledge_source tool — chat-native metadata patch", () => {
  test("renames a knowledge source and changes its status", async () => {
    const [src] = await ctx.testDb.db
      .insert(knowledgeSources)
      .values({
        tenant_id: ctx.tenant_id,
        slug: "original-ks",
        scope: "global",
        name: "Original KS",
        source_type: "manual",
        source_uri: "manual://original-ks",
        version: "1",
        bytes_total: 0,
        chunk_count: 0,
        status: "active",
        refresh_strategy: "manual",
      })
      .returning();
    if (!src) throw new Error("seed knowledge source failed");

    const result = await updateKnowledgeSourceTool.execute(toolCtx(), {
      id: src.id,
      name: "Renamed KS",
      status: "inactive",
    });

    expect(result.ok).toBe(true);
    const data = result.data as { knowledge_source: { name: string; status: string } };
    expect(data.knowledge_source.name).toBe("Renamed KS");
    expect(data.knowledge_source.status).toBe("inactive");

    const auditRows = await ctx.testDb.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.resource_id, src.id));
    expect(auditRows.some((r) => r.action === "knowledge_source.updated")).toBe(true);
  });

  test("returns knowledge_source_not_found for a missing id", async () => {
    const result = await updateKnowledgeSourceTool.execute(toolCtx(), {
      id: "00000000-0000-0000-0000-000000000000",
      name: "Phantom",
    });
    expect(result.ok).toBe(false);
    expect((result.data as { error: string }).error).toBe("knowledge_source_not_found");
  });
});

describe("update_subscription tool — chat-native metadata patch", () => {
  test("pauses an outbound subscription via active=false", async () => {
    const [sub] = await ctx.testDb.db
      .insert(subscriptions)
      .values({
        tenant_id: ctx.tenant_id,
        event_pattern: "execution.completed",
        target_url: "https://example.test/webhook",
        active: true,
        secret_ciphertext: Buffer.from("x"),
        secret_iv: Buffer.from("x"),
        secret_auth_tag: Buffer.from("x"),
      })
      .returning();
    if (!sub) throw new Error("seed subscription failed");

    const result = await updateSubscriptionTool.execute(toolCtx(), {
      id: sub.id,
      active: false,
    });

    expect(result.ok).toBe(true);
    const data = result.data as { subscription: { active: boolean } };
    expect(data.subscription.active).toBe(false);

    const refetched = await ctx.testDb.db
      .select({ active: subscriptions.active })
      .from(subscriptions)
      .where(eq(subscriptions.id, sub.id))
      .limit(1);
    expect(refetched[0]?.active).toBe(false);

    const auditRows = await ctx.testDb.db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.resource_id, sub.id));
    expect(auditRows.some((r) => r.action === "subscription.updated")).toBe(true);
  });

  test("audit metadata never includes the raw secret", async () => {
    const [sub] = await ctx.testDb.db
      .insert(subscriptions)
      .values({
        tenant_id: ctx.tenant_id,
        event_pattern: "execution.completed",
        target_url: "https://example.test/webhook2",
        active: true,
        secret_ciphertext: Buffer.from("x"),
        secret_iv: Buffer.from("x"),
        secret_auth_tag: Buffer.from("x"),
      })
      .returning();
    if (!sub) throw new Error("seed subscription failed");

    const newSecret = "rotated-secret-value-1234567890";
    const result = await updateSubscriptionTool.execute(toolCtx(), {
      id: sub.id,
      secret: newSecret,
    });
    expect(result.ok).toBe(true);

    const auditRows = await ctx.testDb.db
      .select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(eq(auditLog.resource_id, sub.id));
    for (const row of auditRows) {
      const meta = JSON.stringify(row.metadata ?? {});
      expect(meta).not.toContain(newSecret);
    }
  });
});
