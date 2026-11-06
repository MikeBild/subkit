import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "tools", "sdk-wrap", "invoke", "confirm.ts");

describe("policy-gate confirm summary · run_workflow", () => {
  const body = readFileSync(SRC, "utf-8");

  test("buildPolicyGateSummary closure is wired in", () => {
    expect(body).toContain("buildPolicyGateSummary");
  });

  test("run_workflow branch references the workflow name + env", () => {
    expect(body).toMatch(/inner\.name === "run_workflow"/);
    expect(body).toContain("Run workflow");
    expect(body).toMatch(/last preview/);
  });

  test("createElicitation receives policyGateSummary, not the literal generic string", () => {
    expect(body).toContain("summary: policyGateSummary");
    const hardcodeOccurrences = body.match(
      /summary: `Confirm \$\{inner\.name\} \(policy: \$\{resolvedMode\}\)`/g,
    );
    expect((hardcodeOccurrences ?? []).length).toBeLessThanOrEqual(1);
  });
});
