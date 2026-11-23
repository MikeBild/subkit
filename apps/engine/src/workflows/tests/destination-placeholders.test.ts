import { describe, expect, test } from "bun:test";
import {
  type DestinationPlaceholderKind,
  placeholderDestinationErrors,
} from "../destination-placeholders.ts";
import { walkStrings } from "../reference-validator.ts";
import type { WorkflowDef } from "../types.ts";
import { validateWorkflowDef } from "../validator.ts";
import { CONNECTOR_ID, detect, parse, requestWith } from "./destination-placeholders-fixtures.ts";

describe("detectPlaceholderDestinations · scanned sites and path names", () => {
  const cases: Array<{
    name: string;
    def: WorkflowDef;
    step_id: string | null;
    path: string;
    kind: DestinationPlaceholderKind;
    match: string;
  }> = [
    {
      name: "request body.to",
      def: requestWith({ body: { to: "user@example.com", subject: "hi" } }),
      step_id: "send",
      path: "steps.send.body.to",
      kind: "placeholder_email",
      match: "user@example.com",
    },
    {
      name: "nested array inside body",
      def: requestWith({ body: { message: { recipients: ["ops@example.org"] } } }),
      step_id: "send",
      path: "steps.send.body.message.recipients.0",
      kind: "placeholder_email",
      match: "ops@example.org",
    },
    {
      name: "headers",
      def: requestWith({ headers: { "X-Notify": "someone@acme.com" } }),
      step_id: "send",
      path: "steps.send.headers.X-Notify",
      kind: "placeholder_email",
      match: "someone@acme.com",
    },
    {
      name: "query",
      def: requestWith({ query: { to: "recipient@acme.io" } }),
      step_id: "send",
      path: "steps.send.query.to",
      kind: "placeholder_email",
      match: "recipient@acme.io",
    },
    {
      name: "url host",
      def: requestWith({ url: "https://api.example.com/repos" }, "fetch"),
      step_id: "fetch",
      path: "steps.fetch.url",
      kind: "placeholder_host",
      match: "api.example.com",
    },
    {
      name: "graphql.variables",
      def: requestWith({
        graphql: {
          query: "query($email: String) { user(email: $email) { id } }",
          variables: { email: "test@acme.com" },
        },
      }),
      step_id: "send",
      path: "steps.send.graphql.variables.email",
      kind: "placeholder_email",
      match: "test@acme.com",
    },
    {
      name: "mcp.arguments",
      def: parse({
        name: "t",
        steps: [
          {
            id: "notify",
            kind: "request",
            protocol: "mcp",
            method: "CALL",
            connector_id: CONNECTOR_ID,
            mcp: {
              operation: "call_tool",
              tool: "post_message",
              arguments: { channel: "#your-channel", text: "hi" },
            },
          },
        ],
      }),
      step_id: "notify",
      path: "steps.notify.mcp.arguments.channel",
      kind: "placeholder_channel",
      match: "#your-channel",
    },
    {
      name: "report_delivery.to",
      def: requestWith(
        {
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          report_delivery: {
            kind: "gmail_report",
            to: "recipient@example.com",
            from: "reports@acme.com",
            content_type: "text/html",
          },
        },
        "report",
      ),
      step_id: "report",
      path: "steps.report.report_delivery.to",
      kind: "placeholder_email",
      match: "recipient@example.com",
    },
    {
      name: "transform expression",
      def: parse({
        name: "t",
        steps: [
          {
            id: "shape",
            kind: "transform",
            language: "javascript",
            expression: 'return { to: "user@example.com", body: input.input.text };',
          },
        ],
      }),
      step_id: "shape",
      path: "steps.shape.expression",
      kind: "placeholder_email",
      match: "user@example.com",
    },
    {
      name: "output_transform",
      def: parse({
        name: "t",
        steps: [{ id: "a", kind: "transform", language: "javascript", expression: "return 1;" }],
        output_transform: '{ "to": "foo@acme.com", "n": $scope.a.data }',
      }),
      step_id: null,
      path: "output_transform",
      kind: "placeholder_email",
      match: "foo@acme.com",
    },
    {
      name: "output_transform_function",
      def: parse({
        name: "t",
        steps: [{ id: "a", kind: "transform", language: "javascript", expression: "return 1;" }],
        output_transform_function: 'return { to: "me@acme.com" };',
      }),
      step_id: null,
      path: "output_transform_function",
      kind: "placeholder_email",
      match: "me@acme.com",
    },
    {
      name: "input_schema_sample",
      def: parse({
        name: "t",
        steps: [{ id: "a", kind: "transform", language: "javascript", expression: "return 1;" }],
        input_schema_sample: { recipient: "you@example.com" },
      }),
      step_id: null,
      path: "input_schema_sample.recipient",
      kind: "placeholder_email",
      match: "you@example.com",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const violations = detect(c.def);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toEqual({
        step_id: c.step_id,
        path: c.path,
        kind: c.kind,
        match: c.match,
        message: `${c.path}: placeholder destination "${c.match}" — a reserved example or placeholder that cannot be delivered, even when the user typed it; ask the user for the real value with ask_user_text or ask_user_form and never fill it with a placeholder.`,
      });
    });
  }
});

