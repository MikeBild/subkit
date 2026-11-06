import { afterAll, beforeAll, expect, test } from "bun:test";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { createTestDb, type TestDb } from "./setup.ts";

const nextId = createDeterministicUuidFactory(1_132);
const tenantId = nextId();
const actorId = nextId();
const itemId = nextId();
let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("schema_constraints");
  await ctx.pool.query(
    `INSERT INTO subkit.tenants (id, slug, display_name)
     VALUES ($1, 'schema-constraints', 'Schema constraints')`,
    [tenantId],
  );
  await ctx.pool.query(
    `INSERT INTO subkit.intake_items
      (id, tenant_id, category, client_request_id, creation_request_digest, original_snapshot,
       title, body, collected_by_type, collected_by_id)
     VALUES ($1, $2, 'inbox', $3, 'item-digest', '{}'::jsonb, 'Recording notes', 'Body', 'user', $4)`,
    [itemId, tenantId, nextId(), actorId],
  );
});

afterAll(async () => {
  await ctx?.cleanup();
});

async function constraintDefinition(table: string, name: string): Promise<string | undefined> {
  const result = await ctx.pool.query<{ definition: string }>(
    `SELECT pg_get_constraintdef(oid) AS definition FROM pg_catalog.pg_constraint
      WHERE conrelid = $1::regclass AND conname = $2`,
    [`subkit.${table}`, name],
  );
  return result.rows[0]?.definition;
}

test("credential generations stay positive and step credential snapshots stay arrays", async () => {
  expect(
    await constraintDefinition("credentials", "credentials_credential_generation_positive"),
  ).toBe("CHECK ((credential_generation > 0))");
  expect(
    await constraintDefinition("execution_steps", "execution_steps_credential_snapshots_array"),
  ).toBe("CHECK ((jsonb_typeof(credential_snapshots) = 'array'::text))");
});

test("intake items reject a target kind without a target", async () => {
  await expect(
    ctx.pool.query(`UPDATE subkit.intake_items SET admitted_target_kind = 'skill' WHERE id = $1`, [
      itemId,
    ]),
  ).rejects.toThrow("intake_items_admitted_target_check");
});

test("intake evidence is unique per session and append-only", async () => {
  const insert = `INSERT INTO subkit.intake_item_evidence
      (tenant_id, item_id, agent, session_id, excerpt, captured_at, recorded_by_type, recorded_by_id)
     VALUES ($1, $2, 'codex', 'session-1', $3, now(), 'user', $4)`;
  await ctx.pool.query(insert, [tenantId, itemId, "Evidence", actorId]);
  await expect(ctx.pool.query(insert, [tenantId, itemId, "Replay", actorId])).rejects.toThrow(
    "intake_item_evidence_item_session_key",
  );
  await expect(
    ctx.pool.query(`UPDATE subkit.intake_item_evidence SET excerpt = 'changed'`),
  ).rejects.toThrow("append-only");
});
