// Policy-gate commit-intent for delete_connector / delete_workflow.
// Pre-fix (session 975a64b0): the policy gate paused these tools
// with NO commit_intent attached. The user clicked approve,
// `maybeAutoPersistFromElicitation` found no intent, logged
// `auto_persist.skipped`, and the delete silently never executed.
// The LLM hallucinated "Connector deleted" and moved on, leaving
// the row alive — which then caused the next save_connector_draft
// for the same slug to crash with 23505 unique-violation.
//
// We assert the source-level wiring of the new commit-intent
// builders. The integration path (auto-persist dispatcher already
// has `case "delete_connector"` / `case "delete_workflow"` since
// wave-3) consumes these intents and calls the appropriate atomic
// helper.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "sdk-wrap.ts");

describe("policy-gate commit-intent · delete tools", () => {
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
});
