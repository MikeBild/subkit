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

test("an MCP tool call shows its tool, the effect as stated, its ceiling and its argument variables", async () => {
  const [server] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: "tools",
      display_name: "Tools server",
      driver: "mcp",
      environment: "dev",
      auth_type: "none",
      base_url: "https://tools.example.test/mcp",
      config: { mcp: { transport: "http" } },
    })
    .returning();
  if (!server) throw new Error("mcp connector insert failed");
  const definition = {
    name: "Tool call",
    steps: [
      {
        id: "lookup",
        kind: "request",
        protocol: "mcp",
        connector_id: server.id,
        mcp: {
          operation: "call_tool",
          tool: "search",
          arguments: { q: "${input.q}", mode: "exact" },
          boundary: {
            effect: "read",
            variables: { "input.q": { enum: ["alpha"] } },
            max_calls: 3,
            descriptor: {
              input_schema_digest: "a".repeat(64),
              annotations: { readOnlyHint: true },
            },
          },
        },
      },
    ],
  };
  const review = await resolveWorkflowReviewManifest(
    { tenant_id: tenantId, definition, environment: "dev" },
    testDb.db,
  );
  expect(review.effects).toEqual([
    {
      step_id: "lookup",
      connector_name: "Tools server",
      connector_slug: "tools",
      effect: "read",
      target: "https://tools.example.test/mcp#search",
      details: [
        "tools/call:search",
        "Effect read as stated on the step; the tool's description is compared with the server only when you approve",
        "At most 3 calls",
        "Argument variables: q (input.q)",
      ],
    },
  ]);
});

test("a model step appears in the review as an AI model effect", async () => {
  const review = await resolveWorkflowReviewManifest(
    {
      tenant_id: tenantId,
      definition: {
        name: "Sort messages",
        steps: [
          {
            id: "classify",
            kind: "model",
            prompt: "Sort ${input.text}",
            output_schema: { type: "object" },
            max_output_tokens: 300,
          },
        ],
      },
      environment: "dev",
    },
    testDb.db,
  );
  expect(review.manifest.model_calls?.map((call) => call.step_id)).toEqual(["classify"]);
  expect(review.effects).toEqual([
    {
      step_id: "classify",
      connector_name: "AI model",
      connector_slug: null,
      effect: "read",
      target: "workspace AI model",
      details: [
        "Sends step data to the workspace AI model",
        "At most 300 output tokens per call",
        "Counts against the AI budget",
        "Data paths: input.text",
      ],
    },
  ]);
});
