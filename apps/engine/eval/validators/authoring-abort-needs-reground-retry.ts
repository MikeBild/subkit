import { runAuthoringPipeline } from "../../src/conversations/authoring-pipeline.ts";
import { authorWorkflowTool } from "../../src/conversations/tools/author-workflow.ts";
import { connectors } from "../../src/db/schema/index.ts";
import * as llmErrors from "../../src/llm/errors.ts";
import { getMockProvider } from "../../src/llm/mock-provider.ts";
import { recordSuccessShape } from "../../src/schema-versions/service.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv, withEgressTripwire } from "./shared/authoring-env.ts";
import { generationAbortError } from "./shared/generation-abort.ts";

interface Abort {
  reason: string;
  needs: Array<Record<string, unknown>>;
}

interface Input {
  goal: string;
  connector: { slug: string; display_name: string; base_url: string };
  recorded_shape: { endpoint_key: string; value: unknown };
  abort: Abort;
  unresolvable_abort: Abort;
  definition: Record<string, unknown>;
  expect: {
    evidence_heading: string;
    evidence_line: string;
    generate_calls: number;
    unresolvable_error_code: string;
    unresolvable_next_best_actions: string[];
  };
}

function generatePrompts(): string[] {
  return getMockProvider()
    .calls.filter((call) => call.flow === "generate")
    .map((call) => call.last_user);
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const makeAbort = generationAbortError(llmErrors);
  if (!makeAbort) return { pass: false, reason: "awaiting structured generation abort" };
  return withAuthoringEvalEnv("abort_reground", async (env) => {
    const c = new Checks();
    const [connector] = await env.db
      .insert(connectors)
      .values({
        tenant_id: env.tenant_id,
        slug: input.connector.slug,
        display_name: input.connector.display_name,
        driver: "http",
        base_url: input.connector.base_url,
        auth_type: "none",
      })
      .returning({ id: connectors.id });
    if (!connector) return { pass: false, reason: "connector seed failed" };
    await recordSuccessShape(
      {
        tenant_id: env.tenant_id,
        connector_id: connector.id,
        endpoint_key: input.recorded_shape.endpoint_key,
        value: input.recorded_shape.value,
      },
      env.db,
    );

    let passes = 0;
    getMockProvider().generateOverrides.generate = () => {
      passes += 1;
      if (passes === 1) throw makeAbort(input.abort);
      return input.definition;
    };
    const toolCtx = env.makeToolCtx();
    const { result, fetch_calls } = await withEgressTripwire(() =>
      runAuthoringPipeline({
        ctx: toolCtx,
        goal: input.goal,
        connector_ids: [input.connector.slug],
      }),
    );
    c.check(result.ok, `re-grounded retry did not succeed: ${result.ok ? "" : result.message}`);
    const prompts = generatePrompts();
    c.check(
      prompts.length === input.expect.generate_calls,
      `expected ${input.expect.generate_calls} generate calls, saw ${prompts.length}`,
    );
    c.check(
      !(prompts[0] ?? "").includes(input.expect.evidence_line),
      "the first pass already carried the evidence; the scenario does not test re-grounding",
    );
    c.check(
      (prompts[1] ?? "").includes(input.expect.evidence_heading),
      "the second pass prompt has no re-grounded evidence section",
    );
    c.check(
      (prompts[1] ?? "").includes(input.expect.evidence_line),
      `the second pass prompt does not carry "${input.expect.evidence_line}"`,
    );
    c.check(
      toolCtx.current().workflow.slug === input.definition.slug,
      "the successful second pass was not stashed as the draft",
    );

    getMockProvider().calls.length = 0;
    getMockProvider().generateOverrides.generate = () => {
      throw makeAbort(input.unresolvable_abort);
    };
    const failingCtx = env.makeToolCtx();
    const unresolved = await withEgressTripwire(() =>
      authorWorkflowTool.execute(failingCtx, { goal: input.goal }),
    );
    const data = (unresolved.result.data ?? {}) as {
      error_code?: string;
      needs?: Array<{ kind?: string; path?: string }>;
      next_best_actions?: string[];
    };
    c.check(!unresolved.result.ok, "an ungroundable abort was reported as success");
    c.check(
      data.error_code === input.expect.unresolvable_error_code,
      `ungroundable abort error_code ${data.error_code}`,
    );
    const wanted = input.unresolvable_abort.needs[0] ?? {};
    c.check(
      (data.needs ?? []).some((need) => need.kind === wanted.kind && need.path === wanted.path),
      `ungroundable abort does not return its needs: ${JSON.stringify(data.needs)}`,
    );
    c.check(
      JSON.stringify(data.next_best_actions) ===
        JSON.stringify(input.expect.unresolvable_next_best_actions),
      `ungroundable abort next_best_actions ${JSON.stringify(data.next_best_actions)}`,
    );
    c.check(
      generatePrompts().length === 1,
      `an ungroundable abort was retried blindly (${generatePrompts().length} generate calls)`,
    );
    c.check(
      failingCtx.current().workflow.steps.length === 0,
      "an aborted generation changed the draft",
    );

    const totalFetch = fetch_calls + unresolved.fetch_calls;
    c.check(totalFetch === 0, `egress tripwire: ${totalFetch} live HTTP attempt(s)`);
    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true, metrics: { generate_calls: prompts.length } };
  });
}
