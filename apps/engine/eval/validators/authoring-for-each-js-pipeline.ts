// Authoring eval (CI mode): for_each per-step inline iteration + JS-first
// transforms.
//
// Verifies:
//   1. A step with `for_each` iterates over the selector result, binding
//      $item + $loop_index, and produces an array of per-iteration envelopes
//      at $scope.<step>.data.
//   2. A downstream JS transform projects across the iteration array via
//      .map(iter => iter.<step_id>.data.<field>).
//   3. No `loop` kind step is used — for_each on baseStep is the pattern.
//   4. All transforms use `language: "javascript"` (JS-first contract).
//   5. Zero egress — no live HTTP calls.

import { runExecution } from "../../src/execution/engine.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks, withAuthoringEvalEnv, withEgressTripwire } from "./shared/authoring-env.ts";

interface Input {
  workflow_input: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  expect: {
    list_items_status: string;
    tag_item_is_array: boolean;
    tag_item_length: number;
    collect_length: number;
    no_loop_kind: boolean;
    all_transforms_javascript: boolean;
  };
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  return withAuthoringEvalEnv("for_each_js", async (env) => {
    const c = new Checks();

    // Structural contract: no loop kind used, all transforms are JS.
    if (input.expect.no_loop_kind) {
      const loopSteps = input.steps.filter((s) => s.kind === "loop");
      c.check(loopSteps.length === 0, `expected no loop kind steps, found ${loopSteps.length}`);
    }
    if (input.expect.all_transforms_javascript) {
      const transforms = input.steps.filter((s) => s.kind === "transform");
      for (const t of transforms) {
        c.check(
          t.language === "javascript",
          `transform step "${String(t.id)}" has language "${String(t.language)}", expected "javascript"`,
        );
      }
    }

    if (c.failed) return { pass: false, reason: c.failed };

    // Runtime contract: for_each step produces an array envelope.
    const { result: run, fetch_calls } = await withEgressTripwire(() =>
      runExecution({
        db: env.db,
        tenant_id: env.tenant_id,
        source: {
          kind: "draft",
          definition: {
            name: "eval-for-each-js",
            slug: "eval-for-each-js",
            steps: input.steps,
          },
        },
        input: input.workflow_input,
        options: {},
      }),
    );

    c.check(
      fetch_calls === 0,
      `egress tripwire: ${fetch_calls} live HTTP attempt(s) during execution`,
    );
    c.check(
      run.status === "succeeded",
      `execution status is ${run.status}, expected succeeded. error: ${JSON.stringify(run.error ?? null)}`,
    );

    if (c.failed) return { pass: false, reason: c.failed };

    // list_items step.
    const listStep = run.steps.find((s) => s.step_key === "list_items");
    c.check(
      listStep?.status === input.expect.list_items_status,
      `list_items status is ${String(listStep?.status)}, expected ${input.expect.list_items_status}`,
    );

    // tag_item step: should have iterated and produced an array.
    const tagStep = run.steps.find((s) => s.step_key === "tag_item");
    c.check(tagStep !== undefined, "tag_item step not found in run output");
    if (tagStep) {
      c.check(
        tagStep.status === "succeeded",
        `tag_item status is ${tagStep.status}, expected succeeded`,
      );
      const tagData = tagStep.output_preview as unknown;
      c.check(
        Array.isArray(tagData),
        `tag_item output_preview should be array (for_each result); got ${typeof tagData}`,
      );
      if (Array.isArray(tagData) && input.expect.tag_item_is_array) {
        c.check(
          tagData.length === input.expect.tag_item_length,
          `tag_item iteration count is ${tagData.length}, expected ${input.expect.tag_item_length}`,
        );
      }
    }

    // collect step: projects across iterations.
    const collectStep = run.steps.find((s) => s.step_key === "collect");
    c.check(collectStep !== undefined, "collect step not found in run output");
    if (collectStep) {
      c.check(
        collectStep.status === "succeeded",
        `collect status is ${collectStep.status}, expected succeeded`,
      );
      const collectData = collectStep.output_preview as unknown;
      c.check(
        Array.isArray(collectData),
        `collect output should be array; got ${typeof collectData}`,
      );
      if (Array.isArray(collectData)) {
        c.check(
          collectData.length === input.expect.collect_length,
          `collect length is ${collectData.length}, expected ${input.expect.collect_length}`,
        );
      }
    }

    if (c.failed) return { pass: false, reason: c.failed };
    return { pass: true, metrics: { fetch_calls, iteration_count: input.expect.tag_item_length } };
  });
}
