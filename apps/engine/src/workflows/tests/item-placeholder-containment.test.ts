import { describe, expect, test } from "bun:test";
import { validateWorkflowDef } from "../validator.ts";

describe("validateWorkflowDef · item-placeholder containment", () => {
  test("rejects a request step with `${item.id}` not contained in any loop", () => {
    const result = validateWorkflowDef({
      name: "t",
      steps: [
        { id: "fetch", kind: "request", method: "GET", url: "https://x/y" },
        {
          id: "iter_body",
          kind: "request",
          method: "GET",
          url: "https://x/y/${item.id}",
        },
      ],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => /item\.…|not contained/.test(e.message))).toBe(true);
  });

  test("rejects a body step whose item placeholder is `${notitem.id}` if no loop", () => {
    const result = validateWorkflowDef({
      name: "t",
      steps: [
        { id: "fetch", kind: "request", method: "GET", url: "https://x/y/${cred.foo.token}" },
      ],
    });
    expect(result.ok).toBe(true);
  });
});
