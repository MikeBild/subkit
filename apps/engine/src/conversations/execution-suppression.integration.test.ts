import { afterAll, beforeAll, expect, test } from "bun:test";
import { conversationMessages, conversations, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import {
  conversationExecutionSuppressed,
  conversationExecutionSuppression,
} from "./execution-suppression.ts";

let testDb: TestDb;
let tenant_id: string;
let sequence = 0;

beforeAll(async () => {
  testDb = await createTestDb("execution_suppression");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "execution-suppression", display_name: "Execution suppression" })
    .returning();
  if (!tenant) throw new Error("tenant");
  tenant_id = tenant.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

async function conversation() {
  const [created] = await testDb.db
    .insert(conversations)
    .values({
      tenant_id,
      status: "active",
      title: `Suppression ${++sequence}`,
      draft: { workflow: { name: "suppression", steps: [] } },
    })
    .returning();
  if (!created) throw new Error("conversation");
  return created;
}

test("keeps an explicit no-live veto after many neutral turns and a later run request", async () => {
  const created = await conversation();
  await testDb.db.insert(conversationMessages).values([
    {
      tenant_id,
      conversation_id: created.id,
      role: "user",
      content: "Bitte nicht live ausführen.",
    },
    ...Array.from({ length: 33 }, (_, index) => ({
      tenant_id,
      conversation_id: created.id,
      role: "user" as const,
      content: `Neutraler Prüfschritt ${index + 1}`,
    })),
    {
      tenant_id,
      conversation_id: created.id,
      role: "user",
      content: "Führe den Workflow jetzt aus.",
    },
  ]);
  expect(
    await conversationExecutionSuppressed({
      db: testDb.db,
      tenant_id,
      conversation_id: created.id,
      recent_user_message: "Führe den Workflow jetzt aus.",
    }),
  ).toBe(true);
});

test("honors a current no-live instruction before it is persisted", async () => {
  const created = await conversation();
  expect(
    await conversationExecutionSuppressed({
      db: testDb.db,
      tenant_id,
      conversation_id: created.id,
      recent_user_message: "Do not run this workflow live.",
    }),
  ).toBe(true);
});

test("does not read a veto from another tenant", async () => {
  const created = await conversation();
  await testDb.db.insert(conversationMessages).values({
    tenant_id,
    conversation_id: created.id,
    role: "user",
    content: "Nicht live ausführen.",
  });
  expect(
    await conversationExecutionSuppressed({
      db: testDb.db,
      tenant_id: "00000000-0000-4000-8000-000000000099",
      conversation_id: created.id,
    }),
  ).toBe(false);
});

const PREPARE_WITHOUT_LIVE_EFFECTS =
  "Bereite diesen Ablauf für den automatischen Betrieb vor. Nicht aktivieren, keine Live-Wirkungen freigeben oder ausführen. Erlaubte Prüfungen selbst übernehmen.";

test("a no-live-effects preparation suppresses live execution only, also on a resume turn", async () => {
  const created = await conversation();
  await testDb.db.insert(conversationMessages).values([
    {
      tenant_id,
      conversation_id: created.id,
      role: "user",
      content: PREPARE_WITHOUT_LIVE_EFFECTS,
    },
    { tenant_id, conversation_id: created.id, role: "user", content: "PROD" },
  ]);
  expect(
    await conversationExecutionSuppression({
      db: testDb.db,
      tenant_id,
      conversation_id: created.id,
      recent_user_message: "PROD",
    }),
  ).toEqual({ live: true, all: false });
  expect(
    await conversationExecutionSuppression({
      db: testDb.db,
      tenant_id,
      conversation_id: created.id,
      recent_user_message: null,
    }),
  ).toEqual({ live: true, all: false });
  expect(
    await conversationExecutionSuppressed({
      db: testDb.db,
      tenant_id,
      conversation_id: created.id,
    }),
  ).toBe(false);
});

test("a current no-test instruction suppresses previews before it is persisted", async () => {
  const created = await conversation();
  expect(
    await conversationExecutionSuppression({
      db: testDb.db,
      tenant_id,
      conversation_id: created.id,
      recent_user_message: "Bitte keinen Testlauf starten.",
    }),
  ).toEqual({ live: true, all: true });
});

test("a neutral conversation suppresses nothing", async () => {
  const created = await conversation();
  await testDb.db.insert(conversationMessages).values({
    tenant_id,
    conversation_id: created.id,
    role: "user",
    content: "Run the workflow",
  });
  expect(
    await conversationExecutionSuppression({
      db: testDb.db,
      tenant_id,
      conversation_id: created.id,
      recent_user_message: null,
    }),
  ).toEqual({ live: false, all: false });
});
