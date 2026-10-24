import {
  EstateReplayCaseSchema,
  EstateReplayManifestSchema,
  replayEstateCase,
  replayEstateManifest,
} from "../estate-replay.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";
import { Checks } from "./shared/authoring-env.ts";

interface Input {
  manifest: unknown;
  drift_cases: Array<{ expect: "output_differs" | "side_effects_differ"; case: unknown }>;
}

export async function validate(fixture: FixtureRecord): Promise<ValidationResult> {
  const input = fixture.input as Input;
  const c = new Checks();
  const manifest = EstateReplayManifestSchema.parse(input.manifest);
  const report = await replayEstateManifest(manifest);
  for (const result of report.cases) {
    c.check(
      result.passed,
      `estate case ${result.id} (${result.workflow_slug}) drifted: ${result.error ?? JSON.stringify({ old: result.old_output, new: result.new_output })}`,
    );
  }
  const workflows = new Set(manifest.cases.map((testCase) => testCase.workflow_slug));
  c.check(workflows.size > 1, "the estate manifest covers a single workflow");

  let driftDetected = 0;
  for (const drift of input.drift_cases) {
    const result = await replayEstateCase(EstateReplayCaseSchema.parse(drift.case));
    const detected =
      !result.passed &&
      (drift.expect === "output_differs"
        ? result.output_equal === false
        : result.output_equal && result.side_effects_equal === false);
    if (detected) driftDetected += 1;
    c.check(detected, `drift case ${result.id} was not detected as ${drift.expect}`);
  }

  const metrics = {
    estate_cases: report.total,
    estate_passed: report.passed,
    estate_workflows: workflows.size,
    drift_detected: driftDetected,
  };
  if (c.failed) return { pass: false, reason: c.failed, metrics };
  return { pass: true, metrics };
}
