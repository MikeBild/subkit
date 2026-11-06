// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${…}` runtime placeholders are part of the tested grammar.
import { describe, expect, test } from "bun:test";
import type { DestinationPlaceholderKind, PlaceholderTier } from "../destination-placeholders.ts";
import type { WorkflowDef } from "../types.ts";
import { validateWorkflowDef } from "../validator.ts";
import { CONNECTOR_ID, detect, parse, requestWith } from "./destination-placeholders-fixtures.ts";

function kinds(def: WorkflowDef, tier: PlaceholderTier = "all"): DestinationPlaceholderKind[] {
  return detect(def, tier).map((v) => v.kind);
}

describe("detectPlaceholderDestinations · tier tokens (always invalid)", () => {
  const tokenCases: Array<[string, DestinationPlaceholderKind]> = [
    ["REPLACE_ME", "token"],
    ["CHANGE_ME", "token"],
    ["TODO", "token"],
    ["FIXME", "token"],
    ["TBD", "token"],
    ["<recipient>", "token"],
    ["<email>", "token"],
    ["<address>", "token"],
    ["<channel>", "token"],
    ["<webhook>", "token"],
    ["<url>", "token"],
    ["<YOUR_WEBHOOK_URL>", "token"],
    ["{{recipient}}", "template"],
    ["555-0100", "placeholder_phone"],
    ["+1 555 0199", "placeholder_phone"],
    ["123-456-7890", "placeholder_phone"],
    ["000-000-0000", "placeholder_phone"],
    ["XXX-XXX-XXXX", "placeholder_phone"],
    ["#your-channel", "placeholder_channel"],
    ["#channel", "placeholder_channel"],
    ["#example", "placeholder_channel"],
  ];
  for (const [value, kind] of tokenCases) {
    test(`${JSON.stringify(value)} is a ${kind} in BOTH tiers`, () => {
      const def = requestWith({ body: { to: value } });
      for (const tier of ["tokens", "all"] as const) {
        const violations = detect(def, tier);
        expect(violations.map((v) => v.kind)).toEqual([kind]);
        expect(violations[0]?.match).toBe(value);
        expect(violations[0]?.path).toBe("steps.send.body.to");
      }
    });
  }

  test("repository documentation paths are not placeholder destinations", () => {
    const def = parse({
      name: "repository-briefing",
      steps: [
        {
          id: "source_doc",
          kind: "request",
          method: "GET",
          connector_id: CONNECTOR_ID,
          path: "/repos/MikeBild/subkit/contents/LICENSE",
        },
        {
          id: "snapshot",
          kind: "transform",
          language: "javascript",
          expression: 'return { source_path: "LICENSE", content: input.scope.source_doc.data };',
        },
      ],
    });

    expect(detect(def, "tokens")).toEqual([]);
    expect(detect(def, "all")).toEqual([]);
  });

  test("embedded tokens are found inside longer strings", () => {
    const def = requestWith({
      body: { to: "ops-REPLACE_ME@acme.com", note: "send to <recipient> on {{channel}}" },
    });
    expect(
      detect(def, "tokens")
        .map((v) => v.match)
        .sort(),
    ).toEqual(["<recipient>", "REPLACE_ME", "{{channel}}"]);
  });

  test.each([
    ["{{recipient}}", "{{recipient}}"],
    ["{{ email }}", "{{ email }}"],
    ["{{YOUR_WEBHOOK_URL}}", "{{YOUR_WEBHOOK_URL}}"],
    ["post to {{channel}} now", "{{channel}}"],
  ])(
    "%s names a destination in Mustache syntax and is a template in BOTH tiers",
    (value, match) => {
      const def = requestWith({ body: { to: value } });
      for (const tier of ["tokens", "all"] as const) {
        expect(detect(def, tier).map((v) => [v.kind, v.match])).toEqual([["template", match]]);
      }
    },
  );

  test("a downstream template variable that is not a destination passes on both tiers", () => {
    const def = requestWith({
      body: {
        personalizations: [
          {
            to: [{ email: "ops@acme.com" }],
            dynamic_template_data: { subject: "Hello {{first_name}}" },
          },
        ],
        text: "{{#if premium}}Thanks{{/if}} {{ order.total }} {{}}",
      },
    });
    expect(detect(def, "tokens")).toEqual([]);
    expect(detect(def, "all")).toEqual([]);
  });

  test("nested braces in JSONata and JavaScript code sites are code, not templates", () => {
    const def = parse({
      name: "t",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          url: "https://jsonplaceholder.typicode.com/users",
        },
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression:
            "const out = []; for (const x of input.input.items) {{ out.push(x); }} return out;",
        },
      ],
      output_transform: '$map($scope.fetch.data, function($v){{"name": $v.name}})',
    });
    const withJsOutput = parse({
      ...def,
      output_transform: undefined,
      output_transform_function: "if (input) {{ return { names: input.map((v) => v.name) }; }}",
    });
    for (const candidate of [def, withJsOutput]) {
      expect(detect(candidate, "tokens")).toEqual([]);
      expect(detect(candidate, "all")).toEqual([]);
      expect(validateWorkflowDef(candidate, { destinationTier: "tokens" }).ok).toBe(true);
      expect(validateWorkflowDef(candidate, { destinationTier: "all" }).ok).toBe(true);
    }
  });

  test("lowercase or embedded words are not tokens", () => {
    const def = requestWith({
      body: {
        a: "todo list for TODOS",
        b: "fixmeup",
        c: "tbd-corp",
        d: "<p>hello</p>",
        e: "https://docs.acme.com/page#channel",
        f: "#ops-alerts",
        g: "+49 30 1234567",
        h: "555-1234",
      },
    });
    expect(detect(def, "tokens")).toEqual([]);
    expect(detect(def, "all")).toEqual([]);
  });

  test("tier tokens does NOT flag placeholder addresses or hosts", () => {
    const def = requestWith({
      url: "https://api.example.com/send",
      body: { to: "user@example.com", hook: "https://hooks.slack.com/services/T000/B000/XXXX" },
    });
    expect(detect(def, "tokens")).toEqual([]);
    expect(kinds(def, "all").sort()).toEqual([
      "placeholder_email",
      "placeholder_host",
      "placeholder_webhook",
    ]);
  });
});

