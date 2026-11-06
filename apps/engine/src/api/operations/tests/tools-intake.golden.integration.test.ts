import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { and, eq, inArray } from "drizzle-orm";
import { createEmptyDraftDocument } from "../../../conversations/authoring-state/index.ts";
import { getTool, type ToolContext } from "../../../conversations/tools/index.ts";
import type { DraftDocument } from "../../../conversations/types.ts";
import type { Db } from "../../../db/client.ts";
import { auditLog, users } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { upsertKnowledgeBundle } from "../../../knowledge/bundle-service.ts";
import {
  createIntakeItem,
  createSessionIntakeItem,
  patchIntakeItem,
} from "../../../knowledge/index.ts";
import { zodToJsonSchema7 } from "../../../mcp/json-schema.ts";
import { builtinRoleId } from "../../../rbac/roles.ts";
import { createSkill } from "../../../skills/service.ts";
import { makeToolCtx, seedTenant } from "../../../test-helpers/seed.ts";
import { makeTestPrincipal } from "../../../tools/tests/_helpers.ts";

const GOLDEN_PATH = new URL("./fixtures/tools-intake.golden.json", import.meta.url).pathname;
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as Record<string, string>;
const actual: Record<string, string> = {};
const uuidNames = new Map<string, string>();
const UUID =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/g;
const MISSING = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const TOOL_NAMES = [
  "list_intake_categories",
  "list_intake_items",
  "get_intake_item",
  "discard_intake_items",
  "restore_intake_item",
  "move_intake_item",
  "set_default_intake_category",
  "create_intake_proposal",
  "revise_intake_proposal",
] as const;

let tdb: TestDb;
let db: Db;
let tenantId: string;
let userId: string;
let sessionItemId: string;
let clipId: string;
let undomainedId: string;

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
    .replace(/"(trace_id|audit_trace_id|request_id)":"[^"]*"/g, '"$1":"<trace>"')
    .replace(/"digest":"[0-9a-f]{64}"/g, '"digest":"<digest>"');
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

function descriptor(name: string) {
  const t = tool(name);
  return {
    name: t.name,
    description: t.description,
    use_case: t.use_case ?? null,
    important_notes: t.important_notes ?? null,
    input: zodToJsonSchema7(t.inputSchema),
    category: t.category,
    strict: t.strict ?? null,
    requires_draft: t.requires_draft ?? null,
    precheck: typeof t.precheck === "function",
    permission: t.permission
      ? {
          action: t.permission.action,
          resourceType: t.permission.resourceType,
          resourceIdArg: t.permission.resourceIdArg ?? null,
          resolveResourceId: typeof t.permission.resolveResourceId === "function",
        }
      : null,
  };
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

async function bundle(name: string) {
  return (
    await upsertKnowledgeBundle(
      {
        tenant_id: tenantId,
        actor: { kind: "user", id: userId },
        input: { name },
        files: [{ path: "/reference.md", content: `# ${name}\n` }],
      },
      db,
    )
  ).knowledge_source;
}

async function readAll(ctx: ToolContext, ids: string[]) {
  for (const id of ids) await tool("get_intake_item").execute(ctx, { id });
}

function itemsByTitle(result: unknown): unknown {
  const proposal = (result as { data?: { proposal?: { revision?: { items?: unknown[] } } } }).data
    ?.proposal;
  const items = proposal?.revision?.items as { title: string }[] | undefined;
  items?.sort((a, b) => a.title.localeCompare(b.title));
  return result;
}

function lockedDraft(ids: string[]): DraftDocument {
  return {
    ...createEmptyDraftDocument(),
    session: { intake_item_ids: ids, intake_review_locked: true },
  };
}

function auditRows() {
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
    .where(
      and(
        eq(auditLog.tenant_id, tenantId),
        inArray(auditLog.action, [
          "intake_default_category.updated",
          "intake_item.updated",
          "intake_proposal.created",
          "intake_proposal.revised",
        ]),
      ),
    );
}

beforeAll(async () => {
  tdb = await createTestDb("tools_intake_golden");
  db = tdb.db as unknown as Db;
  tenantId = (await seedTenant(db, { slug: "tools-intake-golden" })).id;
  const [user] = await db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "tools-intake-golden@test.local",
      role_id: await builtinRoleId(db, "admin"),
    })
    .returning({ id: users.id });
  if (!user) throw new Error("user insert returned no row");
  userId = user.id;
  const actor = { kind: "user" as const, id: userId };
  for (let day = 1; day <= 7; day++) {
    const result = await createSessionIntakeItem(
      {
        tenant_id: tenantId,
        actor,
        title: "Golden session learning",
        body: "Golden session learning body",
        captured_at: `2026-10-0${day}T07:00:00.000Z`,
        session: {
          agent: "codex",
          session_id: `golden-session-${day}`,
          repo: "example/repo",
          domains: [],
          evidence_excerpt: day === 7 ? `long ${"x".repeat(700)}` : `evidence of day ${day}`,
        },
      },
      db,
    );
    sessionItemId = result.item.id;
  }
  const item = await createIntakeItem(
    {
      tenant_id: tenantId,
      actor,
      client_request_id: "1a7e0001-0000-4000-8000-000000000001",
      title: "Golden clip",
      source_url: "https://example.test/golden-clip",
      captured_at: "2026-10-10T07:00:00.000Z",
      body: "Golden clip source text",
    },
    db,
  );
  clipId = item.id;
  await createSkill(
    {
      tenant_id: tenantId,
      input: {
        scope: "global",
        title: "Golden domain marker",
        body: "Marks the clip category as a domain.",
        tags: [`domain:${item.category}`],
        status: "active",
      },
    },
    db,
  );
  undomainedId = (
    await createIntakeItem(
      {
        tenant_id: tenantId,
        actor,
        client_request_id: "1a7e0001-0000-4000-8000-000000000002",
        title: "Golden undomained clip",
        source_url: "https://example.test/golden-undomained",
        captured_at: "2026-10-10T07:00:00.000Z",
        body: "Golden undomained source text",
        category: "golden-undomained",
      },
      db,
    )
  ).id;
}, 60_000);

