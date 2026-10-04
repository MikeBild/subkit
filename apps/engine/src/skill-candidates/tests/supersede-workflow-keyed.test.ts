// A workflow-keyed proposal has exactly one live candidate per workflow.
//
// The capability candidate is attributed to a connector only while the
// workflow uses exactly one; with several (or none) it carries no connector.
// Supersede used to narrow by the signal's connector too, so a workflow that
// moved from several connectors to one, or from one connector to another,
// kept its previous proposal open beside the new one.
//
// Requires a real Postgres database — set REQUIRES_PG=0 to skip.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectors } from "../../db/schema/connectors.ts";
import { tenants } from "../../db/schema/identity.ts";
import { skillCandidates } from "../../db/schema/skills.ts";
import { workflows } from "../../db/schema/workflows.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { upsertFromSignal } from "../service.ts";
import type { PatternSignal } from "../types.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;
let workflowId: string;
const connectorIds: string[] = [];

beforeAll(async () => {
  if (skip) return;
  testDb = await createTestDb("supersede-workflow-keyed");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "swk-tenant", display_name: "SWK Tenant" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
  for (const slug of ["swk-a", "swk-b"]) {
    const [conn] = await testDb.db
      .insert(connectors)
      .values({ tenant_id: tenantId, slug, display_name: slug, driver: "http" })
      .returning();
    if (!conn) throw new Error("seed connector failed");
    connectorIds.push(conn.id);
  }
  const [wf] = await testDb.db
    .insert(workflows)
    .values({ tenant_id: tenantId, slug: "swk-wf", name: "SWK", lifecycle: "active" })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  workflowId = wf.id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

afterEach(async () => {
  if (skip) return;
  await testDb.db.delete(skillCandidates);
}, 30_000);

function capability(fingerprint: string, connectorId: string | null): PatternSignal {
  return {
    pattern_kind: "authoring_capability",
    scope: "workflow",
    workflow_id: workflowId,
    ...(connectorId ? { connector_id: connectorId } : {}),
    title: "Workflow 'swk-wf' capabilities",
    body: `shape ${fingerprint}`,
    examples: [],
    best_practices: [],
    pitfalls: [],
    doc_refs: [],
    fingerprint,
    confidence: "high",
    evidence: [{ evidence_type: "workflow_committed", summary: `commit ${fingerprint}` }],
  };
}

async function liveForWorkflow(): Promise<string[]> {
  const rows = await testDb.db
    .select({ fingerprint: skillCandidates.fingerprint })
    .from(skillCandidates)
    .where(
      and(
        eq(skillCandidates.tenant_id, tenantId),
        eq(skillCandidates.workflow_id, workflowId),
        eq(skillCandidates.status, "proposed"),
      ),
    );
  return rows.map((row) => row.fingerprint);
}

describe.skipIf(skip)("workflow-keyed supersede", () => {
  test("several connectors, then one: the earlier proposal is superseded", async () => {
    await upsertFromSignal(tenantId, capability("fp-many", null), testDb.db);
    await upsertFromSignal(tenantId, capability("fp-one", connectorIds[0]!), testDb.db);
    expect(await liveForWorkflow()).toEqual(["fp-one"]);
  }, 30_000);

  test("one connector, then another: the earlier proposal is superseded", async () => {
    await upsertFromSignal(tenantId, capability("fp-a", connectorIds[0]!), testDb.db);
    await upsertFromSignal(tenantId, capability("fp-b", connectorIds[1]!), testDb.db);
    expect(await liveForWorkflow()).toEqual(["fp-b"]);
  }, 30_000);
});
