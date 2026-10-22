import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectors, conversations, conversationToolCalls } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  graphqlProjectItemsStep,
  HARMONIQS_ITEMS_QUERY,
  lossyConversionPatches,
} from "../../workflows/tests/fixtures/graphql-over-http.ts";
import {
  createEmptyDraftDocument,
  withLatestPreview,
  withWorkflowDraft,
  withWorkflowInspection,
  withWorkflowValidation,
} from "../authoring-state.ts";
import type { DraftDocument, TurnEvent } from "../types.ts";
import {
  appendMessageWithTurn,
  type ConversationTestCtx,
  createConversationTestCtx,
} from "./setup.ts";

const PROMPT =
  "Repariere die Pagination im GitHub-Briefing und speichere die Änderung, soweit erlaubt. Nicht aktivieren. Erkläre Ergebnis und nächsten Schritt kurz.";
const SLUG = "harmoniqs-github-briefing";

let ctx: ConversationTestCtx;
let graphqlConnectorId: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("graphql_conversion_turn");
  const [connector] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenant_id,
      slug: "github-graphql-turn",
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

beforeEach(() => {
  getMockProvider().calls = [];
});

async function seedConversation(): Promise<string> {
  let draft: DraftDocument = withWorkflowDraft(createEmptyDraftDocument(), {
    name: SLUG,
    slug: SLUG,
    steps: [{ ...graphqlProjectItemsStep(), connector_id: graphqlConnectorId }],
  } as unknown as Parameters<typeof withWorkflowDraft>[1]);
  draft = withWorkflowValidation(withWorkflowInspection(draft), true, "Workflow draft valid.");
  draft = withLatestPreview(draft, {
    ok: true,
    step_id: "project_items",
    summary: "Preview ok.",
    warnings: [],
  });
  const [conversation] = await ctx.testDb.db
    .insert(conversations)
    .values({
      tenant_id: ctx.tenant_id,
      status: "active",
      owner_id: ctx.user_id,
      draft: draft as unknown as Record<string, unknown>,
    })
    .returning();
  if (!conversation) throw new Error("conversation insert failed");
  return conversation.id;
}

function toolOutput(events: TurnEvent[], tool: string): Record<string, unknown> | undefined {
  const found = events.filter((e) => e.type === "tool_result" && e.tool === tool).at(-1);
  return found && found.type === "tool_result"
    ? (found.output as Record<string, unknown>)
    : undefined;
}

async function persistedStep(conversationId: string) {
  const [row] = await ctx.testDb.db
    .select({ draft: conversations.draft })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, ctx.tenant_id), eq(conversations.id, conversationId)));
  const draft = row?.draft as { workflow?: { steps?: Array<Record<string, unknown>> } } | undefined;
  return draft?.workflow?.steps?.find((step) => step.id === "project_items");
}

describe("PROD acceptance patch through a full conversation turn", () => {
  test("a graphql step converted to POST /graphql with an unbalanced query is refused, the draft keeps its cursor pagination and the turn closes with text and no save card", async () => {
    expect((HARMONIQS_ITEMS_QUERY.match(/{/g) ?? []).length).not.toBe(
      (HARMONIQS_ITEMS_QUERY.match(/}/g) ?? []).length,
    );
    const conversationId = await seedConversation();
    getMockProvider().setConversePlan(conversationId, [
      { tool: "edit_workflow_patch", args: { step_patches: lossyConversionPatches() } },
    ]);
    const outcome = await appendMessageWithTurn(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversationId,
        actor_id: ctx.user_id,
        message: PROMPT,
      },
      ctx.testDb.db,
    );
    const events = outcome.result.events;

    const edit = toolOutput(events, "edit_workflow_patch");
    expect(edit?.error_code).toBe("graphql_conversion_lossy");
    expect(String(edit?.message)).toContain("cursor pagination");

    const [storedEdit] = await ctx.testDb.db
      .select({ output: conversationToolCalls.output })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, ctx.tenant_id),
          eq(conversationToolCalls.conversation_id, conversationId),
          eq(conversationToolCalls.tool, "edit_workflow_patch"),
        ),
      );
    expect(JSON.stringify(storedEdit?.output)).toContain("graphql_conversion_lossy");

    const step = await persistedStep(conversationId);
    expect(step?.method).toBe("GET");
    expect(step?.path).toBeUndefined();
    expect(step?.body).toBeUndefined();
    expect(
      (step?.graphql as { cursor_pagination?: { connection_path?: string } } | undefined)
        ?.cursor_pagination?.connection_path,
    ).toBe("user.projectV2.items");

    expect(events.some((e) => e.type === "elicit_request")).toBe(false);
    const resultIndex = events.findIndex(
      (e) => e.type === "tool_result" && e.tool === "edit_workflow_patch",
    );
    const closing = events
      .slice(resultIndex + 1)
      .filter((e) => e.type === "message" && e.role === "assistant")
      .at(-1);
    const text =
      closing?.type === "message" ? ((closing.content as { text?: string }).text ?? "") : "";
    expect(text.trim().length).toBeGreaterThan(0);
  });
});
