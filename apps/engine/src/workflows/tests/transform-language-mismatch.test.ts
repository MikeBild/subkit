import { describe, expect, test } from "bun:test";
import { TransformStepSchema } from "../types.ts";

describe("TransformStepSchema — JSONata pipe in a JavaScript body (language_mismatch)", () => {
  test("JSONata `~>` body tagged language=javascript is rejected with suggested_language=javascript", () => {
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
    ).toEqual({ error_code: "language_mismatch", suggested_language: "javascript" });
  });

  test("missing language defaults to javascript — JS body without language tag is accepted", () => {
    const result = TransformStepSchema.safeParse({
      kind: "transform",
      id: "shape",
      expression: "const x = 1; return x;",
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

  test("language=jsonata is no longer a valid transform language (enum rejects it)", () => {
    const result = TransformStepSchema.safeParse({
      kind: "transform",
      id: "shape",
      language: "jsonata",
      expression: '{ "name": $scope.fetch_user.data.name }',
    });
    expect(result.success).toBe(false);
  });

  test("a JS body that mentions `const` inside a string literal is accepted", () => {
    const result = TransformStepSchema.safeParse({
      kind: "transform",
      id: "shape",
      language: "javascript",
      expression: 'return { handler: "const-handler" };',
    });
    expect(result.success).toBe(true);
  });
});
