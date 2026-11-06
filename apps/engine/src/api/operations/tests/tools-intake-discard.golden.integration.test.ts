import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { createEmptyDraftDocument } from "../../../conversations/authoring-state/index.ts";
import { getTool, type ToolContext } from "../../../conversations/tools/index.ts";
import type { DraftDocument } from "../../../conversations/types.ts";
import type { Db } from "../../../db/client.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { createIntakeItem, patchIntakeItem } from "../../../knowledge/index.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { emptyRoleId } from "../../../test-helpers/roles.ts";
import { makeToolCtx, seedTenant } from "../../../test-helpers/seed.ts";
import { makeTestPrincipal } from "../../../tools/tests/_helpers.ts";

const GOLDEN_PATH = new URL("./fixtures/tools-intake-discard.golden.json", import.meta.url)
  .pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";

let tdb: TestDb;
let db: Db;
let tenantId: string;
let userId: string;

function uuidName(uuid: string): string {
  if (uuid === MISSING) return "<missing>";
  const known = uuidNames.get(uuid);
  if (known) return known;
  const name = `<uuid:${uuidNames.size + 1}>`;
  uuidNames.set(uuid, name);
  return name;
}

function scrub(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replaceAll(tenantId, "<tenant>")
    .replace(/"20(2[4-9]|[3-9]\d)-\d\d-\d\dT[\d:.]+Z"/g, '"<now>"')
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"');
}

function record(name: string, value: unknown): void {
  actual[name] = scrub(value).replace(UUID, uuidName);
  expect(actual[name]).toBe(golden[name] as string);
}

function recordRows(name: string, rows: readonly unknown[]): void {
  actual[name] = JSON.stringify(rows.map((row) => scrub(row).replace(UUID, "<id>")).sort());
  expect(actual[name]).toBe(golden[name] as string);
}

function tool(name: string) {
  const found = getTool(name);
  if (!found) throw new Error(`${name} is not registered`);
  return found;
}

function userCtx(draft?: DraftDocument) {
  return makeToolCtx({
    db,
    tenant_id: tenantId,
    actor_id: userId,
    principal: makeTestPrincipal({ id: userId, tenant_id: tenantId, roles: ["admin"] }),
    ...(draft ? { draft } : {}),
  });
}

function systemCtx(): ToolContext {
  return makeToolCtx({ db, tenant_id: tenantId });
}

let clipSequence = 100;

async function clip(title: string, category?: string) {
  clipSequence += 1;
  return createIntakeItem(
    {
      tenant_id: tenantId,
      actor: { kind: "user", id: userId },
      client_request_id: `1a7e0001-0000-4000-8000-000000000${clipSequence}`,
      title,
      source_url: `https://example.test/${encodeURIComponent(title)}`,
      captured_at: "2026-10-11T07:00:00.000Z",
      body: `${title} source text`,
      ...(category ? { category } : {}),
    },
    db,
  );
}

async function discard(id: string, expected_version: number) {
  const item = await patchIntakeItem(
    {
      tenant_id: tenantId,
      actor: { kind: "user", id: userId },
      id,
      expected_version,
      state: "discarded",
    },
    db,
  );
  if (!item) throw new Error("discard returned no item");
  return item;
}

async function readAll(ctx: ToolContext, ids: string[]) {
  for (const id of ids) await tool("get_intake_item").execute(ctx, { id });
}

function lockedDraft(ids: string[]): DraftDocument {
  return {
    ...createEmptyDraftDocument(),
    session: { intake_item_ids: ids, intake_review_locked: true },
  };
}

function auditRows(action: string) {
  return db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      resource_type: auditLog.resource_type,
      resource_id: auditLog.resource_id,
      result: auditLog.result,
      reason: auditLog.reason,
      before: auditLog.before,
      after: auditLog.after,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.action, action)));
}

