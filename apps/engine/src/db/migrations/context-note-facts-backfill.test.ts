import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { toView } from "../../skill-candidates/candidate-view.ts";
import { createWorkflow } from "../../workflows/service.ts";
import { dataMigrations, skillCandidates, tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import {
  CONTEXT_NOTE_FACTS_BACKFILL_NAME,
  runContextNoteFactsBackfill,
} from "./context-note-facts-backfill.ts";

let testDb: TestDb;
let tenantId: string;
let workflowId: string;

const OLD_BODY = [
  "Workflow 'Users report' (slug users-report) — what it does and how to invoke it.",
  "Saved draft version v-1. This candidate describes preparation, not an active capability. Approving this skill does not activate the workflow or authorize execution.",
  "Inputs: limit: integer (required).",
].join("\n");

async function seedNote(
  pattern_kind: "authoring_capability" | "failure_pattern",
  body: string,
): Promise<string> {
  const [row] = await testDb.db
    .insert(skillCandidates)
    .values({
      tenant_id: tenantId,
      scope: "workflow",
      workflow_id: workflowId,
      pattern_kind,
      title: `${pattern_kind} note`,
      body,
      examples: { examples: [], best_practices: [], pitfalls: [], doc_refs: [] },
      evidence: [],
      confidence: "high",
      status: "context",
      fingerprint: `factless-${pattern_kind}`,
    })
    .returning({ id: skillCandidates.id });
  if (!row) throw new Error("seed note failed");
  return row.id;
}

beforeAll(async () => {
  testDb = await createTestDb("context_note_facts_backfill");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-context-facts", display_name: "Context facts" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  const created = await createWorkflow(
    {
      tenant_id: tenantId,
      actor_id: null,
      def: {
        name: "Users report",
        slug: "users-report",
        input_schema: {
          type: "object",
          properties: { limit: { type: "integer" } },
          required: ["limit"],
        },
        steps: [{ id: "shape", kind: "transform", expression: "return input;" }],
      },
    },
    testDb.db,
  );
  if (!created.workflow) throw new Error(`seed workflow failed: ${JSON.stringify(created.errors)}`);
  workflowId = created.workflow.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("context note facts backfill", () => {
  test("rewrites a note that only had prose from the saved workflow, and drops a stale failure note", async () => {
    await testDb.db
      .delete(dataMigrations)
      .where(eq(dataMigrations.name, CONTEXT_NOTE_FACTS_BACKFILL_NAME));
    await seedNote("authoring_capability", OLD_BODY);
    const failure = await seedNote(
      "failure_pattern",
      "Step 'shape' fails with 'driver_error' consistently (3 times in 30 days).",
    );

    const report = await runContextNoteFactsBackfill(testDb.db);
    expect(report.skipped).toBe(false);
    expect(report.dropped).toBe(1);

    const open = await testDb.db
      .select()
      .from(skillCandidates)
      .where(eq(skillCandidates.tenant_id, tenantId));
    const capability = open.filter(
      (row) => row.pattern_kind === "authoring_capability" && row.status === "context",
    );
    expect(capability).toHaveLength(1);
    const view = toView(capability[0]!);
    expect(view.body).not.toContain("Approving this skill");
    expect(view.facts).toMatchObject({
      kind: "workflow_capability",
      inputs: [{ name: "limit", type: "integer", required: true }],
      steps: [{ id: "shape", kind: "transform" }],
      connector_ids: [],
    });
    expect(open.some((row) => row.id === failure)).toBe(false);
  });

  test("runs once", async () => {
    const marker = await testDb.db
      .select()
      .from(dataMigrations)
      .where(eq(dataMigrations.name, CONTEXT_NOTE_FACTS_BACKFILL_NAME));
    expect(marker).toHaveLength(1);
    expect((await runContextNoteFactsBackfill(testDb.db)).skipped).toBe(true);
  });
});
