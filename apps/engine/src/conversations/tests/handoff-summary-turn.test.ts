import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  workflows,
} from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { logger } from "../../logging/logger.ts";
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
  respondElicitationForTest,
} from "./setup.ts";

const PROD_PROMPT =
  "Bereite diesen Ablauf für den automatischen Betrieb vor. Prüfe den bestehenden Zeitplan und die Ziele; ändere sie nur auf meinen Wunsch. Übernimm die erlaubten Prüfungen selbst und speichere die vorbereiteten Änderungen, soweit erlaubt. Nicht aktivieren, keine Live-Wirkungen freigeben oder ausführen. Fehlt eine fachliche Entscheidung, stelle eine kurze Frage mit klaren Auswahlmöglichkeiten. Erkläre Ergebnis und nächsten Schritt kurz.";
const TOOL_NAME = /\b[a-z]+_[a-z_]+\b/;

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("handoff_summary_turn");
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  getMockProvider().calls = [];
});

async function seedConversation(
  slug: string,
  options: { sensitive: boolean; previewed: boolean },
): Promise<string> {
  let draft: DraftDocument = withWorkflowDraft(createEmptyDraftDocument(), {
    name: slug,
    slug,
    steps: [
      {
        id: "project_items",
        kind: "transform",
        language: "javascript",
        expression: "return [];",
      },
    ],
    ...(options.sensitive ? { execution_privacy: "sensitive" as const } : {}),
  });
  draft = withWorkflowValidation(withWorkflowInspection(draft), true, "Workflow draft valid.");
  if (options.previewed) {
    draft = withLatestPreview(draft, {
      ok: true,
      step_id: "project_items",
      summary: "Preview ok.",
      warnings: [],
    });
  }
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

const EDIT_THEN_SAVE = [
  {
    tool: "edit_workflow_patch",
    args: {
      step_patches: [
        {
          step_id: "project_items",
          op: "replace",
          path: "/expression",
          value: "return [1];",
        },
      ],
    },
  },
  { tool: "inspect_workflow_draft", args: { step_ids: ["project_items"], include_preview: false } },
  { tool: "validate_draft", args: {} },
  { tool: "save_workflow_draft", args: { confirmed: false, force_commit: false } },
];

async function turn(conversationId: string, message: string) {
  return appendMessageWithTurn(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: conversationId,
      actor_id: ctx.user_id,
      message,
    },
    ctx.testDb.db,
  );
}

function toolOutput(events: TurnEvent[], tool: string): Record<string, unknown> | undefined {
  const found = events.filter((e) => e.type === "tool_result" && e.tool === tool).at(-1);
  return found && found.type === "tool_result"
    ? (found.output as Record<string, unknown>)
    : undefined;
}

async function assistantRows(conversationId: string) {
  const rows = await ctx.testDb.db
    .select({ role: conversationMessages.role, content: conversationMessages.content })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, ctx.tenant_id),
        eq(conversationMessages.conversation_id, conversationId),
      ),
    )
    .orderBy(asc(conversationMessages.created_at));
  return rows
    .filter((row) => row.role === "assistant")
    .map((row) => row.content as { text?: string; _reason?: string; _synthetic?: boolean });
}

async function elicitationInput(id: string) {
  const [row] = await ctx.testDb.db
    .select({ input: conversationElicitations.input, summary: conversationElicitations.summary })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, ctx.tenant_id),
        eq(conversationElicitations.id, id),
      ),
    );
  return row;
}

function closingMessage(events: TurnEvent[]): string {
  const cardIndex = events.findIndex((e) => e.type === "elicit_request");
  expect(cardIndex).toBeGreaterThanOrEqual(0);
  const after = events
    .slice(cardIndex + 1)
    .filter((e) => e.type === "message" && e.role === "assistant");
  const last = after.at(-1);
  const text =
    last && last.type === "message" ? ((last.content as { text?: string }).text ?? "") : "";
  expect(text.length).toBeGreaterThan(0);
  return text;
}