describe("detectPlaceholderDestinations · tier all (LLM paths)", () => {
  test.each([
    "user@example.com",
    "test@acme.com",
    "test2@acme.com",
    "example@acme.com",
    "someone@acme.com",
    "recipient@acme.com",
    "foo@acme.com",
    "you@acme.com",
    "me@acme.com",
    "ops@example.org",
    "ops@example.net",
    "ops@mail.example.com",
    "ops@acme.example",
    "ops@acme.test",
    "ops@acme.invalid",
    "ops@acme.localhost",
    "ops@domain.com",
    "ops@yourdomain.com",
    "ops@your-company.io",
  ])("%s is a placeholder email", (email) => {
    const violations = detect(requestWith({ body: { to: email } }));
    expect(violations.map((v) => [v.kind, v.match])).toEqual([["placeholder_email", email]]);
  });

  test.each([
    "ops@acme.com",
    "anna.schmidt@contoso.de",
    "billing+2026@shop.io",
    "team.lead@acme.co.uk",
  ])("%s is a real address", (email) => {
    expect(detect(requestWith({ body: { to: email } }))).toEqual([]);
  });

  test.each([
    ["https://api.example.com/repos", "api.example.com"],
    ["https://example.org/", "example.org"],
    ["https://example.net/x", "example.net"],
    ["https://mail.example.test/send", "mail.example.test"],
    ["https://acme.example/api", "acme.example"],
    ["https://api.acme.invalid/x", "api.acme.invalid"],
    ["https://app.acme.localhost/x", "app.acme.localhost"],
    ["https://your-domain.com/api", "your-domain.com"],
    ["https://yourcompany.atlassian.net/rest", "yourcompany.atlassian.net"],
    ["https://your-host:8443/api", "your-host"],
    ["https://admin@your-server.io/api", "your-server.io"],
  ])("%s has a placeholder host", (url, host) => {
    const violations = detect(requestWith({ url }, "fetch"));
    expect(violations.map((v) => [v.kind, v.match])).toEqual([["placeholder_host", host]]);
  });

  test.each([
    "https://jsonplaceholder.typicode.com/users",
    "https://api.digitalocean.com/v2/droplets",
    "https://notexample.com/x",
    "https://example.co.uk/x",
    "http://localhost:3000/x",
    "https://examples.acme.com/x",
  ])("%s is a real host", (url) => {
    expect(detect(requestWith({ url }, "fetch"))).toEqual([]);
  });

  test("Slack webhooks with null ids are placeholders, real ones are not", () => {
    const nullHook =
      "https://hooks.slack.com/services/T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX";
    const letterHook =
      "https://hooks.slack.com/services/TXXXXXXXX/BXXXXXXXX/XXXXXXXXXXXXXXXXXXXXXXXX";
    const realHook =
      "https://hooks.slack.com/services/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";
    expect(detect(requestWith({ url: nullHook })).map((v) => v.kind)).toEqual([
      "placeholder_webhook",
    ]);
    expect(detect(requestWith({ url: letterHook })).map((v) => v.kind)).toEqual([
      "placeholder_webhook",
    ]);
    expect(detect(requestWith({ url: realHook }))).toEqual([]);
  });

  test("strings carrying a runtime placeholder are exempt from the address rules", () => {
    const def = requestWith({
      url: "${connector.mailer.base_url}/send",
      body: {
        to: "${input.recipient}",
        cc: "${input.name}@example.com",
        from: "${cred.gmail.address}",
        each: "${item.email}",
        prev: "${scope.lookup.data.email}",
      },
    });
    expect(detect(def, "all")).toEqual([]);
  });

  test("tokens still apply next to a runtime placeholder", () => {
    const def = requestWith({ body: { to: "REPLACE_ME-${input.suffix}" } });
    expect(detect(def, "all").map((v) => v.kind)).toEqual(["token"]);
  });

  test("a connector-bound relative path is only scanned for tokens", () => {
    const withAddress = parse({
      name: "t",
      steps: [
        {
          id: "lookup",
          kind: "request",
          method: "GET",
          connector_id: CONNECTOR_ID,
          path: "/users/test@example.com",
        },
      ],
    });
    expect(detect(withAddress, "all")).toEqual([]);
    const withToken = parse({
      name: "t",
      steps: [
        {
          id: "lookup",
          kind: "request",
          method: "GET",
          connector_id: CONNECTOR_ID,
          path: "/users/REPLACE_ME",
        },
      ],
    });
    expect(detect(withToken, "all").map((v) => [v.kind, v.path])).toEqual([
      ["token", "steps.lookup.path"],
    ]);
  });

  test("the same match at the same path is reported once; different paths separately", () => {
    const def = parse({
      name: "t",
      steps: [
        {
          id: "send",
          kind: "request",
          method: "POST",
          url: "https://api.acme.com/send",
          body: { to: "user@example.com", cc: "user@example.com" },
        },
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression: 'const a = "user@example.com"; const b = "user@example.com"; return a + b;',
        },
      ],
    });
    expect(detect(def).map((v) => v.path)).toEqual([
      "steps.send.body.to",
      "steps.send.body.cc",
      "steps.shape.expression",
    ]);
  });
});
