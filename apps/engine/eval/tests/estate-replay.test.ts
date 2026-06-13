import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EstateReplayManifestSchema,
  replayEstateCase,
  replayEstateManifest,
} from "../estate-replay.ts";

describe("estate migration replay verifier", () => {
  test("replays the example manifest successfully", async () => {
    const manifestPath = join(
      process.cwd(),
      "apps/engine/eval/manifests/estate-migration-manifest.example.json",
    );
    const manifest = EstateReplayManifestSchema.parse(
      JSON.parse(readFileSync(manifestPath, "utf8")),
    );
    const report = await replayEstateManifest(manifest);
    expect(report.failed).toBe(0);
    expect(report.passed).toBe(report.total);
    expect(report.cases.every((result) => result.output_equal)).toBe(true);
  });

  test("fails when JavaScript output differs from the JSONata output", async () => {
    const result = await replayEstateCase({
      id: "mismatch",
      kind: "step_transform",
      old_jsonata: {
        expression: '{ "n": $scope.a.data.n }',
        data: { a: { data: { n: 1 } } },
        bindings: { scope: { a: { data: { n: 1 } } } },
      },
      new_javascript: {
        code: "return { n: input.scope.a.data.n + 1 };",
        input: { scope: { a: { data: { n: 1 } } } },
      },
    });
    expect(result.passed).toBe(false);
    expect(result.output_equal).toBe(false);
  });

  test("fails side-effecting cases when held requests differ", async () => {
    const result = await replayEstateCase({
      id: "held-request-mismatch",
      kind: "output_transform",
      old_jsonata: { expression: '{ "ok": true }', data: {} },
      new_javascript: { code: "return { ok: true };", input: {} },
      side_effects: {
        old_held_requests: [{ method: "POST", body: { raw: "a" } }],
        new_held_requests: [{ method: "POST", body: { raw: "b" } }],
      },
    });
    expect(result.output_equal).toBe(true);
    expect(result.side_effects_equal).toBe(false);
    expect(result.passed).toBe(false);
  });
});
