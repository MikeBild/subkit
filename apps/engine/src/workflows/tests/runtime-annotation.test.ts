import { describe, expect, test } from "bun:test";

import { STDLIB_VERSION } from "../../sandboxes/quickjs/stdlib/index.ts";
import { annotateRuntime, workflowUsesSandboxedJs } from "../runtime-annotation.ts";
import type { WorkflowDef } from "../types.ts";

function defWithJs(language: "javascript" | "html-to-markdown" | undefined): WorkflowDef {
  return {
    name: "x",
    steps: [
      {
        kind: "transform",
        id: "t",
        expression: "return input;",
        ...(language ? { language } : {}),
      },
    ],
  } as WorkflowDef;
}

describe("workflowUsesSandboxedJs", () => {
  test("detects language: javascript transforms", () => {
    expect(workflowUsesSandboxedJs(defWithJs("javascript"))).toBe(true);
  });

  test("only the explicit `javascript` language counts as sandboxed JS", () => {
    // `workflowUsesSandboxedJs` keys on `language === "javascript"`.
    // A web-scraper language (own driver, no QuickJS body) and an
    // unlabelled transform both return false here.
    expect(workflowUsesSandboxedJs(defWithJs("html-to-markdown"))).toBe(false);
    expect(workflowUsesSandboxedJs(defWithJs(undefined))).toBe(false);
  });

  test("no transform steps → false", () => {
    const def: WorkflowDef = {
      name: "x",
      steps: [{ kind: "request", id: "r", method: "GET", url: "https://x" }],
    } as WorkflowDef;
    expect(workflowUsesSandboxedJs(def)).toBe(false);
  });
});

describe("annotateRuntime", () => {
  test("stamps STDLIB_VERSION on JS workflows", () => {
    const out = annotateRuntime(defWithJs("javascript"));
    expect(out.runtime?.stdlib_version).toBe(STDLIB_VERSION);
  });

  test("leaves non-JS workflows unchanged", () => {
    const input = defWithJs("html-to-markdown");
    const out = annotateRuntime(input);
    expect(out.runtime).toBeUndefined();
    expect(out).toBe(input);
  });

  test("preserves existing runtime fields", () => {
    const input: WorkflowDef = {
      ...defWithJs("javascript"),
      runtime: { stdlib_version: "0.1.0" },
    };
    const out = annotateRuntime(input);
    // Re-stamps to the current version (the act of committing is the
    // new baseline).
    expect(out.runtime?.stdlib_version).toBe(STDLIB_VERSION);
  });
});
