// G4 in the runtime-logs review plan: catch the JSONata-vs-JavaScript
// mis-tag at schema-validation time instead of at JSONata-parse time.
// Pre-fix the LLM wrote a JS body into an expression still tagged
// `language: "jsonata"` and burned a Sonnet repair on the runtime
// `JSONata error: Syntax error: "files"`. The schema now rejects
// early with a structured `language_mismatch` issue carrying the
// suggested language so the LLM corrects without retrying.

import { describe, expect, test } from "bun:test";
import { TransformStepSchema } from "../types.ts";

describe("TransformStepSchema — language ↔ body mismatch (G4)", () => {
  test("JavaScript body tagged language=jsonata is rejected with suggested_language=javascript", () => {
    const result = TransformStepSchema.safeParse({
      kind: "transform",
      id: "shape",
      language: "jsonata",
      expression: `const files = scope.list_files.data.files || [];
const grouped = {};
files.forEach(file => {
  const type = file.mimeType || 'Unknown';
  if (!grouped[type]) grouped[type] = [];
  grouped[type].push(file);
});
return Object.keys(grouped).map(type => ({ type, count: grouped[type].length }));`,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find(
      (i) =>
        i.path.join(".") === "expression" &&
        typeof i.message === "string" &&
        i.message.includes("looks like JavaScript"),
    );
    expect(issue).toBeDefined();
    expect(
      (issue as { params?: { error_code?: string; suggested_language?: string } } | undefined)
        ?.params,
    ).toEqual({ error_code: "language_mismatch", suggested_language: "javascript" });
  });

  test("missing language treated as jsonata still trips the JS-body heuristic", () => {
    // Pre-fix runtime defaulted missing language to jsonata silently;
    // the heuristic must fire on the implicit default too, otherwise
    // the LLM can omit `language` and dodge the validation.
    const result = TransformStepSchema.safeParse({
      kind: "transform",
      id: "shape",
      expression: "const x = 1; return x;",
    });
    expect(result.success).toBe(false);
  });

  test("JSONata body tagged language=javascript is rejected with suggested_language=jsonata", () => {
    const result = TransformStepSchema.safeParse({
      kind: "transform",
      id: "shape",
      language: "javascript",
      expression: "$scope.list_files.data.files ~> $map(function($f) { $f.mimeType })",
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find(
      (i) =>
        i.path.join(".") === "expression" &&
        typeof i.message === "string" &&
        i.message.includes("JSONata pipes"),
    );
    expect(issue).toBeDefined();
    expect(
      (issue as { params?: { error_code?: string; suggested_language?: string } } | undefined)
        ?.params,
    ).toEqual({ error_code: "language_mismatch", suggested_language: "jsonata" });
  });

  test("plain JSONata body with language=jsonata is accepted", () => {
    const result = TransformStepSchema.safeParse({
      kind: "transform",
      id: "shape",
      language: "jsonata",
      expression: '{ "name": $scope.fetch_user.data.name, "email": $scope.fetch_user.data.email }',
    });
    expect(result.success).toBe(true);
  });

  test("plain JS body with language=javascript is accepted", () => {
    const result = TransformStepSchema.safeParse({
      kind: "transform",
      id: "shape",
      language: "javascript",
      expression: "const out = { a: 1 }; return out;",
    });
    expect(result.success).toBe(true);
  });

  test("JSONata body that mentions 'const' inside a string literal is not flagged", () => {
    // String-stripping must protect against false positives where the
    // JS-marker keyword appears inside prose / quoted text.
    const result = TransformStepSchema.safeParse({
      kind: "transform",
      id: "shape",
      language: "jsonata",
      expression: '$scope.docs[type = "const-handler"]',
    });
    expect(result.success).toBe(true);
  });
});
