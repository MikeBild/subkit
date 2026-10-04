import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import { encryptSecret } from "../../crypto/aes-gcm.ts";
import type { Db } from "../../db/client.ts";
import { chatWorkspaces } from "../../db/schema/index.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { chatWorkspaceAad } from "../api.ts";
import { _resetChatRehydrateStateForTests, ensureChatRegistryHydrated } from "../hydrate.ts";
import { ChatAdapterRegistry } from "../registry.ts";

const nextHex = createDeterministicHexFactory(0x5e7a1d);
const detBytes = (n: number): Buffer => Buffer.from(nextHex(n), "hex");

let ctx: ConversationTestCtx;
let workspace_id_native: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("chat-rehydrate");
  await setConfigKey("platform.slack.signing_secret", "test-signing-secret-rehydrate");

  workspace_id_native = "T_REHYDRATE";
  const [row] = await ctx.testDb.db
    .insert(chatWorkspaces)
    .values({
      tenant_id: ctx.tenant_id,
      platform: "slack",
      workspace_id: workspace_id_native,
      bot_ciphertext: detBytes(1),
      bot_iv: detBytes(1),
      bot_auth_tag: detBytes(1),
    })
    .returning();
  if (!row) throw new Error("seed chat_workspace failed");

  const sealed = encryptSecret("xoxb-test-bot-token", chatWorkspaceAad(ctx.tenant_id, row.id));
  await ctx.testDb.db
    .update(chatWorkspaces)
    .set({
      bot_ciphertext: sealed.ciphertext,
      bot_iv: sealed.iv,
      bot_auth_tag: sealed.auth_tag,
    })
    .where(eq(chatWorkspaces.id, row.id));
});

afterAll(async () => {
  await setConfigKey("platform.slack.signing_secret", "");
  await ctx.cleanup();
});

function countingDb(db: Db): { db: Db; count: () => number } {
  let selects = 0;
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "select") {
        selects += 1;
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;
  return { db: proxy, count: () => selects };
}

describe("ensureChatRegistryHydrated", () => {
  test("cold miss rehydrates and registers; cooldown suppresses re-query", async () => {
    _resetChatRehydrateStateForTests();
    const registry = new ChatAdapterRegistry();
    const { db, count } = countingDb(ctx.testDb.db);

    expect(registry.findVerifier("slack")).toBeNull();

    await ensureChatRegistryHydrated(db, registry);
    expect(count()).toBe(1);
    expect(registry.findVerifier("slack")).not.toBeNull();

    await ensureChatRegistryHydrated(db, registry);
    expect(count()).toBe(1);

    _resetChatRehydrateStateForTests();
    await ensureChatRegistryHydrated(db, registry);
    expect(count()).toBe(2);
  });

  test("concurrent misses share a single in-flight rehydrate", async () => {
    _resetChatRehydrateStateForTests();
    const registry = new ChatAdapterRegistry();
    const { db, count } = countingDb(ctx.testDb.db);

    await Promise.all([
      ensureChatRegistryHydrated(db, registry),
      ensureChatRegistryHydrated(db, registry),
      ensureChatRegistryHydrated(db, registry),
    ]);
    expect(count()).toBe(1);
    expect(registry.findVerifier("slack")).not.toBeNull();
  });
});