describe("placeholderDestinationErrors", () => {
  test("maps every violation to a ValidationError whose `path: message` rendering equals the violation message", () => {
    const violations = detect(
      requestWith({ body: { to: "user@example.com" }, url: "https://api.example.com/send" }),
    );
    const errors = placeholderDestinationErrors(violations);
    expect(errors).toHaveLength(2);
    for (const [i, e] of errors.entries()) {
      expect(`${e.path}: ${e.message}`).toBe(violations[i]!.message);
    }
    expect(errors[0]).toEqual({
      path: "steps.send.url",
      message:
        'placeholder destination "api.example.com" — a reserved example or placeholder that cannot be delivered, even when the user typed it; ask the user for the real value with ask_user_text or ask_user_form and never fill it with a placeholder.',
    });
  });
});

describe("validateWorkflowDef · destinationTier is opt-in", () => {
  const withPlaceholder = {
    name: "t",
    steps: [
      {
        id: "send",
        kind: "request",
        method: "POST",
        url: "https://api.example.com/send",
        body: { to: "user@example.com" },
      },
    ],
  };

  test("default (runtime callers) never scans and never exposes placeholder_destinations", () => {
    const result = validateWorkflowDef(withPlaceholder);
    expect(result.ok).toBe(true);
    expect("placeholder_destinations" in result).toBe(false);
  });

  test("tier tokens accepts addresses and hosts but exposes an empty list", () => {
    const result = validateWorkflowDef(withPlaceholder, { destinationTier: "tokens" });
    expect(result.ok).toBe(true);
    expect(result.placeholder_destinations).toEqual([]);
  });

  test("tier tokens rejects a REPLACE_ME token with ok:false and a merged error", () => {
    const result = validateWorkflowDef(
      { ...withPlaceholder, steps: [{ ...withPlaceholder.steps[0], body: { to: "REPLACE_ME" } }] },
      { destinationTier: "tokens" },
    );
    expect(result.ok).toBe(false);
    expect(result.placeholder_destinations?.map((v) => v.path)).toEqual(["steps.send.body.to"]);
    expect(result.errors).toEqual([
      {
        path: "steps.send.body.to",
        message:
          'placeholder destination "REPLACE_ME" — a reserved example or placeholder that cannot be delivered, even when the user typed it; ask the user for the real value with ask_user_text or ask_user_form and never fill it with a placeholder.',
      },
    ]);
  });

  test("tier all rejects placeholder addresses and hosts; violations are merged into errors", () => {
    const result = validateWorkflowDef(withPlaceholder, { destinationTier: "all" });
    expect(result.ok).toBe(false);
    expect(result.workflow).toBeUndefined();
    expect(result.placeholder_destinations?.map((v) => v.path)).toEqual([
      "steps.send.url",
      "steps.send.body.to",
    ]);
    expect(result.errors.map((e) => e.path)).toEqual(["steps.send.url", "steps.send.body.to"]);
  });

  test("a schema-invalid definition with a tier set still exposes placeholder_destinations: []", () => {
    const result = validateWorkflowDef(
      { name: "t", steps: [{ kind: "nope" }] },
      {
        destinationTier: "all",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.placeholder_destinations).toEqual([]);
  });
});

describe("walkStrings · path-aware visitor", () => {
  test("reports dot-joined paths from the given root and keeps one-argument visitors working", () => {
    const seen: Array<[string, string]> = [];
    walkStrings({ a: ["x", { b: "y" }], c: "z" }, (s, path) => seen.push([s, path]), "root");
    expect(seen).toEqual([
      ["x", "root.a.0"],
      ["y", "root.a.1.b"],
      ["z", "root.c"],
    ]);
    const legacy: string[] = [];
    walkStrings(["p", "q"], (s) => legacy.push(s));
    expect(legacy).toEqual(["p", "q"]);
    const rootOnly: string[] = [];
    walkStrings("solo", (_s, path) => rootOnly.push(path), "steps.x.url");
    expect(rootOnly).toEqual(["steps.x.url"]);
  });
});
