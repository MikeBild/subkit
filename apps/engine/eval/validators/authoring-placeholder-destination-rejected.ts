import { runAuthoringPipeline } from "../../src/conversations/authoring-pipeline.ts";
import { authorWorkflowTool } from "../../src/conversations/tools/author-workflow.ts";
import { getMockProvider } from "../../src/llm/mock-provider.ts";
import { getMetrics, METRIC_NAMES } from "../../src/observability/metrics.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv, withEgressTripwire } from "./shared/authoring-env.ts";

interface Input {
  goal: string;
  placeholder_definitions: Record<string, Record<string, unknown>>;
  parameterized_definition: Record<string, unknown>;
  expect: {
    error_code: string;
    attempts: number;
    paths: Record<string, string>;
    gate_code: string;
    next_best_actions: string[];
  };
}

function gateBlocks(code: string): number {
  const series = getMetrics()
    .snapshot()
    .find((s) => s.name === METRIC_NAMES.AUTHORING_GATE_BLOCKS_TOTAL);
  const sample = series?.samples.find(
    (s) => s.labels.code === code && s.labels.tool === "author_workflow",
  );
  return sample?.value ?? 0;
}

function generateCalls(): number {
  return getMockProvider().calls.filter((call) => call.flow === "generate").length;
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  return withAuthoringEvalEnv("placeholder_destination", async (env) => {
    const c = new Checks();
    let totalFetch = 0;

    for (const [label, definition] of Object.entries(input.placeholder_definitions)) {
      getMockProvider().generateOverrides.generate = () => definition;
      const toolCtx = env.makeToolCtx();
      const blocksBefore = gateBlocks(input.expect.gate_code);
      const generateBefore = generateCalls();
      const { result, fetch_calls } = await withEgressTripwire(() =>
        runAuthoringPipeline({ ctx: toolCtx, goal: input.goal }),
      );
      totalFetch += fetch_calls;
      c.check(!result.ok, `${label}: pipeline accepted a placeholder destination`);
      if (result.ok) continue;
      c.check(
        result.error_code === input.expect.error_code,
        `${label}: error_code ${result.error_code} != ${input.expect.error_code}`,
      );
      c.check(result.requires_user_input === true, `${label}: requires_user_input is not true`);
      c.check(
        result.attempts === input.expect.attempts,
        `${label}: spent ${result.attempts} pass(es), expected ${input.expect.attempts} (no regenerate for a missing business input)`,
      );
      const paths = (result.placeholder_destinations ?? []).map((v) => v.path);
      c.check(
        paths.includes(input.expect.paths[label] ?? ""),
        `${label}: placeholder_destinations ${JSON.stringify(paths)} does not name ${input.expect.paths[label]}`,
      );
      c.check(
        result.errors.some((e) => e.path === input.expect.paths[label]),
        `${label}: errors do not carry the field path`,
      );
      c.check(
        toolCtx.current().workflow.steps.length === 0,
        `${label}: a placeholder definition was stashed as the draft`,
      );
      c.check(
        generateCalls() - generateBefore === 1,
        `${label}: expected exactly 1 generate call, saw ${generateCalls() - generateBefore}`,
      );
      c.check(
        gateBlocks(input.expect.gate_code) === blocksBefore + 1,
        `${label}: gate metric ${input.expect.gate_code} did not increment by 1`,
      );
    }

    {
      const definition = input.placeholder_definitions.body_to ?? {};
      getMockProvider().generateOverrides.generate = () => definition;
      const toolCtx = env.makeToolCtx();
      const { result, fetch_calls } = await withEgressTripwire(() =>
        authorWorkflowTool.execute(toolCtx, { goal: input.goal }),
      );
      totalFetch += fetch_calls;
      const data = result.data as {
        error_code?: string;
        requires_user_input?: boolean;
        next_best_actions?: string[];
        placeholder_destinations?: Array<{ path: string }>;
      };
      c.check(result.ok === false, "author_workflow accepted a placeholder destination");
      c.check(
        data.error_code === input.expect.error_code && data.requires_user_input === true,
        `author_workflow envelope: ${JSON.stringify({ error_code: data.error_code, requires_user_input: data.requires_user_input })}`,
      );
      c.check(
        JSON.stringify(data.next_best_actions) === JSON.stringify(input.expect.next_best_actions),
        `author_workflow next_best_actions ${JSON.stringify(data.next_best_actions)}`,
      );
      c.check(
        (data.placeholder_destinations ?? []).some((v) => v.path === input.expect.paths.body_to),
        "author_workflow envelope does not name the placeholder field",
      );
    }

    {
      getMockProvider().generateOverrides.generate = () => input.parameterized_definition;
      const toolCtx = env.makeToolCtx();
      const { result, fetch_calls } = await withEgressTripwire(() =>
        runAuthoringPipeline({ ctx: toolCtx, goal: input.goal }),
      );
      totalFetch += fetch_calls;
      c.check(
        result.ok,
        `parameterized destination was refused: ${result.ok ? "" : result.message}`,
      );
      c.check(
        toolCtx.current().workflow.slug === "droplet-report",
        "parameterized definition was not stashed as the draft",
      );
    }

    c.check(totalFetch === 0, `egress tripwire: ${totalFetch} live HTTP attempt(s)`);
    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true, metrics: { fetch_calls: totalFetch } };
  });
}
