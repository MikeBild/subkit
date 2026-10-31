import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "sdk-wrap", "policy-helpers.ts");

describe("policy-gate commit-intent · policy-gated writes", () => {
  const body = readFileSync(SRC, "utf-8");

  test("mapToolToCommitIntentKind covers delete_connector", () => {
    expect(body).toMatch(/case "delete_connector":\s*\n?\s*return "delete_connector"/);
  });

  test("mapToolToCommitIntentKind covers delete_workflow", () => {
    expect(body).toMatch(/case "delete_workflow":\s*\n?\s*return "delete_workflow"/);
  });

  test("buildPolicyGateCommitIntent constructs a delete_connector payload with id", () => {
    expect(body).toMatch(/intentKind === "delete_connector"/);
    expect(body).toContain('description: "Permanently delete this connector."');
  });

  test("buildPolicyGateCommitIntent constructs a delete_workflow payload with id", () => {
    expect(body).toMatch(/intentKind === "delete_workflow"/);
    expect(body).toContain('description: "Permanently delete this workflow."');
  });

  test("mapToolToCommitIntentKind covers create_api_key", () => {
    expect(body).toMatch(/case "create_api_key":\s*\n?\s*return "create_api_key"/);
  });

  test("buildPolicyGateCommitIntent constructs a create_api_key payload", () => {
    expect(body).toMatch(/intentKind === "create_api_key"/);
    expect(body).toContain('description: "Create a new API key."');
  });

  test("buildPolicyGateCommitIntent constructs a run_workflow payload", () => {
    expect(body).toMatch(/intentKind === "run_workflow"/);
    expect(body).toContain('kind: "run_workflow"');
    expect(body).toContain("input_partial");
    expect(body).toContain("input_file");
    expect(body).toContain("execute_writes");
  });
});
