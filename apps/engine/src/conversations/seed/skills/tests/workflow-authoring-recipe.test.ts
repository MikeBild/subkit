// Bug KK regression: skill discipline — the workflow-authoring skill
// must encode the same root-cause-only patterns the reference impl
// uses (mandatory preflight Build Recipe, 5-failure cap, requires_repair
// gating, inspect-before-patching). Drift on any of these brings back
// the trial-and-error patch loops the contract is designed to prevent.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const workflowAuthoring = readFileSync(join(ROOT, "workflow-authoring.md"), "utf-8");
const errorRecovery = readFileSync(join(ROOT, "error-recovery.md"), "utf-8");
const dataHandling = readFileSync(join(ROOT, "data-handling.md"), "utf-8");

describe("workflow-authoring.md · Build Recipe (mandatory preflight)", () => {
  test("declares the recipe is mandatory before author_workflow / build_workflow / propose_step", () => {
    expect(workflowAuthoring).toMatch(
      /Authoring recipe \(mandatory order before `author_workflow` \/ `build_workflow` \/ `propose_step`\)/i,
    );
  });

  test("orders steps as: load_skill → list/probe → search → call_connector → author", () => {
    // The exact same six-step preflight the reference impl uses for
    // `build_tool`, adapted to subkit's tool names. We anchor on
    // canonical numbered-step markers ("1. **Load skills.**" etc.) so
    // unrelated mentions of these tool names elsewhere in the doc do
    // not confuse the order check.
    const start = workflowAuthoring.indexOf("## Authoring recipe (mandatory order before");
    expect(start).toBeGreaterThan(-1);
    const recipeBlock = workflowAuthoring.slice(start);
    const expectedAnchors = [
      "1. **Load skills.**",
      "2. **`list_connectors`.**",
      "3. **`probe_connector`.**",
      "4. **`search_docs`",
      "5. **`call_connector`.**",
      "6. **Only then** call `author_workflow`",
    ];
    let lastIdx = -1;
    for (const anchor of expectedAnchors) {
      const idx = recipeBlock.indexOf(anchor);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
    }
  });

  test("explicitly documents 'load more skills rather than fewer'", () => {
    expect(workflowAuthoring).toMatch(/load more skills rather than fewer/i);
  });
});

describe("workflow-authoring.md · 5-failure cap", () => {
  test("declares the global five-consecutive-failures rule", () => {
    expect(workflowAuthoring).toMatch(/Five consecutive failures.*ask the user/i);
    expect(workflowAuthoring).toMatch(/five failed tool calls in a row/i);
  });

  test("requires ask_user_choice with concrete options on cap", () => {
    expect(workflowAuthoring).toMatch(/ask_user_choice/);
  });

  test("documents that the counter resets on the first successful tool call", () => {
    // Trimmed phrasing to fit the converse pipeline's prompt budget.
    expect(workflowAuthoring).toMatch(/counter resets on the first\s+successful tool call/);
  });
});

describe("workflow-authoring.md · requires_repair gating (not warning count)", () => {
  test("documents the requires_repair-vs-warning-count rule", () => {
    expect(workflowAuthoring).toMatch(/Read the `requires_repair`|read `requires_repair`/i);
  });

  test("table maps each (status, requires_repair) pair to a concrete action", () => {
    expect(workflowAuthoring).toMatch(/\| `succeeded` \| `false` \|/);
    expect(workflowAuthoring).toMatch(/\| `partial_success` \| `false` \|/);
    expect(workflowAuthoring).toMatch(/\| `failed` \| \(any\) \|/);
  });

  test("explicitly forbids fix loops triggered by warnings alone", () => {
    // The doc wraps the line: `never propose a "fix" or\na "simpler version" because of warnings alone.`
    expect(workflowAuthoring).toMatch(
      /never propose a "fix" or\s+a "simpler version" because of warnings alone/i,
    );
  });
});

describe("workflow-authoring.md · inspect-before-patching", () => {
  test("recommends inspect_workflow before update_param's third call on the same field", () => {
    expect(workflowAuthoring).toMatch(/inspect_workflow/);
    // Trimmed phrasing — same intent.
    expect(workflowAuthoring).toMatch(/before the third `update_param` on the same field/i);
  });

  test("documents the inspect_workflow API shape (sections + per-step include)", () => {
    // Trimmed to the canonical signature so the doc fits the converse
    // pipeline's prompt budget — full example lives in the tool's
    // `important_notes`, not the skill body.
    expect(workflowAuthoring).toMatch(/sections:\s*\[/);
    expect(workflowAuthoring).toMatch(/steps:\s*\[\{\s*stepId,\s*include\s*\}\]/);
  });
});

describe("workflow-authoring.md · uniform envelope (no transform-vs-request split)", () => {
  test("declares every step output is uniformly enveloped", () => {
    expect(workflowAuthoring).toMatch(/EVERY step output is uniformly enveloped/i);
  });

  test("does not contradict data-handling.md by claiming transforms emit raw output", () => {
    // Pre-fix the doc said transforms' "raw return value IS the scope value".
    // The runtime wraps every step in {data, status_code, ...} via
    // engine.ts:envelopeFor. Authoring guidance has to match the runtime.
    expect(workflowAuthoring).not.toMatch(/transforms don't envelope/i);
    expect(workflowAuthoring).not.toMatch(/raw return value IS the scope value/i);
    // data-handling.md is the canonical authority for the rule.
    expect(dataHandling).toMatch(/Always.*\$scope.<step_id>\.data/);
  });

  test("loop example references $scope.extract_projects.data, not $scope.extract_projects", () => {
    // The DigitalOcean canonical example must use the enveloped path —
    // pre-fix it used the raw form, contradicting the runtime.
    expect(workflowAuthoring).toMatch(/over": "\$scope\.extract_projects\.data/);
  });
});

describe("error-recovery.md · 5-failure cap", () => {
  test("documents the same global cap, not just per-tool retries", () => {
    expect(errorRecovery).toMatch(/Five consecutive failed tool calls/i);
    expect(errorRecovery).toMatch(/`ask_user_choice` with three concrete options/i);
  });

  test("notes the counter resets on first success", () => {
    expect(errorRecovery).toMatch(/resets on the first successful tool call/);
  });
});
