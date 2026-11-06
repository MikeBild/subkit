import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  catalogCategories,
  conversations,
  conversationToolCalls,
  executions,
  intakeItems,
  intakeProposals,
  skillEffectiveness,
  workflows,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  confirmIntakeProposal,
  createIntakeProposal,
  createSessionIntakeItem,
} from "../../knowledge/index.ts";
import {
  createDeterministicClock,
  FROZEN_NOW,
  installClock,
  restoreClock,
} from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { measureCorrectionEffectiveness } from "../correction-effectiveness.ts";
import { collectCorrectionIntake } from "../correction-intake.ts";

const uuid = createDeterministicUuidFactory(0xc0eff1);

const skip = process.env.REQUIRES_PG === "0";
const DAY = 24 * 60 * 60 * 1000;
const CONFIRMED_AT = new Date(FROZEN_NOW - 3 * DAY);

let testDb: TestDb;

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("correction_effectiveness");
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
  restoreClock(null);
}, 30_000);

afterEach(() => {
  restoreClock(null);
});

async function seedTenantWithWorkflow(): Promise<{ tenant_id: string; workflow_id: string }> {
  const slug = `corr-eff-${uuid().slice(0, 8)}`;
  const tenant = await seedTenant(testDb.db, { slug, display_name: slug });
  await testDb.db.insert(catalogCategories).values({ tenant_id: tenant.id, name: "orders" });
  const [workflow] = await testDb.db
    .insert(workflows)
    .values({ tenant_id: tenant.id, slug: "orders", name: "Orders", lifecycle: "draft" })
    .returning({ id: workflows.id });
  if (!workflow) throw new Error("workflow seed failed");
  return { tenant_id: tenant.id, workflow_id: workflow.id };
}

async function seedJudgeFailure(tenant_id: string, workflow_id: string, at: Date): Promise<void> {
  const [conversation] = await testDb.db
    .insert(conversations)
    .values({ tenant_id, target_workflow_id: workflow_id, status: "active" })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("conversation seed failed");
  await testDb.db.insert(conversationToolCalls).values({
    tenant_id,
    conversation_id: conversation.id,
    tool: "dry_run_workflow",
    input: {},
    output: { judge: { verdict: "failed", reason: "no rows", missing: [] } },
    created_at: at,
  });
}

async function seedExecution(tenant_id: string, workflow_id: string, at: Date): Promise<void> {
  await testDb.db.insert(executions).values({
    tenant_id,
    workflow_id,
    status: "succeeded",
    request_source: "api",
    execution_mode: "prod",
    started_at: at,
  });
}

async function admitAsSkill(tenant_id: string, workflow_id: string): Promise<string> {
  const [item] = await testDb.db
    .select()
    .from(intakeItems)
    .where(eq(intakeItems.tenant_id, tenant_id));
  if (!item) throw new Error("intake item missing");
  const person = { kind: "user" as const, id: uuid() };
  const proposal = await createIntakeProposal(
    {
      tenant_id,
      actor: person,
      item_ids: [item.id],
      title: "Orders preview rows",
      body: "Select the orders array before shaping rows.",
      target: {
        skill: {
          new: {
            title: "Orders rows",
            scope: "workflow",
            workflow_id,
            tags: [],
            category: "orders",
          },
          supersedes: [],
        },
      },
    },
    testDb.db,
  );
  await confirmIntakeProposal(
    {
      tenant_id,
      actor: person,
      id: proposal.id,
      expected_revision: proposal.current_revision,
      digest: proposal.revision.digest,
      authorize: async () => {},
    },
    testDb.db,
  );
  await testDb.db
    .update(intakeProposals)
    .set({ updated_at: CONFIRMED_AT })
    .where(and(eq(intakeProposals.tenant_id, tenant_id), eq(intakeProposals.id, proposal.id)));
  return proposal.id;
}

describe.skipIf(skip)("measureCorrectionEffectiveness", () => {
  test("an admitted correction records executions and recurrences before and after", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));
    const { tenant_id, workflow_id } = await seedTenantWithWorkflow();
    const other = await seedTenantWithWorkflow();
    await seedJudgeFailure(tenant_id, workflow_id, new Date(FROZEN_NOW - 5 * DAY));
    await collectCorrectionIntake(tenant_id, testDb.db);
    const proposalId = await admitAsSkill(tenant_id, workflow_id);
    await seedJudgeFailure(tenant_id, workflow_id, new Date(FROZEN_NOW - DAY));
    await collectCorrectionIntake(tenant_id, testDb.db);
    await seedExecution(tenant_id, workflow_id, new Date(FROZEN_NOW - 4 * DAY));
    await seedExecution(tenant_id, workflow_id, new Date(FROZEN_NOW - 4 * DAY));
    await seedExecution(tenant_id, workflow_id, new Date(FROZEN_NOW - 2 * DAY));
    await seedExecution(tenant_id, workflow_id, new Date(FROZEN_NOW - 20 * DAY));
    await seedExecution(other.tenant_id, other.workflow_id, new Date(FROZEN_NOW - 2 * DAY));

    const first = await measureCorrectionEffectiveness(tenant_id, testDb.db);
    const second = await measureCorrectionEffectiveness(tenant_id, testDb.db);

    expect(first.measured).toBe(1);
    expect(second.measured).toBe(1);
    const rows = await testDb.db
      .select()
      .from(skillEffectiveness)
      .where(eq(skillEffectiveness.tenant_id, tenant_id));
    expect(rows).toHaveLength(1);
    const [proposal] = await testDb.db
      .select()
      .from(intakeProposals)
      .where(eq(intakeProposals.id, proposalId));
    expect(rows[0]).toMatchObject({
      skill_id: proposal?.confirmed_target_id,
      intake_proposal_id: proposalId,
      skill_candidate_id: null,
      executions_before: 2,
      failures_before: 1,
      executions_after: 1,
      failures_after: 1,
    });
    expect(rows[0]?.window_start.getTime()).toBe(CONFIRMED_AT.getTime() - 14 * DAY);
    expect((await measureCorrectionEffectiveness(other.tenant_id, testDb.db)).measured).toBe(0);
  });

  test("a confirmed proposal without correction items is not measured", async () => {
    installClock(createDeterministicClock(FROZEN_NOW));
    const { tenant_id, workflow_id } = await seedTenantWithWorkflow();
    await createSessionIntakeItem(
      {
        tenant_id,
        actor: null,
        session: {
          agent: "codex",
          session_id: "session-1",
          domains: [],
          evidence_excerpt: "noted in a coding session",
        },
        title: "Orders rows",
        body: "Select the orders array first.",
        captured_at: new Date(FROZEN_NOW - 5 * DAY).toISOString(),
      },
      testDb.db,
    );
    await admitAsSkill(tenant_id, workflow_id);

    const report = await measureCorrectionEffectiveness(tenant_id, testDb.db);

    expect(report.measured).toBe(0);
  });
});