afterAll(async () => {
  await tdb.cleanup();
}, 30_000);

describe("intake conversation tools keep their descriptors and results", () => {
  test("descriptors", () => {
    for (const name of TOOL_NAMES) record(`descriptor.${name}`, descriptor(name));
  });

  test("get_intake_item", async () => {
    const get = tool("get_intake_item");
    const open = userCtx();
    record("get.session", await get.execute(open, { id: sessionItemId }));
    record("get.clip", await get.execute(open, { id: clipId }));
    record("get.open.draft", open.draft.session);
    record("get.undomained", await get.execute(systemCtx(), { id: undomainedId }));
    const missing = userCtx();
    record("get.missing", await get.execute(missing, { id: MISSING }));
    record("get.missing.draft", missing.draft.session);
    const locked = userCtx(lockedDraft([clipId]));
    record("get.locked.unselected", await get.execute(locked, { id: sessionItemId }));
    record("get.locked.unselected.draft", locked.draft.session);
    record("get.locked.selected", await get.execute(locked, { id: clipId }));
    record("get.locked.selected.draft", locked.draft.session);
    const lockedMissing = userCtx(lockedDraft([MISSING]));
    record("get.locked.missing", await get.execute(lockedMissing, { id: MISSING }));
    record("get.locked.missing.draft", lockedMissing.draft.session);
  });

  test("set_default_intake_category", async () => {
    const set = tool("set_default_intake_category");
    record("set.user", await set.execute(userCtx(), { category: "research" }));
    record("set.user.again", await set.execute(userCtx(), { category: "research" }));
    record("set.system", await set.execute(systemCtx(), { category: "research" }));
    record("set.categories", await tool("list_intake_categories").execute(userCtx(), {}));
  });

  test("list_intake_items", async () => {
    const list = tool("list_intake_items");
    const open = userCtx();
    record("list.open", await list.execute(open, {}));
    record("list.open.draft", open.draft.session);
    record("list.category", await list.execute(userCtx(), { category: "golden-undomained" }));
    record("list.state", await list.execute(userCtx(), { state: "discarded" }));
    record("list.system", await list.execute(systemCtx(), { category: "inbox" }));
    const locked = userCtx(lockedDraft([clipId, MISSING]));
    record(
      "list.locked",
      await list.execute(locked, { category: "golden-undomained", state: "discarded" }),
    );
    record("list.locked.draft", locked.draft.session);
  });

  test("restore_intake_item", async () => {
    const restore = tool("restore_intake_item");
    const collected = await clip("Restore collected");
    const discarded = await discard((await clip("Restore discarded")).id, 1);
    record(
      "restore.system",
      await restore.execute(systemCtx(), { id: discarded.id, expected_version: 2 }),
    );
    record(
      "restore.locked.unselected",
      await restore.execute(userCtx(lockedDraft([collected.id])), {
        id: discarded.id,
        expected_version: 2,
      }),
    );
    const ctx = userCtx();
    record("restore.unread", await restore.execute(ctx, { id: discarded.id, expected_version: 2 }));
    await readAll(ctx, [discarded.id, collected.id]);
    record(
      "restore.changed",
      await restore.execute(ctx, { id: discarded.id, expected_version: 1 }),
    );
    record(
      "restore.not_discarded",
      await restore.execute(ctx, { id: collected.id, expected_version: 1 }),
    );
    record("restore.ok", await restore.execute(ctx, { id: discarded.id, expected_version: 2 }));
    record(
      "restore.stale_read",
      await restore.execute(ctx, { id: discarded.id, expected_version: 3 }),
    );
  });

  test("move_intake_item", async () => {
    const move = tool("move_intake_item");
    const item = await clip("Move me");
    const other = await clip("Move other");
    record(
      "move.system",
      await move.execute(systemCtx(), { id: item.id, expected_version: 1, category: "research" }),
    );
    record(
      "move.locked.unselected",
      await move.execute(userCtx(lockedDraft([other.id])), {
        id: item.id,
        expected_version: 1,
        category: "research",
      }),
    );
    const ctx = userCtx();
    record(
      "move.unread",
      await move.execute(ctx, { id: item.id, expected_version: 1, category: "research" }),
    );
    await readAll(ctx, [item.id]);
    record(
      "move.changed",
      await move.execute(ctx, { id: item.id, expected_version: 2, category: "research" }),
    );
    record(
      "move.same",
      await move.execute(ctx, { id: item.id, expected_version: 1, category: item.category }),
    );
    record(
      "move.ok",
      await move.execute(ctx, { id: item.id, expected_version: 1, category: "inbox" }),
    );
    record(
      "move.after",
      await move.execute(ctx, { id: item.id, expected_version: 2, category: "golden-undomained" }),
    );
  });

  test("create_intake_proposal and revise_intake_proposal", async () => {
    const create = tool("create_intake_proposal");
    const revise = tool("revise_intake_proposal");
    const first = await clip("Proposal first");
    const second = await clip("Proposal second");
    const decided = await discard((await clip("Proposal decided")).id, 1);
    const source = await bundle("Golden reference");
    const target = { name: "Golden knowledge" };
    const base = { title: "Golden proposal", body: "A reviewed fact." };
    record("create.system", await create.execute(systemCtx(), { ...base, target }));
    record("create.no_items", await create.execute(userCtx(), { ...base, target }));
    const ctx = userCtx(lockedDraft([first.id, second.id, decided.id]));
    record(
      "create.unselected",
      await create.execute(ctx, { ...base, item_ids: [first.id, clipId], target }),
    );
    record(
      "create.decided",
      await create.execute(ctx, { ...base, item_ids: [first.id, decided.id], target }),
    );
    record("create.unread", await create.execute(ctx, { ...base, item_ids: [first.id], target }));
    await readAll(ctx, [first.id, second.id]);
    record(
      "create.source_missing",
      await create.execute(ctx, {
        ...base,
        item_ids: [first.id],
        target: { knowledge_source_id: MISSING },
      }),
    );
    record(
      "create.source_is_item",
      await create.execute(ctx, {
        ...base,
        item_ids: [first.id],
        target: { knowledge_source_id: second.id },
      }),
    );
    record(
      "create.source_stale",
      await create.execute(ctx, {
        ...base,
        item_ids: [first.id],
        target: { knowledge_source_id: source.id, expected_version: "not-the-version" },
      }),
    );
    record(
      "create.skill_missing",
      await create.execute(ctx, {
        ...base,
        item_ids: [first.id],
        target: { skill: { skill_id: MISSING, expected_version: 1 } },
      }),
    );
    record(
      "create.source",
      await create.execute(ctx, {
        ...base,
        item_ids: [first.id],
        target: { knowledge_source_id: source.id },
      }),
    );
    const created = await create.execute(ctx, { ...base, item_ids: [first.id, second.id], target });
    record("create.ok", itemsByTitle(created));
    const proposalId = ((created.data as { proposal: { id: string } }).proposal as { id: string })
      .id;
    const revision = { ...base, title: "Golden proposal revised", target };
    record(
      "revise.system",
      await revise.execute(systemCtx(), {
        ...revision,
        id: proposalId,
        expected_revision: 1,
        item_ids: [first.id],
      }),
    );
    record(
      "revise.unselected",
      await revise.execute(ctx, {
        ...revision,
        id: proposalId,
        expected_revision: 1,
        item_ids: [clipId],
      }),
    );
    record(
      "revise.missing",
      await revise.execute(ctx, {
        ...revision,
        id: MISSING,
        expected_revision: 1,
        item_ids: [first.id],
      }),
    );
    record(
      "revise.ok",
      await revise.execute(ctx, {
        ...revision,
        id: proposalId,
        expected_revision: 1,
        item_ids: [first.id],
      }),
    );
    record(
      "revise.stale",
      await revise.execute(ctx, {
        ...revision,
        id: proposalId,
        expected_revision: 1,
        item_ids: [first.id],
      }),
    );
    record(
      "revise.source_missing",
      await revise.execute(ctx, {
        ...revision,
        id: proposalId,
        expected_revision: 2,
        item_ids: [first.id],
        target: { knowledge_source_id: MISSING },
      }),
    );
  });

  test("audit trail", async () => {
    recordRows("audit", await auditRows());
  });

  test("the golden file has no stale entries", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(golden).sort());
  });
});
