import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { apiKeys, auditLog } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../../test-helpers/determinism/ids.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "../../tests/setup.ts";
import { createApiKeyTool } from "../engine-api/writes/create-api-key.ts";
import type { ToolContext } from "../index.ts";

let ctx: ConversationTestCtx;
const nextConvoId = createDeterministicUuidFactory(0xc0a5_7e57);

beforeAll(async () => {
  ctx = await createConversationTestCtx("create_api_key");
});

afterAll(async () => {
  await ctx.cleanup();
});

function makeToolContext(actorId: string | null = ctx.user_id): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: nextConvoId(),
    actor_id: actorId,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: actorId,
      actor_type: actorId ? "user" : "system",
      db: ctx.testDb.db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
  };
}

describe("create_api_key — tool description contract", () => {
  test("description requires explicit user confirmation before minting", () => {
    expect(createApiKeyTool.description).toMatch(/explicit(ly)? confirm/i);
  });

  test("description forbids calling in response to informational questions", () => {
    expect(createApiKeyTool.description).toMatch(/do not call in response to informational/i);
    expect(createApiKeyTool.description).toMatch(/how do i/i);
  });

  test("use_case also gates on AFTER-confirmation wording", () => {
    expect(createApiKeyTool.use_case).toMatch(/after the user explicitly confirms/i);
  });

  test("description forbids manual ask_user_confirm before minting", () => {
    expect(createApiKeyTool.description).toMatch(/do not call ask_user_confirm yourself/i);
    expect(createApiKeyTool.description).toMatch(/engine policy gate/i);
  });
});

describe("create_api_key", () => {
  test("issues a key with default scopes and returns plaintext exactly once", async () => {
    const tc = makeToolContext();
    const result = await createApiKeyTool.execute(tc, { name: "Codex MCP" });
    expect(result.ok).toBe(true);
    const data = result.data as {
      plaintext_key: string;
      api_key: { id: string; prefix: string; scopes: string[] };
      audit_log_id: string;
    };
    expect(typeof data.plaintext_key).toBe("string");
    expect(data.plaintext_key.startsWith("wf_live_")).toBe(true);
    expect(data.api_key.scopes).toEqual(["*"]);
    expect(data.audit_log_id).toBeTruthy();
  });

  test("respects requested narrow scopes + allowed_workflows", async () => {
    const tc = makeToolContext();
    const result = await createApiKeyTool.execute(tc, {
      name: "narrow",
      scopes: ["workflow:read"],
      allowed_workflows: ["my-workflow"],
    });
    expect(result.ok).toBe(true);
    const data = result.data as { api_key: { id: string; scopes: string[] } };
    expect(data.api_key.scopes).toEqual(["workflow:read"]);

    const [row] = await ctx.testDb.db
      .select({ allowed_workflows: apiKeys.allowed_workflows })
      .from(apiKeys)
      .where(eq(apiKeys.id, data.api_key.id));
    expect(row?.allowed_workflows).toEqual(["my-workflow"]);
  });

  test("writes a conversation.create_api_key audit row", async () => {
    const tc = makeToolContext();
    const result = await createApiKeyTool.execute(tc, { name: "audit-check" });
    const data = result.data as { api_key: { id: string }; audit_log_id: string };
    const rows = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, "conversation.create_api_key"),
          eq(auditLog.resource_id, data.api_key.id),
        ),
      );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.id).toBe(data.audit_log_id);
  });

  test("rejects calls with no authenticated actor", async () => {
    const tc = makeToolContext(null);
    const result = await createApiKeyTool.execute(tc, { name: "no-actor" });
    expect(result.ok).toBe(false);
    expect((result.data as { error: string }).error).toBe("missing_actor");
  });

  test("rejects malformed expires_at via the input schema", () => {
    const parsed = createApiKeyTool.inputSchema.safeParse({
      name: "bad",
      expires_at: "2026-13-99T99:99:99Z",
    });
    expect(parsed.success).toBe(false);
  });

  test("seals input schema at registration — rejects unknown fields", async () => {
    const sealed = (await import("../index.ts")).getTool("create_api_key")!.inputSchema;
    expect(sealed.safeParse({ name: "ok", not_a_real_field: 1 }).success).toBe(false);
  });
});
