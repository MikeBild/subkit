// Unit coverage for the elicitation-answer renderer.
//
// Pre-fix symptom: every `ask_user_form` submission rendered as
// `(answered)` in the transcript regardless of what the user typed —
// no audit trail of which fields were filled, even when the values
// were not sensitive. The renderer fell through to the default branch
// because it did not consult the form schema, so it could neither
// distinguish sensitive from non-sensitive fields nor list the field
// names when the engine had already redacted the values.
//
// Post-fix: pass the elicitation's `input` to read the form schema.
// Sensitive fields (type=password, sensitive:true, or a name like
// `token`/`api_key`) render as `<name>=***`. Plain fields render the
// actual value. An empty/redacted output with a known schema renders
// `(filled: <names>)` so the user can see which fields were
// submitted.

import { describe, expect, test } from "bun:test";

import { renderElicitAnswer } from "../ink-app.tsx";

describe("renderElicitAnswer — confirmation outputs", () => {
  test("approve / reject from confirm tools (no payload)", () => {
    expect(renderElicitAnswer({ confirmed: true })).toBe("approve");
    expect(renderElicitAnswer({ confirmed: false })).toBe("reject");
    expect(renderElicitAnswer({ declined: true })).toBe("reject");
  });

  test("forwards reason as suffix", () => {
    expect(renderElicitAnswer({ confirmed: false }, undefined, "too risky")).toBe(
      "reject — too risky",
    );
  });

  // Fix #4 — confirmation transcript shows the proposed payload so the
  // user can scroll back and audit WHAT they approved. Without this the
  // history was 5× `you approve` lines with zero context (session
  // a6440493).
  test("appends commit_intent.description as payload preview", () => {
    const input = {
      kind: "save_workflow_draft",
      commit_intent: {
        kind: "save_workflow_draft",
        description: "Save the DigitalOcean projects workflow",
        payload: {},
      },
    };
    expect(renderElicitAnswer({ confirmed: true }, input)).toBe(
      "approve · Save the DigitalOcean projects workflow",
    );
  });

  test("falls back to target.tool + workflow id when description missing", () => {
    const input = {
      kind: "external_write",
      target: {
        tool: "save_workflow_draft",
        args: { target_workflow_id: "wf_123" },
      },
    };
    expect(renderElicitAnswer({ confirmed: true }, input)).toBe(
      "approve · save_workflow_draft wf_123",
    );
  });

  test("falls back to target.tool + environment when there is no workflow id", () => {
    const input = {
      kind: "external_write",
      target: {
        tool: "run_workflow",
        args: { environment: "prod" },
      },
    };
    expect(renderElicitAnswer({ confirmed: true }, input)).toBe("approve · run_workflow env=prod");
  });

  test("falls back to summary string when no commit_intent or target", () => {
    const input = { kind: "generic", summary: "Run health check?" };
    expect(renderElicitAnswer({ confirmed: true }, input)).toBe("approve · Run health check?");
  });

  test("reject also gets the payload preview, with reason after", () => {
    const input = {
      commit_intent: { description: "Save workflow v2" },
    };
    expect(renderElicitAnswer({ confirmed: false }, input, "too risky")).toBe(
      "reject · Save workflow v2 — too risky",
    );
  });

  test("truncates long descriptions for transcript safety", () => {
    const input = {
      commit_intent: {
        description: "x".repeat(200),
      },
    };
    const out = renderElicitAnswer({ confirmed: true }, input);
    // truncateForTranscript keeps it under 80 chars + ellipsis suffix.
    expect(out.length).toBeLessThan(120);
    expect(out.startsWith("approve · ")).toBe(true);
  });
});

describe("renderElicitAnswer — primitives and choices", () => {
  test("string output passes through", () => {
    expect(renderElicitAnswer("yes")).toBe("yes");
  });

  test("value/choice/choices short-circuits", () => {
    expect(renderElicitAnswer({ value: "v" })).toBe("v");
    expect(renderElicitAnswer({ choice: "a" })).toBe("a");
    expect(renderElicitAnswer({ choices: ["x", "y"] })).toBe("x, y");
  });
});

describe("renderElicitAnswer — form outputs with schema", () => {
  test("sensitive:true field renders as ***", () => {
    const input = {
      fields: [{ name: "token", type: "password", sensitive: true }],
    };
    expect(renderElicitAnswer({ token: "abc-secret" }, input)).toBe("token=***");
  });

  test("type=password is enough to redact", () => {
    const input = { fields: [{ name: "key", type: "password" }] };
    expect(renderElicitAnswer({ key: "xyz" }, input)).toBe("key=***");
  });

  test("non-sensitive field renders the value", () => {
    const input = { fields: [{ name: "environment", type: "string" }] };
    expect(renderElicitAnswer({ environment: "prod" }, input)).toBe("environment=prod");
  });

  test("mixed form: sensitive + non-sensitive", () => {
    const input = {
      fields: [
        { name: "name", type: "string" },
        { name: "token", type: "password", sensitive: true },
      ],
    };
    const rendered = renderElicitAnswer({ name: "Alice", token: "s3cr3t" }, input);
    expect(rendered).toContain("name=Alice");
    expect(rendered).toContain("token=***");
    expect(rendered).not.toContain("s3cr3t");
  });

  test("redacts by name heuristic when schema is missing", () => {
    // Defensive: a malformed `ask_user_form` without `sensitive` flags
    // must still redact known credential field names.
    expect(renderElicitAnswer({ token: "leak" })).toBe("token=***");
    expect(renderElicitAnswer({ api_key: "leak" })).toBe("api_key=***");
    expect(renderElicitAnswer({ password: "leak" })).toBe("password=***");
    expect(renderElicitAnswer({ client_secret: "leak" })).toBe("client_secret=***");
  });

  test("unwraps {values: ...} envelope", () => {
    const input = {
      fields: [{ name: "token", type: "password", sensitive: true }],
    };
    expect(renderElicitAnswer({ values: { token: "abc" } }, input)).toBe("token=***");
  });

  test("truncates long values", () => {
    const input = { fields: [{ name: "note", type: "string" }] };
    const long = "x".repeat(80);
    const rendered = renderElicitAnswer({ note: long }, input);
    expect(rendered.length).toBeLessThan(60);
    expect(rendered.endsWith("…")).toBe(true);
  });
});

describe("renderElicitAnswer — empty / opaque outputs", () => {
  test("empty output with schema names which fields were filled", () => {
    const input = {
      fields: [
        { name: "token", type: "password", sensitive: true },
        { name: "environment", type: "string" },
      ],
    };
    expect(renderElicitAnswer({}, input)).toBe("(filled: token, environment)");
  });

  test("empty output without schema falls through to (answered)", () => {
    expect(renderElicitAnswer({})).toBe("(answered)");
  });

  test("null output renders as (no answer)", () => {
    expect(renderElicitAnswer(null)).toBe("(no answer)");
  });
});
