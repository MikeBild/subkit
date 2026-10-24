import { authorWorkflowTool } from "../../src/conversations/tools/author-workflow.ts";
import { connectors } from "../../src/db/schema/index.ts";
import * as llmErrors from "../../src/llm/errors.ts";
import { getMockProvider } from "../../src/llm/mock-provider.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv, withEgressTripwire } from "./shared/authoring-env.ts";
import { type GenerationAbortInput, generationAbortError } from "./shared/generation-abort.ts";

interface Input {
  goal: string;
  connector: { slug: string; display_name: string; base_url: string; environment: "dev" | "prod" };
  abort: GenerationAbortInput;
  expect: { prompt_tool: string; max_prompts: number; generate_calls: number };
}

interface PromptEnvelope {
  requires_user_input?: boolean;
  next_best_actions?: string[];
  user_prompt?: { tool?: string; args?: { question?: string; multiline?: boolean } };
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const makeAbort = generationAbortError(llmErrors);
  if (!makeAbort) return { pass: false, reason: "awaiting structured generation abort" };
  return withAuthoringEvalEnv("question_bundle", async (env) => {
    const c = new Checks();
    await env.db.insert(connectors).values({
      tenant_id: env.tenant_id,
      slug: input.connector.slug,
      display_name: input.connector.display_name,
      driver: "http" as const,
      base_url: input.connector.base_url,
      auth_type: "none" as const,
      environment: input.connector.environment,
    });
    getMockProvider().generateOverrides.generate = () => {
      throw makeAbort(input.abort);
    };
    const toolCtx = env.makeToolCtx();
    const { result, fetch_calls } = await withEgressTripwire(() =>
      authorWorkflowTool.execute(toolCtx, {
        goal: input.goal,
        connector_slugs: [input.connector.slug],
      }),
    );
    const data = (result.data ?? {}) as PromptEnvelope;
    const prompt = data.user_prompt;
    const askTools = (data.next_best_actions ?? []).filter((tool) => tool.startsWith("ask_user_"));
    const prompts = prompt ? 1 : 0;
    c.check(!result.ok, "missing business facts were resolved without asking the user");
    c.check(data.requires_user_input === true, "requires_user_input is not true");
    c.check(prompt?.tool === input.expect.prompt_tool, `user_prompt.tool ${prompt?.tool}`);
    c.check(
      prompts <= input.expect.max_prompts && askTools.length <= input.expect.max_prompts,
      `expected at most ${input.expect.max_prompts} prompt(s), saw ${JSON.stringify(askTools)}`,
    );
    const question = prompt?.args?.question ?? "";
    for (const need of input.abort.needs) {
      const asked = typeof need.question === "string" ? need.question : "";
      c.check(question.includes(asked), `bundled prompt drops ${JSON.stringify(asked)}`);
    }
    c.check(prompt?.args?.multiline === true, "bundled prompt is not multiline");
    const generateCalls = getMockProvider().calls.filter((call) => call.flow === "generate").length;
    c.check(
      generateCalls === input.expect.generate_calls,
      `expected ${input.expect.generate_calls} generate call(s), saw ${generateCalls}`,
    );
    c.check(toolCtx.current().workflow.steps.length === 0, "a missing fact changed the draft");
    c.check(fetch_calls === 0, `egress tripwire: ${fetch_calls} live HTTP attempt(s)`);
    const metrics = { questions: input.abort.needs.length, prompts };
    if (c.failed) return { pass: false, reason: c.failed, metrics };
    return { pass: true, metrics };
  });
}