describe("hand-off turns close with a short result and next step", () => {
  test("PROD reproduction: a sensitive draft edited, validated and proposed for saving closes with German text", async () => {
    const conversationId = await seedConversation("subkit-github-briefing", {
      sensitive: true,
      previewed: false,
    });
    getMockProvider().setConversePlan(conversationId, EDIT_THEN_SAVE);
    const outcome = await turn(conversationId, PROD_PROMPT);

    expect(outcome.result.status).toBe("awaiting_input");
    const events = outcome.result.events;
    const text = closingMessage(events);
    expect(text).not.toMatch(TOOL_NAME);
    expect(text).toContain("Testlauf");
    expect(text).toContain("nicht möglich");
    expect(text).toContain("aktiviert wird dabei nichts");

    const persisted = await assistantRows(conversationId);
    expect(persisted.at(-1)).toMatchObject({ _synthetic: true, _reason: "handoff_summary", text });

    const card = events.find((e) => e.type === "elicit_request");
    if (card?.type !== "elicit_request") throw new Error("expected a save card");
    const stored = await elicitationInput(card.elicitation_id);
    expect(
      (stored?.input as { verification?: { preview?: string } } | undefined)?.verification?.preview,
    ).toBe("unavailable_sensitive");
    expect(stored?.summary).not.toContain("save_workflow_draft");

    const criticCalls = getMockProvider().calls.filter((c) => c.flow === "critic_authoring");
    expect(criticCalls).toHaveLength(0);
  });

  test("an ordinary changed draft without a held preview is not proposed for saving", async () => {
    const conversationId = await seedConversation("ordinary-briefing", {
      sensitive: false,
      previewed: true,
    });
    getMockProvider().setConversePlan(conversationId, EDIT_THEN_SAVE);
    const outcome = await turn(conversationId, PROD_PROMPT);

    const events = outcome.result.events;
    expect(events.some((e) => e.type === "elicit_request")).toBe(false);
    const saved = toolOutput(events, "save_workflow_draft");
    expect(saved?.error_code).toBe("workflow_not_ready");
    expect(saved?.next_best_actions).toContain("dry_run_workflow");
  });

  test("a fresh green held preview is shown on the save card and in the closing text", async () => {
    const conversationId = await seedConversation("previewed-briefing", {
      sensitive: false,
      previewed: true,
    });
    getMockProvider().setConversePlan(conversationId, [
      { tool: "save_workflow_draft", args: { confirmed: false, force_commit: false } },
    ]);
    const outcome = await turn(conversationId, PROD_PROMPT);

    expect(outcome.result.status).toBe("awaiting_input");
    const text = closingMessage(outcome.result.events);
    expect(text).toContain("Testlauf ohne Wirkung war erfolgreich");
    const card = outcome.result.events.find((e) => e.type === "elicit_request");
    if (card?.type !== "elicit_request") throw new Error("expected a save card");
    const stored = await elicitationInput(card.elicitation_id);
    expect(
      (stored?.input as { verification?: { preview?: string } } | undefined)?.verification?.preview,
    ).toBe("passed");
  });

  test("an explicit 'kein Testlauf' allows the save card, says so, and the approved save persists", async () => {
    const conversationId = await seedConversation("no-test-run-briefing", {
      sensitive: false,
      previewed: false,
    });
    getMockProvider().setConversePlan(conversationId, [
      { tool: "save_workflow_draft", args: { confirmed: false, force_commit: false } },
    ]);
    const outcome = await turn(
      conversationId,
      "Speichere den Entwurf, kein Testlauf. Erkläre Ergebnis und nächsten Schritt kurz.",
    );

    expect(outcome.result.status).toBe("awaiting_input");
    const text = closingMessage(outcome.result.events);
    expect(text).toContain("wie gewünscht ausgelassen");
    const card = outcome.result.events.find((e) => e.type === "elicit_request");
    if (card?.type !== "elicit_request") throw new Error("expected a save card");
    const stored = await elicitationInput(card.elicitation_id);
    expect(
      (stored?.input as { verification?: { preview?: string } } | undefined)?.verification?.preview,
    ).toBe("skipped_by_user");

    getMockProvider().setConversePlan(conversationId, []);
    await respondElicitationForTest(
      {
        tenant_id: ctx.tenant_id,
        conversation_id: conversationId,
        elicitation_id: card.elicitation_id,
        actor_id: ctx.user_id,
        output: { confirmed: true },
      },
      ctx.testDb.db,
    );
    const saved = await ctx.testDb.db
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.slug, "no-test-run-briefing")),
      );
    expect(saved).toHaveLength(1);
  });

  test("a choice question with no assistant text still closes with a short next step", async () => {
    const conversationId = await seedConversation("choice-briefing", {
      sensitive: false,
      previewed: true,
    });
    const question = "Welches Ziel soll der Bericht verwenden?";
    getMockProvider().setConversePlan(conversationId, [
      {
        tool: "ask_user_choice",
        args: {
          question,
          options: [
            { value: "inbox", label: "Inbox" },
            { value: "mail", label: "E-Mail" },
          ],
        },
      },
    ]);
    const outcome = await turn(conversationId, PROD_PROMPT);
    expect(outcome.result.status).toBe("awaiting_input");
    const text = closingMessage(outcome.result.events);
    expect(text).not.toBe(question);
    expect(text).not.toContain("?");
  });

  test("declining the save card is logged as a rejection and the next turn does not re-propose it", async () => {
    const conversationId = await seedConversation("declined-briefing", {
      sensitive: true,
      previewed: false,
    });
    getMockProvider().setConversePlan(conversationId, EDIT_THEN_SAVE);
    const outcome = await turn(conversationId, PROD_PROMPT);
    const pendingId = outcome.result.pending_elicitation_id;
    if (!pendingId) throw new Error("expected a pending save card");

    const warnSpy = spyOn(logger, "warn");
    const infoSpy = spyOn(logger, "info");
    try {
      getMockProvider().setConversePlan(conversationId, [{ text: "Nicht gespeichert." }]);
      await respondElicitationForTest(
        {
          tenant_id: ctx.tenant_id,
          conversation_id: conversationId,
          elicitation_id: pendingId,
          actor_id: ctx.user_id,
          output: { confirmed: false },
        },
        ctx.testDb.db,
      );
      const actions = (spy: typeof warnSpy) =>
        spy.mock.calls.map((call) => (call[0] as { action?: string }).action);
      expect(actions(warnSpy)).toContain("approval.rejected");
      expect(actions(infoSpy)).not.toContain("approval.approved");
    } finally {
      warnSpy.mockRestore();
      infoSpy.mockRestore();
    }

    const saves = await ctx.testDb.db
      .select({ input: conversationToolCalls.input })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, ctx.tenant_id),
          eq(conversationToolCalls.conversation_id, conversationId),
          eq(conversationToolCalls.tool, "save_workflow_draft"),
        ),
      );
    const modelIssued = saves.filter(
      (row) => (row.input as { _harness_auto_persist?: boolean })._harness_auto_persist !== true,
    );
    expect(modelIssued).toHaveLength(1);
  });
});