beforeAll(async () => {
  tdb = await createTestDb("tools_intake_discard_golden");
  db = tdb.db as unknown as Db;
  tenantId = (await seedTenant(db, { slug: "tools-intake-discard-golden" })).id;
  const [user] = await db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "tools-intake-discard-golden@test.local",
      role_id: await builtinRoleId(db, "admin"),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user insert returned no row");
  userId = user.id;
  await clip("Categorized research", "research");
  await clip("Categorized inbox");
}, 60_000);

afterAll(async () => {
  await tdb.cleanup();
}, 30_000);

describe("intake category and discard tools keep their results", () => {
  test("list_intake_categories", async () => {
    const list = tool("list_intake_categories");
    record("categories.user", await list.execute(userCtx(), {}));
    record("categories.system", await list.execute(systemCtx(), {}));
  });

  test("discard_intake_items", async () => {
    const discardTool = tool("discard_intake_items");
    const precheck = (ctx: ToolContext, args: unknown) => {
      if (!discardTool.precheck) throw new Error("discard_intake_items has no precheck");
      return discardTool.precheck(ctx, args);
    };
    const first = await clip("Discard first");
    const second = await clip("Discard second");
    const stale = await clip("Discard stale");
    const changed = await clip("Discard changed");
    const unread = await clip("Discard unread");
    const decided = await discard((await clip("Discard decided")).id, 1);
    record("discard.precheck.invalid", await precheck(userCtx(), { item_ids: [] }));
    record("discard.precheck.system", await precheck(systemCtx(), { item_ids: [first.id] }));
    record(
      "discard.precheck.locked.unselected",
      await precheck(userCtx(lockedDraft([first.id])), { item_ids: [first.id, second.id] }),
    );
    record(
      "discard.precheck.not_found",
      await precheck(userCtx(), { item_ids: [MISSING, first.id] }),
    );
    record(
      "discard.precheck.not_discardable",
      await precheck(userCtx(), { item_ids: [decided.id, first.id] }),
    );
    const ctx = userCtx();
    record("discard.precheck.unread", await precheck(ctx, { item_ids: [first.id] }));
    await readAll(ctx, [first.id, second.id, stale.id, changed.id, decided.id]);
    record(
      "discard.precheck.ok",
      await precheck(ctx, { item_ids: [first.id, second.id, first.id] }),
    );
    record(
      "discard.execute.system",
      await discardTool.execute(systemCtx(), { item_ids: [first.id] }),
    );
    const [deniedUser] = await db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "tools-intake-golden-denied@test.local",
        role_id: await emptyRoleId(db, tenantId),
      })
      .returning({ id: users.id });
    if (!deniedUser) throw new Error("user insert returned no row");
    const denied = makeToolCtx({
      db,
      tenant_id: tenantId,
      actor_id: deniedUser.id,
      principal: makeTestPrincipal({ id: deniedUser.id, tenant_id: tenantId, roles: [] }),
      draft: ctx.draft,
    });
    record("discard.execute.denied", await discardTool.execute(denied, { item_ids: [first.id] }));
    record(
      "discard.execute.ok",
      await discardTool.execute(ctx, { item_ids: [first.id, second.id, first.id] }),
    );
    await patchIntakeItem(
      {
        tenant_id: tenantId,
        actor: { kind: "user", id: userId },
        id: stale.id,
        expected_version: 1,
        category: "research",
      },
      db,
    );
    record("discard.execute.changed", await discardTool.execute(ctx, { item_ids: [stale.id] }));
    await patchIntakeItem(
      {
        tenant_id: tenantId,
        actor: { kind: "user", id: userId },
        id: changed.id,
        expected_version: 1,
        category: "research",
      },
      db,
    );
    await readAll(ctx, [stale.id]);
    record(
      "discard.execute.mixed",
      await discardTool.execute(ctx, {
        item_ids: [MISSING, decided.id, changed.id, unread.id, first.id, stale.id],
      }),
    );
  });

  test("audit trail", async () => {
    recordRows("audit.updated", await auditRows("intake_item.updated"));
    recordRows("audit.denied", await auditRows("policy.denied"));
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
