import { afterAll, beforeAll, expect, test } from "bun:test";
import { connectors, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { resolveWorkflowReviewManifest } from "./review-manifest.ts";

let testDb: TestDb;
let tenantId: string;
let connectorId: string;

beforeAll(async () => {
  testDb = await createTestDb("workflow-review-manifest");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "workflow-review-manifest", display_name: "Workflow review manifest" })
    .returning();
  if (!tenant) throw new Error("tenant insert failed");
  tenantId = tenant.id;
  const [connector] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "reports",
      display_name: "Reports API",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://reports.example.test/api",
    })
    .returning();
  if (!connector) throw new Error("connector insert failed");
  connectorId = connector.id;
});

afterAll(async () => {
  await testDb?.cleanup();
});

test("resolves an unsaved candidate through tenant connector facts without persisting it", async () => {
  const definition = {
    name: "Weekly report",
    steps: [
      {
        id: "send",
        kind: "request",
        method: "POST",
        connector_id: connectorId,
        path: "/reports?token=secret",
      },
    ],
    trigger: { kind: "schedule", cron: "0 10 * * 1", tz: "Europe/Berlin" },
  };
  const first = await resolveWorkflowReviewManifest(
    { tenant_id: tenantId, definition, environment: "dev" },
    testDb.db,
  );
  const second = await resolveWorkflowReviewManifest(
    {
      tenant_id: tenantId,
      workflow_id: "00000000-0000-4000-8000-000000000099",
      definition,
      environment: "dev",
    },
    testDb.db,
  );

  expect(first.digest).toBe(second.digest);
  expect(first.effects).toEqual([
    {
      step_id: "send",
      connector_name: "Reports API",
      connector_slug: "reports",
      effect: "write",
      target: "https://reports.example.test/api/reports",
      details: ["POST"],
    },
  ]);
  expect(first.affected_triggers).toEqual([
    {
      kind: "schedule",
      name: "Workflow schedule",
      cron: "0 10 * * 1",
      timezone: "Europe/Berlin",
    },
  ]);
});
