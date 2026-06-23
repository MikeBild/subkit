// OPT-E end-to-end: does the "Connector operations" block actually reach the
// assembled system prompt? The loader/formatter are unit-tested separately;
// this is the DECISIVE integration check that the wiring fires under the same
// workflow-authoring-mode gate the existing "Recorded endpoint samples" feature
// uses — i.e. whether OPT-E injects at all when its conditions are met.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import * as discoveryModule from "../../../connectors/discovery/index.ts";
import { runDiscoveryCached } from "../../../connectors/discovery/service.ts";
import type { DiscoveryResult } from "../../../connectors/discovery/types.ts";
import { connectors, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import type { AuthoringPromptHint } from "../../types.ts";
import { assembleEnhancedPrompt } from "../context-assembler.ts";

const skip = process.env.REQUIRES_PG === "0";
const ROOMY_MODEL = "claude-sonnet-4-5";

let ctx: TestDb;
let tenant_id: string;
let connector_id: string;

const GQL_INDEX: DiscoveryResult = {
  source_url: "https://api.example.test/graphql",
  fetched_at: "2026-04-26T00:00:00.000Z",
  strategy: "graphql-introspect",
  spec_version: null,
  title: "Example GraphQL",
  servers: ["https://api.example.test/graphql"],
  auth_schemes: [],
  endpoints: [
    {
      method: "POST",
      path: "/graphql",
      summary: "things",
      description: null,
      operation_id: "things",
      scopes: [],
      params: [
        { name: "filter", in: "body", required: false, type: "ThingFilter" },
        { name: "orderBy", in: "body", required: false, type: "ThingOrderBy" },
      ],
      request_body_schema: null,
      response_schemas: { "200": { type: "object" } },
      pagination_hint: null,
      deprecated: false,
    },
  ],
  warnings: [],
};

function authoringHintFor(mode: "connector" | "workflow"): AuthoringPromptHint {
  return {
    mode,
    stage: mode === "workflow" ? "workflow_draft_started" : "connector_draft_started",
    lifecycle_state: "draft_only",
    active_target: { kind: mode, lifecycle_state: "draft_only" },
    blocked_by: [],
    next_required_action: null,
    next_suggested_tool: null,
    checkpoints: [],
    latest_execution: null,
    latest_diagnosis: null,
  };
}

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("connector_schema_injection");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-inj", display_name: "Inject Tenant" })
    .returning();
  tenant_id = t!.id;
  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "example-gql",
      display_name: "Example GQL",
      driver: "graphql",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.example.test/graphql",
    })
    .returning();
  connector_id = c!.id;
  const spy = spyOn(discoveryModule, "discoverConnectorEndpoints").mockResolvedValue(GQL_INDEX);
  try {
    await runDiscoveryCached(
      { db: ctx.db, tenant_id, actor_id: null },
      { base_url: "https://api.example.test/graphql" },
    );
  } finally {
    spy.mockRestore();
  }
});

afterAll(async () => {
  if (!skip) await ctx.cleanup();
});

describe.skipIf(skip)("OPT-E connector-operations injection", () => {
  test("injects the 'Connector operations' block in workflow-authoring mode", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        connector_id,
        user_turns: [{ role: "user", content: "build a workflow listing things" }],
        max_tokens: 50_000,
        model: ROOMY_MODEL,
        authoring_hint: authoringHintFor("workflow"),
        authoring_connector_ids: [connector_id],
      },
      ctx.db,
    );
    expect(prompt.system).toContain("Connector operations");
    expect(prompt.system).toContain("things(filter: ThingFilter, orderBy: ThingOrderBy)");
  });

  test("block is ABSENT outside workflow-authoring mode (connector mode)", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        tenant_id,
        flow: "converse",
        connector_id,
        user_turns: [{ role: "user", content: "set up the connector" }],
        max_tokens: 50_000,
        model: ROOMY_MODEL,
        authoring_hint: authoringHintFor("connector"),
        authoring_connector_ids: [connector_id],
      },
      ctx.db,
    );
    expect(prompt.system).not.toContain("Connector operations");
  });
});
