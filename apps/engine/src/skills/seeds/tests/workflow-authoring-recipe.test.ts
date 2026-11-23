import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { autoloadForToolCall, autoloadForUserTurn } from "../../../conversations/skill-autoload.ts";
import { loadSkillSeedsFromContent } from "../../../skills/seed.ts";

const ROOT = join(import.meta.dir, "..");
const workflowAuthoring = readFileSync(join(ROOT, "workflow-authoring.md"), "utf-8");
const authoringFamily = readdirSync(ROOT)
  .filter((file) => file.startsWith("workflow-authoring"))
  .map((file) => readFileSync(join(ROOT, file), "utf-8"))
  .join("\n");
const errorRecovery = readFileSync(join(ROOT, "error-recovery.md"), "utf-8");
const dataHandling = readFileSync(join(ROOT, "data-handling.md"), "utf-8");
const conversationalAuthoring = readFileSync(
  join(import.meta.dir, "../../../conversations/agent/skills/content/conversational-authoring.md"),
  "utf-8",
);

describe("conversational-authoring.md · ask-first for destinations (step 4)", () => {
  test("step 4 asks for a missing destination before author_workflow and names the engine gate", () => {
    const step4 = conversationalAuthoring
      .split("\n")
      .find((line) => line.startsWith("4. Build the workflow second."));
    expect(step4).toBeDefined();
    expect(step4).toContain(
      "ask for it with one `ask_user_text`/`ask_user_form` BEFORE `author_workflow`",
    );
    expect(step4).toContain("the engine rejects placeholder destinations");
    expect(step4).toContain("`requires_user_input: true`");
  });
});

describe("workflow-authoring.md · Build Recipe (mandatory preflight)", () => {
  test("declares the recipe is mandatory before author_workflow / edit_workflow_patch", () => {
    expect(workflowAuthoring).toMatch(
      /Authoring recipe \(mandatory order before `author_workflow` \/ `edit_workflow_patch`\)/i,
    );
  });

  test("orders steps as: load_skill → list_connectors → probe → call_connector → search → author", () => {
    const start = workflowAuthoring.indexOf("## Authoring recipe (mandatory order before");
    expect(start).toBeGreaterThan(-1);
    const recipeBlock = workflowAuthoring.slice(start);
    const expectedAnchors = [
      "1. **Load skills.**",
      "2. **`list_connectors`.**",
      "3. **`probe_connector` (MANDATORY",
      "4. **`call_connector` (probe supplement).**",
      "5. **`search_docs` and `search_knowledge`.**",
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
    expect(workflowAuthoring).toMatch(
      /never propose a "fix" or\s+a "simpler version" because of warnings alone/i,
    );
  });
});

describe("workflow-authoring.md · inspect-before-patching", () => {
  test("recommends inspect_workflow before edit_workflow_patch's third call on the same field", () => {
    expect(workflowAuthoring).toMatch(/inspect_workflow/);
    expect(workflowAuthoring).toMatch(/before the third `edit_workflow_patch` on the same field/i);
  });

  test("documents the inspect_workflow API shape (sections + per-step include)", () => {
    expect(workflowAuthoring).toMatch(/sections:\s*\[/);
    expect(workflowAuthoring).toMatch(/steps:\s*\[\{\s*stepId,\s*include\s*\}\]/);
  });
});

describe("workflow-authoring.md · uniform envelope (no transform-vs-request split)", () => {
  test("declares every step output is uniformly enveloped", () => {
    expect(authoringFamily).toMatch(/EVERY step output is uniformly enveloped/i);
  });

  test("does not contradict data-handling.md by claiming transforms emit raw output", () => {
    expect(authoringFamily).not.toMatch(/transforms don't envelope/i);
    expect(authoringFamily).not.toMatch(/raw return value IS the scope value/i);
    expect(dataHandling).toMatch(/Always.*\$scope.<step_id>\.data/);
  });

  test("for_each example reads sourceData.extract_projects.data, not the envelope", () => {
    expect(authoringFamily).toMatch(
      /"for_each": "\(sourceData\) => sourceData\.extract_projects\.data"/,
    );
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

test("explicit workflow-authoring phrasing loads the recipe; a knowledge approval does not", () => {
  const parsed = loadSkillSeedsFromContent([
    { file: "workflow-authoring.md", content: workflowAuthoring },
  ]);
  expect(parsed.errors).toEqual([]);
  const skill = parsed.skills[0];
  if (!skill) throw new Error("missing shipped skill");
  const catalog = [skill];
  for (const user_text of [
    "Erstelle einen neuen Workflow für den Tagesbericht",
    "Bitte automatisch laufen lassen",
    "Prepare automatic operation",
    "Create workflow for the weekly digest",
  ]) {
    expect(
      autoloadForUserTurn({ user_text, first_turn: false, surface: "cockpit" }, catalog, []),
    ).toContain("workflow-authoring");
  }
  for (const user_text of [
    "Bereite die Freigabe der Übernahme vor",
    "Ich bestätige die Freigabe als Wissen",
  ]) {
    expect(
      autoloadForUserTurn({ user_text, first_turn: false, surface: "cockpit" }, catalog, []),
    ).not.toContain("workflow-authoring");
  }
  for (const tool of [
    "inspect_workflow",
    "list_schedules",
    "review_workflow_automation",
    "run_workflow",
  ]) {
    expect(autoloadForToolCall({ tool, input: {} }, catalog, [])).toContain("workflow-authoring");
  }
});
