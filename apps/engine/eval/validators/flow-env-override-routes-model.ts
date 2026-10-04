import { applyFlowEnvOverrides } from "../../src/llm/core/invoke.ts";
import type { LlmFlow, ModelRoute } from "../../src/llm/types.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

interface Input {
  base_route: ModelRoute;
  env: Record<string, string>;
  target_flow: LlmFlow;
  untouched_flow: LlmFlow;
  expect: { primary_for_target: string; primary_for_untouched: string };
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const input = fixture.input as Input;
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(input.env)) saved[k] = process.env[k];
  for (const [k, v] of Object.entries(input.env)) process.env[k] = v;
  try {
    const target = applyFlowEnvOverrides(input.base_route, input.target_flow);
    const untouched = applyFlowEnvOverrides(input.base_route, input.untouched_flow);
    if (target.primary !== input.expect.primary_for_target) {
      return {
        pass: false,
        reason: `target flow primary expected ${input.expect.primary_for_target}, got ${target.primary}`,
      };
    }
    if (untouched.primary !== input.expect.primary_for_untouched) {
      return {
        pass: false,
        reason: `untouched flow primary expected ${input.expect.primary_for_untouched}, got ${untouched.primary}`,
      };
    }
    return { pass: true };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
