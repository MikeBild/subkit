import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversationMessages, workflowVersions } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

const SLUG = "support-send-journey";
const TOKEN = "aB3dE5gH7jK9mN1pQ3rS5tU7vW9xY1zA3bC5dE7fG9h";
const LINK = `https://support.example/portal#access=${TOKEN}`;

let ctx: JourneyCtx;

interface TurnBody {
  status: string;
  pending_elicitation_id?: string;
}

interface Detail {
  tool_calls: Array<{
    tool: string;
    outcome: string | null;
    confirmation_state?: string | null;
    input: { _harness_auto_persist?: boolean };
    output: { data?: { input?: { parts?: unknown[] }; output?: { url?: string } } };
  }>;
}

async function newConversation(): Promise<string> {
  const res = await journeyFetch(ctx, "/v1/conversations", {
    method: "POST",
    body: JSON.stringify({ permission_mode: "ask" }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { conversation: { id: string } }).conversation.id;
}

async function send(conversationId: string, message: string): Promise<TurnBody> {
  const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}/messages`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
  expect([200, 202]).toContain(res.status);
  return (await res.json()) as TurnBody;
}

async function detail(conversationId: string): Promise<Detail> {
  const res = await journeyFetch(ctx, `/v1/conversations/${conversationId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Detail;
}

function paletteFor(start: number): string[] {
  return (getMockProvider().toolPalettes[start] ?? []).map((tool) => tool.name);
}

beforeAll(async () => {
  ctx = await createJourneyCtx("confirmed-run-reaches-the-person");
  const seeded = await seedWorkflow(ctx, {
    slug: SLUG,
    name: "Support senden",
    steps: [],
  });
  await ctx.db
    .update(workflowVersions)
    .set({
      dag: {
        name: "Support senden",
        slug: SLUG,
        tool_effect: "irreversible_write",
        input_schema: {
          type: "object",
          required: ["description", "parts", "manifest"],
          properties: {
            description: { type: "string" },
            parts: { type: "array" },
            manifest: { type: "object" },
          },
        },
        steps: [
          {
            id: "result",
            kind: "transform",
            language: "javascript",
            expression: `return { url: ${JSON.stringify(LINK)}, expires_at: "2099-01-01T00:00:00.000Z", parts: input.input.parts.length };`,
          },
        ],
      },
    })
    .where(eq(workflowVersions.id, seeded.version_id));
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 98: an ordinary request reaches a saved workflow and its result reaches the person", () => {
  test(
    "an archived workflow refuses to run",
    async () => {
      const archived = await seedWorkflow(ctx, {
        slug: "support-old-journey",
        name: "Alte Meldung",
        steps: [
          { id: "result", kind: "transform", language: "javascript", expression: "return {};" },
        ],
      });
      const patched = await journeyFetch(ctx, `/v1/workflows/${archived.id}/metadata`, {
        method: "PATCH",
        body: JSON.stringify({ lifecycle: "archived" }),
      });
      expect(patched.status).toBe(200);

      const mock = getMockProvider();
      const conversationId = await newConversation();
      mock.setConversePlan(conversationId, [
        { tool: "run_workflow", args: { workflow: "support-old-journey" } },
        { text: "Der Workflow ist archiviert." },
      ]);
      const paused = await send(conversationId, "Melde ein Problem");
      if (paused.status === "awaiting_input") {
        await journeyFetch(
          ctx,
          `/v1/conversations/${conversationId}/elicitations/${paused.pending_elicitation_id}/respond`,
          { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
        );
      }

      const refused = (await detail(conversationId)).tool_calls
        .filter((call) => call.tool === "run_workflow")
        .at(0);
      expect(refused?.outcome).not.toBe("ok");
      expect(JSON.stringify(refused?.output)).toContain("workflow_archived");
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test(
    "ordinary requests see run_workflow, authoring requests do not",
    async () => {
      const mock = getMockProvider();
      for (const message of ["Melde ein Problem", "Öffne meine Support-Seite"]) {
        const conversationId = await newConversation();
        const start = mock.toolPalettes.length;
        mock.setConversePlan(conversationId, [{ text: "Gern." }]);
        await send(conversationId, message);
        expect(paletteFor(start)).toContain("run_workflow");
      }
      const conversationId = await newConversation();
      const start = mock.toolPalettes.length;
      mock.setConversePlan(conversationId, [{ text: "Gern." }]);
      await send(conversationId, "Erstelle einen Workflow für Rechnungen");
      expect(paletteFor(start)).not.toContain("run_workflow");
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test(
    "a confirmed run keeps its input file, shows the real result and hides the link from the model",
    async () => {
      const mock = getMockProvider();
      const conversationId = await newConversation();
      mock.setConversePlan(conversationId, [
        { tool: "export_diagnostic_context", args: {} },
        { text: "Die Diagnose ist vorbereitet." },
      ]);
      const exporting = await send(conversationId, "Melde ein Problem");
      if (exporting.status === "awaiting_input") {
        const answered = await journeyFetch(
          ctx,
          `/v1/conversations/${conversationId}/elicitations/${exporting.pending_elicitation_id}/respond`,
          { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
        );
        expect([200, 202]).toContain(answered.status);
      }
      const exported = (await detail(conversationId)).tool_calls
        .filter((call) => call.tool === "export_diagnostic_context")
        .at(-1);
      expect(exported?.outcome).toBe("ok");
      const collected = (exported?.output as unknown as Record<string, unknown>) ?? {};
      const inputFile = (collected.input_file ??
        (collected.data as Record<string, unknown> | undefined)?.input_file) as {
        id: string;
        sha256: string;
      };
      expect(inputFile?.sha256).toBeTruthy();

      mock.setConversePlan(conversationId, [
        {
          tool: "run_workflow",
          args: {
            workflow: SLUG,
            input: { description: "Test" },
            input_file: inputFile,
            execute_writes: true,
            preserve_draft: true,
          },
        },
        { text: "Der Knopf steht auf der Karte." },
      ]);
      const paused = await send(conversationId, "Bitte jetzt senden");
      expect(paused.status).toBe("awaiting_input");
      expect(paused.pending_elicitation_id).toBeTruthy();

      const confirmed = await journeyFetch(
        ctx,
        `/v1/conversations/${conversationId}/elicitations/${paused.pending_elicitation_id}/respond`,
        { method: "POST", body: JSON.stringify({ output: { confirmed: true } }) },
      );
      expect([200, 202]).toContain(confirmed.status);

      const after = await detail(conversationId);
      const card = after.tool_calls.find(
        (call) => call.tool === "run_workflow" && !call.input._harness_auto_persist,
      );
      expect(card?.confirmation_state).toBe("confirmed");
      expect(card?.outcome).toBe("ok");
      expect(card?.output.data?.output?.url).toBe(LINK);
      expect(card?.output.data?.input?.parts?.length).toBeGreaterThan(0);
      const history = await ctx.db
        .select({ role: conversationMessages.role, content: conversationMessages.content })
        .from(conversationMessages)
        .where(eq(conversationMessages.conversation_id, conversationId));
      expect(history.some((row) => row.role === "tool")).toBe(true);
      expect(JSON.stringify(history)).not.toContain(TOKEN);
    },
    JOURNEY_HOOK_TIMEOUT,
  );
});
