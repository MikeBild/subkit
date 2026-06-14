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

  test("missing language defaults to javascript — JS body without language tag is accepted", () => {
    // W3a: the default language is now `javascript` (flipped from the
    // prior `jsonata` default). A JS expression body with no `language`
    // field must NOT trip the language-mismatch heuristic.
    const result = TransformStepSchema.safeParse({
      kind: "transform",
      id: "shape",
      expression: "const x = 1; return x;",
    });
    expect(result.success).toBe(true);
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
        i.message.includes("JSONata pipe operator"),
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

  // 6.2.7 REGRESSION GUARD: the 6.2.6 hotfix introduced an
  // over-broad heuristic (`;\s*$`) that matched every JSONata block
  // statement ending in `;`. The production workflow
  // `daily-do-resources-email` has 12+ such lines (assignments,
  // chained `&` concatenations); parsing the row threw a ZodError
  // on EVERY `GET /v1/workflows` call and 500'd the endpoint.
  //
  // This test pins a verbatim slice of that workflow's transform
  // body so any future heuristic change that re-introduces the
  // regression fails LOUDLY here instead of in production.
  test("REGRESSION: real-world JSONata block expression with many `;` separators parses cleanly", () => {
    const result = TransformStepSchema.safeParse({
      kind: "transform",
      id: "format_email",
      language: "jsonata",
      // Verbatim from the daily-do-resources-email workflow that
      // 500'd /v1/workflows after the 6.2.6 deploy. Every line ends
      // with `;` (JSONata block-expression statement separator).
      expression: `(
  $blocks := $scope.projects_loop.data.collect_project.data;
  $body := '<html><body><h2>Daily DigitalOcean Resources Summary</h2><p>Date: ' & $now() & '</p>' & $join($blocks.(
    '<h3>Project: ' & $.name & '</h3>' &
    '<ul>' &
    '<li>Environment: ' & ($.environment != '' ? $.environment : 'n/a') & '</li>' &
    '<li>Purpose: ' & $.purpose & '</li>' &
    '<li>Resource count: ' & $string($count($.resources)) & '</li>' &
    '</ul>' &
    ($count($.resources) > 0 ? '<ul>' & $join($.resources.('<li>' & $.urn & ' (' & $.status & ')</li>')) & '</ul>' : '<p><em>No resources</em></p>')
  )) & '</body></html>';
  { "html": $body, "subject": 'Daily DigitalOcean Resources Summary' }
)`,
    });
    expect(result.success).toBe(true);
  });

  test("REGRESSION: JSONata using `function($x) { ... }` anonymous form parses cleanly", () => {
    // JSONata's anonymous-function builtin uses the literal keyword
    // `function`; the original 6.2.6 heuristic matched on `function`
    // alone and would have rejected this. The tightened heuristic
    // requires `=>` arrow OR `const|let|var <name> =` declaration —
    // neither is present in a JSONata `function($x)` body.
    const result = TransformStepSchema.safeParse({
      kind: "transform",
      id: "group_by_mime",
      language: "jsonata",
      expression:
        "$scope.list_files.data.files ~> $map(function($f) { { 'name': $f.name, 'type': $f.mimeType } })",
    });
    expect(result.success).toBe(true);
  });

  test("REGRESSION: JSONata using `$let` and `;`-separated chained expressions parses", () => {
    // Another shape that triggered the over-broad heuristic.
    const result = TransformStepSchema.safeParse({
      kind: "transform",
      id: "summary",
      language: "jsonata",
      expression: `(
  $count_done := $count($scope.tickets.data[status = 'done']);
  $count_open := $count($scope.tickets.data[status != 'done']);
  { 'done': $count_done, 'open': $count_open }
)`,
    });
    expect(result.success).toBe(true);
  });
});
