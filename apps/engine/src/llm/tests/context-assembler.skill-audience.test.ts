import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createSkill } from "../../skills/service.ts";
import { assembleEnhancedPrompt, promptSkillAudience } from "../runtime/context-assembler.ts";
import type { AuthoringPromptHint } from "../types.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

const skip = process.env.REQUIRES_PG === "0";

let ctx: LlmTestCtx;
let chatOnly = "";
let draftingOnly = "";

const workflowHint: AuthoringPromptHint = {
  mode: "workflow",
  stage: "idle",
  lifecycle_state: "draft_only",
  active_target: { kind: "workflow", lifecycle_state: "draft_only" },
  blocked_by: [],
  next_required_action: null,
  next_suggested_tool: null,
  checkpoints: [],
  latest_execution: null,
  latest_diagnosis: null,
};

beforeAll(async () => {
  if (skip) return;
  ctx = await createLlmTestCtx("skill_audience");
  const make = async (title: string, applies_to: "chat" | "authoring") =>
    (
      await createSkill(
        {
          tenant_id: ctx.tenant_id,
          actor_id: null,
          input: { scope: "global", title, body: `${title} guidance.`, applies_to },
        },
        ctx.testDb.db,
      )
    ).id;
  chatOnly = await make("chat-only-skill", "chat");
  draftingOnly = await make("drafting-only-skill", "authoring");
}, 60_000);

afterAll(async () => {
  if (!skip && ctx?.cleanup) await ctx.cleanup();
}, 30_000);

describe("promptSkillAudience", () => {
  test("drafting flows and a workflow-mode converse turn are authoring", () => {
    expect(promptSkillAudience("generate", undefined)).toBe("authoring");
    expect(promptSkillAudience("repair", undefined)).toBe("authoring");
    expect(promptSkillAudience("converse", "workflow")).toBe("authoring");
    expect(promptSkillAudience("converse", "execution")).toBe("chat");
    expect(promptSkillAudience("converse", undefined)).toBe("chat");
  });
});

describe.skipIf(skip)("context-assembler honours applies_to", () => {
  const base = {
    user_turns: [{ role: "user" as const, content: "hello" }],
    max_tokens: 60000,
    model: "claude-sonnet-4-6",
  };

  test("a chat turn carries the chat skill, not the drafting skill", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        ...base,
        tenant_id: ctx.tenant_id,
        flow: "converse",
        loaded_skill_slugs: [chatOnly, draftingOnly],
      },
      ctx.testDb.db,
    );
    expect(prompt.included_skill_ids).toContain(chatOnly);
    expect(prompt.included_skill_ids).not.toContain(draftingOnly);
  });

  test("a drafting turn carries the drafting skill, not the chat skill", async () => {
    const prompt = await assembleEnhancedPrompt(
      {
        ...base,
        tenant_id: ctx.tenant_id,
        flow: "converse",
        authoring_hint: workflowHint,
        loaded_skill_slugs: [chatOnly, draftingOnly],
      },
      ctx.testDb.db,
    );
    expect(prompt.included_skill_ids).toContain(draftingOnly);
    expect(prompt.included_skill_ids).not.toContain(chatOnly);
  });

  test("the one-shot generate flow is drafting", async () => {
    const prompt = await assembleEnhancedPrompt(
      { ...base, tenant_id: ctx.tenant_id, flow: "generate" },
      ctx.testDb.db,
    );
    expect(prompt.included_skill_ids).toContain(draftingOnly);
    expect(prompt.included_skill_ids).not.toContain(chatOnly);
  });
});
