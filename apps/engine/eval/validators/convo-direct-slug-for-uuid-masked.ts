import { and, eq } from "drizzle-orm";
import { createEmptyDraftDocument } from "../../src/conversations/authoring-state.ts";
import {
  DIRECT_INVOKE_TOOLS,
  invokeConversationToolDirect,
} from "../../src/conversations/direct-invoke.ts";
import { getTool } from "../../src/conversations/tools/index.ts";
import { conversations, conversationToolCalls, workflows } from "../../src/db/schema/index.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv } from "./shared/authoring-env.ts";

interface Input {
  tool: string;
  slug: string;
  expect: { error_code: string; forbidden_fragments: string[] };
}

interface FailureEnvelope {
  error?: string;
  error_code?: string;
  message?: string;
  next_best_actions?: string[];
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  return withAuthoringEvalEnv("direct_slug_for_uuid", async (env) => {
    const c = new Checks();
    const tool = getTool(input.tool);
    if (!tool) return { pass: false, reason: `tool ${input.tool} is not registered` };
    c.check(DIRECT_INVOKE_TOOLS.has(input.tool), `${input.tool} is not direct-invocable`);

    const [conversation] = await env.db
      .insert(conversations)
      .values({
        tenant_id: env.tenant_id,
        status: "active",
        draft: createEmptyDraftDocument("workflow_authoring") as unknown as Record<string, unknown>,
      })
      .returning({ id: conversations.id });
    if (!conversation) return { pass: false, reason: "conversation seed failed" };

    const originalExecute = tool.execute;
    let lookupFailed = false;
    tool.execute = async (ctx) => {
      try {
        await ctx.db
          .select({ id: workflows.id })
          .from(workflows)
          .where(and(eq(workflows.tenant_id, ctx.tenant_id), eq(workflows.id, input.slug)))
          .limit(1);
      } catch (err) {
        lookupFailed = true;
        throw err;
      }
      return { ok: true, data: {} };
    };
    let outcome: Awaited<ReturnType<typeof invokeConversationToolDirect>>;
    try {
      outcome = await invokeConversationToolDirect({
        db: env.db,
        tenant_id: env.tenant_id,
        conversation_id: conversation.id,
        actor_id: null,
        tool: input.tool,
        args: {},
      });
    } finally {
      tool.execute = originalExecute;
    }

    c.check(
      lookupFailed,
      "the slug lookup did not fail in PostgreSQL; the scenario is not exercised",
    );
    c.check(!outcome.ok, "direct invocation reported ok for a failed lookup");
    const data = (outcome.data ?? {}) as FailureEnvelope;
    c.check(
      data.error_code === input.expect.error_code,
      `error_code ${data.error_code} != ${input.expect.error_code}`,
    );
    const recovery = data.next_best_actions ?? [];
    c.check(recovery.length > 0, "failure envelope names no recovery");
    c.check(
      recovery.every((name) => DIRECT_INVOKE_TOOLS.has(name)),
      `recovery ${JSON.stringify(recovery)} is not directly invocable`,
    );

    const [stored] = await env.db
      .select({ output: conversationToolCalls.output })
      .from(conversationToolCalls)
      .where(
        and(
          eq(conversationToolCalls.tenant_id, env.tenant_id),
          eq(conversationToolCalls.id, outcome.tool_call_id),
        ),
      )
      .limit(1);
    const surfaces = [
      { label: "caller", text: JSON.stringify(outcome.data ?? null) },
      { label: "persisted tool call", text: JSON.stringify(stored?.output ?? null) },
    ];
    for (const surface of surfaces) {
      for (const fragment of input.expect.forbidden_fragments) {
        c.check(
          !surface.text.toLowerCase().includes(fragment.toLowerCase()),
          `${surface.label} output leaks "${fragment}": ${surface.text.slice(0, 200)}`,
        );
      }
    }
    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true };
  });
}
