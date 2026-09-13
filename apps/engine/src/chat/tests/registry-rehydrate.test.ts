// #42 — lazy chat-registry rehydrate on miss.
//
// The adapter registry is process-local and hydrated once at boot. A
// request that arrives in the boot-race window (or, in a future
// multi-instance deploy, against an instance that missed an install)
// would otherwise 503 forever. `ensureChatRegistryHydrated` converts the
// first such miss into a re-hydrate + retry, guarded by a single-flight +
// ~30s cooldown so a genuinely-0-install request can't DB-storm.
//
// This test seeds a real, properly-encrypted Slack workspace, starts from
// a COLD registry, and asserts:
//   1. cold miss → ensureChatRegistryHydrated registers the adapter and
//      the lookup resolves (one DB query);
//   2. a second call within the cooldown does NOT re-query (single-flight
//      cooldown holds);
//   3. after the cooldown is reset, a call re-queries again.

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
  // The Slack signing secret is app-level (one subkit Slack app, shared
  // across workspaces). Hydration skips Slack rows when it's empty, so
  // set it for this test and restore it in afterAll.
  await setConfigKey("platform.slack.signing_secret", "test-signing-secret-rehydrate");

  workspace_id_native = "T_REHYDRATE";
  // Insert with placeholder bytes to obtain the row id, then re-encrypt
  // the bot token with the row-bound AAD (`chat-workspace:<tenant>:<id>`)
  // and update — mirrors the install route's encrypt-with-row-id flow.
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

/** Wrap a Db so every `.select()` is counted — lets us assert the
 *  cooldown actually suppresses re-queries. Only `select` is proxied;
 *  every other property passes through to the real client. */
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

    // 1. Cold registry: nothing registered yet.
    expect(registry.findVerifier("slack")).toBeNull();

    // 2. Lazy rehydrate registers the seeded workspace's adapter.
    await ensureChatRegistryHydrated(db, registry);
    expect(count()).toBe(1);
    expect(registry.findVerifier("slack")).not.toBeNull();

    // 3. Second call within the cooldown is a no-op — no extra DB query.
    await ensureChatRegistryHydrated(db, registry);
    expect(count()).toBe(1);

    // 4. After the cooldown resets, a call re-queries.
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
    // Single-flight: three concurrent callers, one DB query.
    expect(count()).toBe(1);
    expect(registry.findVerifier("slack")).not.toBeNull();
  });
});
