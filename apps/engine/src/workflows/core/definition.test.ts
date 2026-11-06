import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { buildStepDag, topoSort } from "../dag.ts";
import type { WorkflowDef } from "../types.ts";
import { validateWorkflowDef } from "../validator.ts";
import {
  cycleIssues,
  isValidSlug,
  SLUG_MAX_LENGTH,
  slugify,
  toStoredDefinition,
  workflowSlug,
} from "./definition.ts";

const FC = { seed: 20261106, numRuns: 200 } as const;

const transform = (id: string, from: string | null) => ({
  id,
  kind: "transform" as const,
  language: "javascript" as const,
  expression: from ? `return input.scope.${from}.data;` : "return 1;",
});

const acyclic = {
  name: "acyclic",
  steps: [transform("a", null), transform("b", "a")],
} as unknown as WorkflowDef;

const cyclic = {
  name: "cyclic",
  steps: [transform("a", "b"), transform("b", "a")],
} as unknown as WorkflowDef;

describe("slug rule", () => {
  test("slugify lowercases and joins words with hyphens", () => {
    expect(slugify("  Weekly Report: Board!  ")).toBe("weekly-report-board");
    expect(slugify("!!!")).toBe("");
    expect(slugify("--Weekly -- Report--")).toBe("weekly-report");
    expect(slugify("x".repeat(80))).toHaveLength(SLUG_MAX_LENGTH);
  });

  test("workflowSlug falls back to the given suffix", () => {
    expect(workflowSlug("Daily Digest", "abcd1234")).toBe("daily-digest");
    expect(workflowSlug("???", "abcd1234")).toBe("wf-abcd1234");
  });

  test("isValidSlug accepts lowercase alphanumerics with hyphens", () => {
    expect(isValidSlug("daily-digest")).toBe(true);
    expect(isValidSlug("-daily")).toBe(false);
    expect(isValidSlug("Daily")).toBe(false);
    expect(isValidSlug("daily Digest")).toBe(false);
    expect(isValidSlug("daily!")).toBe(false);
  });

  test("every workflowSlug is a valid slug", () => {
    fc.assert(
      fc.property(fc.string(), fc.stringMatching(/^[a-f0-9]{8}$/), (text, suffix) => {
        expect(isValidSlug(workflowSlug(text, suffix))).toBe(true);
      }),
      FC,
    );
  });

  test("slugify is idempotent", () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(slugify(slugify(text))).toBe(slugify(text));
      }),
      FC,
    );
  });
});

describe("cycle check", () => {
  test("an acyclic definition has no cycle issue", () => {
    expect(cycleIssues(acyclic)).toEqual([]);
  });

  test("a step that mentions its own id is not a cycle, as the engine ignores self edges", () => {
    const def = {
      name: "self",
      steps: [
        { id: "orders", kind: "request", method: "GET", url: "https://orders.example.test/x" },
      ],
    } as unknown as WorkflowDef;
    expect(cycleIssues(def)).toEqual([]);
    expect(validateWorkflowDef(def).ok).toBe(true);
  });

  test("a cyclic definition names the cycle", () => {
    const issues = cycleIssues(cyclic);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.rule_id).toBe("workflow_cycle_detected");
    expect(issues[0]?.path).toBe("steps");
    expect(issues[0]?.message).toContain(
      "workflow has a cyclic step dependency: cycles: a → b → a",
    );
  });

  test("validateWorkflowDef refuses a cyclic definition", () => {
    const result = validateWorkflowDef(cyclic);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.rule_id === "workflow_cycle_detected")).toBe(true);
    expect(validateWorkflowDef(acyclic).errors.some((e) => e.rule_id)).toBe(false);
  });

  test("a chain that only points backwards never has a cycle", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (length) => {
        const steps = Array.from({ length }, (_, i) =>
          transform(`s${i}`, i === 0 ? null : `s${i - 1}`),
        );
        expect(cycleIssues({ name: "chain", steps } as unknown as WorkflowDef)).toEqual([]);
      }),
      FC,
    );
  });
});

describe("cycle check matches the engine order", () => {
  test("a definition passes exactly when topoSort can order it", () => {
    fc.assert(
      fc.property(
        fc.array(fc.option(fc.nat({ max: 5 }), { nil: null }), { minLength: 1, maxLength: 6 }),
        (refs) => {
          const steps = refs.map((ref, i) =>
            transform(`s${i}`, ref === null || ref >= refs.length ? null : `s${ref}`),
          );
          const def = { name: "random", steps } as unknown as WorkflowDef;
          let sortable = true;
          try {
            topoSort(buildStepDag(def));
          } catch {
            sortable = false;
          }
          expect(cycleIssues(def).length === 0).toBe(sortable);
        },
      ),
      FC,
    );
  });
});

describe("stored form", () => {
  test("a version leaves the description to the catalog column", () => {
    expect(
      toStoredDefinition({ ...acyclic, description: "Board report" }, "version") as unknown,
    ).toEqual(acyclic);
  });

  test("a draft keeps its description until activation", () => {
    const def = { ...acyclic, description: "Board report" };
    expect(toStoredDefinition(def, "draft")).toBe(def);
  });

  test("the version form is idempotent and never carries a description", () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (description) => {
        const def = description === undefined ? acyclic : { ...acyclic, description };
        const stored = toStoredDefinition(def, "version");
        expect("description" in stored).toBe(false);
        expect(toStoredDefinition(stored, "version")).toEqual(stored);
      }),
      FC,
    );
  });
});
