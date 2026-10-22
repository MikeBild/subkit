import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connectors } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import {
  graphqlProjectItemsStep,
  lossyConversionPatches,
  VALID_ITEMS_QUERY,
} from "../../workflows/tests/fixtures/graphql-over-http.ts";
import { editWorkflowPatchTool } from "../tools/edit-workflow-patch.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

const uuid = createDeterministicUuidFactory(0x6a9c_0f11);

let ctx: ConversationTestCtx;
let graphqlConnectorId: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("edit-patch-graphql-conversion");
  const [connector] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenant_id,
      slug: "github-graphql-conversion",
      display_name: "GitHub GraphQL",
      driver: "graphql",
      environment: "dev",
      auth_type: "none",
      base_url: "https://api.github.com/graphql",
      config: {},
    })
    .returning();
  if (!connector) throw new Error("seed graphql connector failed");
  graphqlConnectorId = connector.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

function draftWith(connectorId: string): DraftDocument {
  return {
    workflow: {
      name: "harmoniqs-github-briefing",
      slug: "harmoniqs-github-briefing",
      steps: [{ ...graphqlProjectItemsStep(), connector_id: connectorId }],
    },
  } as unknown as DraftDocument;
}

function toolCtx(draftRef: { current: DraftDocument }): ToolContext {
  return {
    db: ctx.testDb.db,
    tenant_id: ctx.tenant_id,
    conversation_id: uuid(),
    actor_id: ctx.user_id,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      db: ctx.testDb.db,
    }),
    getDraft: () => draftRef.current,
    setDraft: async (next) => {
      draftRef.current = next;
    },
  } as ToolContext;
}

describe("edit_workflow_patch · graphql step converted to POST /graphql", () => {
  test.each([
    ["the briefing patch", undefined],
    ["a parseable document", VALID_ITEMS_QUERY],
  ])("refuses %s and keeps the draft", async (_label, query) => {
    const draftRef = { current: draftWith(ctx.connector_id) };
    const before = JSON.stringify(draftRef.current);
    const result = await editWorkflowPatchTool.execute(toolCtx(draftRef), {
      workflow: "harmoniqs-github-briefing",
      step_patches: lossyConversionPatches(query),
    });
    expect(result.ok).toBe(false);
    const data = result.data as {
      error_code?: string;
      message?: string;
      next_best_actions?: string[];
      steps?: string[];
    };
    expect(data.error_code).toBe("graphql_conversion_lossy");
    expect(data.message).toContain("cursor pagination");
    expect(data.message).toContain("graphql connector");
    expect(data.message).toContain("REST endpoint");
    expect(data.message).toContain("project_items");
    expect(data.next_best_actions).toContain("find_connector");
    expect(JSON.stringify(draftRef.current)).toBe(before);
  });

  test("still applies an edit inside the graphql block", async () => {
    const draftRef = { current: draftWith(graphqlConnectorId) };
    const result = await editWorkflowPatchTool.execute(toolCtx(draftRef), {
      workflow: "harmoniqs-github-briefing",
      step_patches: [
        { op: "replace", path: "/graphql/variables/number", value: 4, step_id: "project_items" },
      ],
    });
    expect(result.ok).toBe(true);
    const step = (
      draftRef.current.workflow as unknown as {
        steps: Array<{ graphql: { variables: { number: number } } }>;
      }
    ).steps[0];
    expect(step?.graphql.variables.number).toBe(4);
  });
});
