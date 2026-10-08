import { dryRunWorkflowTool } from "../../src/conversations/tools/dry-run-workflow.ts";
import type { DraftDocument } from "../../src/conversations/types.ts";
import { getMockProvider } from "../../src/llm/mock-provider.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv, withEgressTripwire } from "./shared/authoring-env.ts";

interface Input {
  rows: unknown[];
  correct_body: string;
  broken_body: string;
  expect: {
    final_output: unknown;
    auto_repair_site: string;
    repair_prompt_must_contain: string[];
  };
}

interface Envelope {
  final_output?: unknown;
  auto_repair?: { site: string; before: string; after: string };
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  return withAuthoringEvalEnv("output_fn", async (env) => {
    const c = new Checks();
    const draft = (slug: string, body: string): DraftDocument =>
      ({
        workflow: {
          name: slug,
          slug,
          steps: [
            {
              id: "make_rows",
              kind: "transform",
              language: "javascript",
              expression: `return ${JSON.stringify(input.rows)};`,
            },
          ],
          output_transform_function: body,
        },
      }) as unknown as DraftDocument;

    const correctCtx = env.makeToolCtx(draft("eval-output-fn-correct", input.correct_body));
    const { result: correct, fetch_calls: correctFetch } = await withEgressTripwire(() =>
      dryRunWorkflowTool.execute(correctCtx, { input: null }),
    );
    c.check(correctFetch === 0, `egress tripwire: ${correctFetch} live HTTP attempt(s)`);
    c.check(correct.ok === true, "correct body preview did not come back green");
    const correctData = correct.data as Envelope;
    c.check(
      JSON.stringify(correctData.final_output) === JSON.stringify(input.expect.final_output),
      `correct body final_output is ${JSON.stringify(correctData.final_output)}`,
    );
    c.check(correctData.auto_repair === undefined, "a correct body must not be auto-repaired");
    c.check(
      getMockProvider().calls.filter((call) => call.flow === "repair").length === 0,
      "a green preview must not call the repair model",
    );

    getMockProvider().generateOverrides.repair = () => ({ expression: input.correct_body });
    const brokenCtx = env.makeToolCtx(draft("eval-output-fn-broken", input.broken_body));
    const { result: repaired, fetch_calls: brokenFetch } = await withEgressTripwire(() =>
      dryRunWorkflowTool.execute(brokenCtx, { input: null }),
    );
    c.check(brokenFetch === 0, `egress tripwire: ${brokenFetch} live HTTP attempt(s)`);
    c.check(
      repaired.ok === true,
      `broken body was not repaired in-preview: ${repaired.message ?? ""}`,
    );
    const repairedData = repaired.data as Envelope;
    c.check(
      repairedData.auto_repair?.site === input.expect.auto_repair_site &&
        repairedData.auto_repair.before === input.broken_body &&
        repairedData.auto_repair.after === input.correct_body,
      `auto_repair envelope differs: ${JSON.stringify(repairedData.auto_repair)}`,
    );
    c.check(
      JSON.stringify(repairedData.final_output) === JSON.stringify(input.expect.final_output),
      `repaired final_output is ${JSON.stringify(repairedData.final_output)}`,
    );
    c.check(
      brokenCtx.current().workflow.output_transform_function === input.correct_body,
      "the draft does not carry the repaired body",
    );
    const repairPrompt =
      getMockProvider().calls.find((call) => call.flow === "repair")?.last_user ?? "";
    for (const needle of input.expect.repair_prompt_must_contain) {
      c.check(repairPrompt.includes(needle), `repair prompt is missing: ${JSON.stringify(needle)}`);
    }

    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true, metrics: { fetch_calls: correctFetch + brokenFetch } };
  });
}
