import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { canReadConversation } from "../core/access.ts";
import { ACCESS_CASES, ACCESS_ROWS, type AccessRowKind } from "../core/access-fixtures.ts";
import { conversationReaderCond } from "./conversation-access.ts";

const nextUuid = createDeterministicUuidFactory(4711);

const MARKER = {
  task_id: "00000000-0000-4000-8000-0000000000a1",
  task_run_id: "00000000-0000-4000-8000-0000000000a2",
  environment: "dev",
  workflow_ids: [],
  connector_ids: [],
  web_search: false,
};

let ctx: TestDb;
let tenant_id: string;
const ids = new Map<AccessRowKind, string>();

beforeAll(async () => {
  ctx = await createTestDb("conversation_access_parity");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "access-parity", display_name: "Access parity" })
    .returning({ id: tenants.id });
  if (!tenant) throw new Error("tenant was not created");
  tenant_id = tenant.id;
  for (const [kind, row] of Object.entries(ACCESS_ROWS) as [
    AccessRowKind,
    (typeof ACCESS_ROWS)[AccessRowKind],
  ][]) {
    const draft = row.task_run
      ? { session: { task_run: row.task_run.sealed ? { ...MARKER, sealed: true } : MARKER } }
      : null;
    const [inserted] = await ctx.db
      .insert(conversations)
      .values({
        tenant_id,
        status: "active",
        owner_id: row.owner_id,
        visibility: row.visibility,
        draft,
      })
      .returning({ id: conversations.id });
    if (!inserted) throw new Error(`conversation ${kind} was not created`);
    ids.set(kind, inserted.id);
  }
}, TEST_DB_HOOK_TIMEOUT);

afterAll(async () => {
  await ctx?.cleanup();
});

describe("conversationReaderCond matches canReadConversation", () => {
  for (const c of ACCESS_CASES) {
    test(c.name, async () => {
      const viewer = { ...c.viewer, tenant_id };
      const row = { ...c.row, tenant_id };
      const id = ids.get(c.kind);
      if (!id) throw new Error(`missing row ${c.kind}`);
      const hits = await ctx.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, id), conversationReaderCond(viewer)));
      expect(hits.length === 1).toBe(canReadConversation(viewer, row));
      expect(hits.length === 1).toBe(c.read);
    });
  }

  test("a viewer from another tenant matches nothing", async () => {
    const viewer = {
      id: ACCESS_CASES[0]?.viewer.id ?? "",
      tenant_id: nextUuid(),
      is_admin: true,
    };
    const hits = await ctx.db
      .select({ id: conversations.id })
      .from(conversations)
      .where(conversationReaderCond(viewer));
    expect(hits).toEqual([]);
  });
});
