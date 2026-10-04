import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import { setConfigKey } from "../../config/loader.ts";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import { auditLog, chatWorkspaces } from "../../db/schema/index.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { hydrateChatRegistry } from "../hydrate.ts";
import { ChatAdapterRegistry } from "../registry.ts";

const nextHex = createDeterministicHexFactory(0x60091e);
const detBytes = (n: number): Buffer => Buffer.from(nextHex(n), "hex");

const TEST_PEM = "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";

let ctx: ConversationTestCtx;
const SPACE = "spaces/HYDR8";

beforeAll(async () => {
  ctx = await createConversationTestCtx("chat-hydrate-google");
  await ctx.testDb.db.insert(chatWorkspaces).values({
    tenant_id: ctx.tenant_id,
    platform: "google_chat",
    workspace_id: SPACE,
    bot_ciphertext: detBytes(1),
    bot_iv: detBytes(1),
    bot_auth_tag: detBytes(1),
  });
});

afterAll(async () => {
  await setConfigKey("platform.googlechat.client_email", "");
  await setConfigKey("platform.googlechat.private_key", "");
  await setConfigKey("platform.googlechat.audience", "");
  await ctx.cleanup();
});

describe("google chat hydration", () => {
  test("incomplete credentials → row skipped with CHAT_WORKSPACE_HYDRATE_SKIPPED audit", async () => {
    await setConfigKey("platform.googlechat.client_email", "");
    await setConfigKey("platform.googlechat.private_key", "");
    await setConfigKey("platform.googlechat.audience", "");

    const registry = new ChatAdapterRegistry();
    const outcome = await hydrateChatRegistry(ctx.testDb.db, registry);
    expect(outcome.google_chat).toBe(0);
    expect(outcome.skipped).toBeGreaterThanOrEqual(1);
    expect(
      registry.get({ tenant_id: ctx.tenant_id, platform: "google_chat", workspace_id: SPACE }),
    ).toBeNull();

    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, AuditAction.CHAT_WORKSPACE_HYDRATE_SKIPPED),
        ),
      );
    expect(audits.some((a) => a.reason === "google_credentials_unset")).toBe(true);
  });

  test("complete credentials → adapter registered + platform fallback set", async () => {
    await setConfigKey("platform.googlechat.client_email", "bot@svc.gserviceaccount.com");
    await setConfigKey("platform.googlechat.private_key", TEST_PEM);
    await setConfigKey("platform.googlechat.audience", "123456789012");

    const registry = new ChatAdapterRegistry();
    const outcome = await hydrateChatRegistry(ctx.testDb.db, registry);
    expect(outcome.google_chat).toBe(1);
    expect(outcome.fallback_registered_for).toContain("google_chat");

    const adapter = registry.get({
      tenant_id: ctx.tenant_id,
      platform: "google_chat",
      workspace_id: SPACE,
    });
    expect(adapter).not.toBeNull();
    expect(adapter?.platform).toBe("google_chat");
    expect(registry.findVerifier("google_chat")).not.toBeNull();
  });
});
