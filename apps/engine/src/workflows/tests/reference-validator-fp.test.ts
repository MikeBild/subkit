// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${…}` tokens are the subject under test — these are intentional placeholders.
// Regression tests for bare-path validator false positives.
//
// Pre-fix the BARE_PATH_RE flagged any dotted identifier as a candidate
// step reference: `links.self`, `example.com`, `application.json`.
// The false positives made the LLM rewrite valid transforms in
// session f00b8d1c. These cases must stay green.

import { describe, expect, test } from "bun:test";
import { validateStepReferences, validateUnsupportedPlaceholders } from "../reference-validator.ts";
import type { WorkflowDef } from "../types.ts";

function wf(steps: WorkflowDef["steps"]): WorkflowDef {
  return { name: "draft", steps };
}

describe("reference-validator · false-positive guards", () => {
  test("does not flag links.self inside a JS transform expression", () => {
    const draft = {
      name: "draft",
      steps: [
        { id: "fetch", kind: "request", method: "GET", url: "https://api.example.com/x" },
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression:
            "return input.scope.fetch.data.resources.map((r) => ({ urn: r.urn, path: r.links.self }));",
        },
      ],
    };
    expect(validateStepReferences(wf(draft.steps as WorkflowDef["steps"]))).toEqual([]);
  });

  test("does not flag domain names inside string literals", () => {
    const draft = {
      name: "draft",
      steps: [
        { id: "fetch", kind: "request", method: "GET", url: "https://api.example.com/x" },
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression:
            "return { primary: 'example.com', secondary: \"example.org\", from: input.scope.fetch.data };",
        },
      ],
    };
    expect(validateStepReferences(wf(draft.steps as WorkflowDef["steps"]))).toEqual([]);
  });

  test("does not flag content-type-shaped strings", () => {
    const draft = {
      name: "draft",
      steps: [
        { id: "fetch", kind: "request", method: "GET", url: "https://api.example.com/x" },
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression: "return { ct: 'application/json', from: input.scope.fetch.data };",
        },
      ],
    };
    expect(validateStepReferences(wf(draft.steps as WorkflowDef["steps"]))).toEqual([]);
  });

  test("does flag step-id typos (within Levenshtein 2)", () => {
    const draft = {
      name: "draft",
      steps: [
        {
          id: "fetch_projects",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/x",
        },
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression: "return fetcch_projects.data;",
        },
      ],
    };
    const errs = validateStepReferences(wf(draft.steps as WorkflowDef["steps"]));
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]?.bad_reference).toBe("fetcch_projects");
  });
});

describe("validateUnsupportedPlaceholders", () => {
  test("flags Mustache in a request step's path", () => {
    const draft = {
      name: "draft",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          path: "/v2/projects/{{ $item.id }}/resources",
        },
      ],
    };
    const errs = validateUnsupportedPlaceholders(wf(draft.steps as WorkflowDef["steps"]));
    expect(errs.length).toBe(1);
    expect(errs[0]?.code).toBe("mustache");
    expect(errs[0]?.did_you_mean).toBe("${item.id}");
  });

  test("flags ${$loop.X} in a loop body request URL", () => {
    const draft = {
      name: "draft",
      steps: [
        {
          id: "loop_a",
          kind: "loop",
          over: "$scope.fetch.data",
          body: ["body_step"],
        },
        {
          id: "body_step",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/x/${$loop.item.id}",
        },
      ],
    };
    const errs = validateUnsupportedPlaceholders(wf(draft.steps as WorkflowDef["steps"]));
    expect(errs.length).toBe(1);
    expect(errs[0]?.code).toBe("loop_alias");
  });

  test("clean draft yields empty array", () => {
    const draft = {
      name: "draft",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          path: "/v2/projects/${item.id}/resources",
        },
      ],
    };
    expect(validateUnsupportedPlaceholders(wf(draft.steps as WorkflowDef["steps"]))).toEqual([]);
  });

  test("does NOT flag JS template literals in a javascript transform", () => {
    const draft = {
      name: "draft",
      steps: [
        { id: "scrape_prices", kind: "request", method: "POST", path: "/chrome/function" },
        {
          id: "build_email",
          kind: "transform",
          language: "javascript",
          expression:
            "const rows = input.scope.scrape_prices.data.map((c) => `<tr><td>${c.from} -> ${c.to}</td><td>${c.price}</td></tr>`).join('');\nconst html = `<table>${rows}</table>`;\nreturn { html, count: input.scope.scrape_prices.data.length };",
        },
      ],
    };
    expect(validateUnsupportedPlaceholders(wf(draft.steps as WorkflowDef["steps"]))).toEqual([]);
  });

  test("transform default language (undefined) is treated as javascript and not flagged", () => {
    const draft = {
      name: "draft",
      steps: [
        { id: "fetch", kind: "request", method: "GET", url: "https://api.example.com/x" },
        {
          id: "shape",
          kind: "transform",
          expression:
            "const greeting = `hello ${input.scope.fetch.data.name}`; return { greeting };",
        },
      ],
    };
    expect(validateUnsupportedPlaceholders(wf(draft.steps as WorkflowDef["steps"]))).toEqual([]);
  });

  test("still flags ${baduser.x} in a request URL (string interpolation site)", () => {
    const draft = {
      name: "draft",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/${baduser.id}",
        },
      ],
    };
    const errs = validateUnsupportedPlaceholders(wf(draft.steps as WorkflowDef["steps"]));
    expect(errs.length).toBe(1);
    expect(errs[0]?.code).toBe("bad_kind");
  });
});
