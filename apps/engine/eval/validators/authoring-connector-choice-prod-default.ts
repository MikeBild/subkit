import { authorWorkflowTool } from "../../src/conversations/tools/author-workflow.ts";
import { connectors } from "../../src/db/schema/index.ts";
import * as llmErrors from "../../src/llm/errors.ts";
import { getMockProvider } from "../../src/llm/mock-provider.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv, withEgressTripwire } from "./shared/authoring-env.ts";
import { type GenerationAbortInput, generationAbortError } from "./shared/generation-abort.ts";

interface Input {
  goal: string;
  connectors: Array<{
    slug: string;
    display_name: string;
    base_url: string;
    environment: "dev" | "prod";
  }>;
  abort: GenerationAbortInput;
  expect: { prompt_tool: string; default: string; options: string[]; generate_calls: number };
}

interface ChoiceEnvelope {
  requires_user_input?: boolean;
  next_best_actions?: string[];
  user_prompt?: {
    tool?: string;
    args?: { question?: string; default?: string; options?: Array<{ value?: string }> };
  };
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const makeAbort = generationAbortError(llmErrors);
  if (!makeAbort) return { pass: false, reason: "awaiting structured generation abort" };
  return withAuthoringEvalEnv("connector_choice", async (env) => {
    const c = new Checks();
    await env.db.insert(connectors).values(
      input.connectors.map((connector) => ({
        tenant_id: env.tenant_id,
        slug: connector.slug,
        display_name: connector.display_name,
        driver: "http" as const,
        base_url: connector.base_url,
        auth_type: "none" as const,
        environment: connector.environment,
      })),
    );
    getMockProvider().generateOverrides.generate = () => {
      throw makeAbort(input.abort);
    };
    const toolCtx = env.makeToolCtx();
    const { result, fetch_calls } = await withEgressTripwire(() =>
      authorWorkflowTool.execute(toolCtx, {
        goal: input.goal,
        connector_slugs: input.connectors.map((connector) => connector.slug),
      }),
    );
    const data = (result.data ?? {}) as ChoiceEnvelope;
    const prompt = data.user_prompt;
    c.check(!result.ok, "a connector choice was resolved without asking the user");
    c.check(data.requires_user_input === true, "requires_user_input is not true");
    c.check(
      data.next_best_actions?.[0] === input.expect.prompt_tool,
      `next_best_actions ${JSON.stringify(data.next_best_actions)} does not start with ${input.expect.prompt_tool}`,
    );
    c.check(prompt?.tool === input.expect.prompt_tool, `user_prompt.tool ${prompt?.tool}`);
    c.check(
      prompt?.args?.question === input.abort.needs[0]?.question,
      `user_prompt question ${JSON.stringify(prompt?.args?.question)}`,
    );
    c.check(
      prompt?.args?.default === input.expect.default,
      `default ${prompt?.args?.default} != prod connector ${input.expect.default}`,
    );
    const options = (prompt?.args?.options ?? []).map((option) => option.value ?? "").sort();
    c.check(
      JSON.stringify(options) === JSON.stringify([...input.expect.options].sort()),
      `options ${JSON.stringify(options)} != ${JSON.stringify(input.expect.options)}`,
    );
    const generateCalls = getMockProvider().calls.filter((call) => call.flow === "generate").length;
    c.check(
      generateCalls === input.expect.generate_calls,
      `expected ${input.expect.generate_calls} generate call(s), saw ${generateCalls}`,
    );
    c.check(toolCtx.current().workflow.steps.length === 0, "a connector choice changed the draft");
    c.check(fetch_calls === 0, `egress tripwire: ${fetch_calls} live HTTP attempt(s)`);
    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true };
  });
}
