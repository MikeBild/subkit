import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { skillCandidates, tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

let testDb: TestDb;
let tenantId: string;

const migration = EMBEDDED_MIGRATIONS.find(
  (m) => m.tag === "0080_skill_candidate_context_backfill",
);

type Kind = (typeof skillCandidates.$inferInsert)["pattern_kind"];
type Status = (typeof skillCandidates.$inferInsert)["status"];

async function seed(pattern_kind: Kind, status: Status): Promise<string> {
  const [row] = await testDb.db
    .insert(skillCandidates)
    .values({
      tenant_id: tenantId,
      scope: "global",
      pattern_kind,
      title: `${pattern_kind} ${status}`,
      body: "b",
      evidence: {},
      confidence: "high",
      status,
      fingerprint: `backfill-${pattern_kind}-${status}`,
    })
    .returning({ id: skillCandidates.id });
  if (!row) throw new Error("seed candidate failed");
  return row.id;
}

async function statusOf(id: string): Promise<string | undefined> {
  const [row] = await testDb.db
    .select({ status: skillCandidates.status })
    .from(skillCandidates)
    .where(eq(skillCandidates.id, id));
  return row?.status;
}

beforeAll(async () => {
  testDb = await createTestDb("skill_candidate_context_backfill");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-context-backfill", display_name: "Context backfill" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("0080_skill_candidate_context_backfill", () => {
  test("the enum value and the backfill are separate migrations", () => {
    expect(EMBEDDED_MIGRATIONS.some((m) => m.tag === "0079_skill_candidate_context_status")).toBe(
      true,
    );
    expect(migration).toBeDefined();
  });

  test("moves open advisory notes to context and leaves everything else alone", async () => {
    const capability = await seed("authoring_capability", "proposed");
    const failure = await seed("failure_pattern", "proposed");
    const decidedFailure = await seed("failure_pattern", "rejected");
    const supersededCapability = await seed("authoring_capability", "superseded");
    const approvedCapability = await seed("authoring_capability", "approved");
    const learning = await seed("session_learning", "proposed");
    const connector = await seed("connector_capability", "proposed");
    const repair = await seed("repair_pattern", "proposed");

    for (const statement of migration!.statements) await testDb.db.execute(sql.raw(statement));

    expect(await statusOf(capability)).toBe("context");
    expect(await statusOf(failure)).toBe("context");
    expect(await statusOf(decidedFailure)).toBe("rejected");
    expect(await statusOf(supersededCapability)).toBe("superseded");
    expect(await statusOf(approvedCapability)).toBe("approved");
    expect(await statusOf(learning)).toBe("proposed");
    expect(await statusOf(connector)).toBe("proposed");
    expect(await statusOf(repair)).toBe("proposed");
  });
});
