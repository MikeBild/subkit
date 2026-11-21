import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { GrantEffectReview } from "@/components/cockpit/grant-effect-review";
import { type AuthorityReviewPreview, authorityReviewModel } from "@/lib/authority-review-model";
import { type Locale, translate, translatePlural } from "@/lib/i18n";
import { I18nContext, type I18nValue } from "@/lib/i18n-context";

type Effect = AuthorityReviewPreview["manifest"]["effects"][number];
const connector = "00000000-0000-4000-8000-000000000004";
const origin = "https://api.example.test";

function effect(step_id: string, extra: Record<string, unknown>): Effect {
  return {
    tenant_id: "00000000-0000-4000-8000-000000000001",
    step_id,
    connector_id: connector,
    driver: "http",
    environment: "prod",
    request_digest: "d".repeat(64),
    target: `${origin}/v2/${step_id}`,
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    operation: "POST",
    effect: "write",
    boundary: {
      base_url: origin,
      method: "POST",
      origin,
      segments: ["", "v2", step_id],
      variables: {},
      query: { fixed: {}, variable: [] },
      max_body_bytes: 500,
      max_calls: 1,
      ...extra,
    },
  } as Effect;
}

function render(locale: Locale, effects: Effect[], toolPinsCompared?: boolean): string {
  const preview: AuthorityReviewPreview = {
    manifest: {
      schema_version: 1,
      tenant_id: "00000000-0000-4000-8000-000000000001",
      workflow_id: "00000000-0000-4000-8000-000000000002",
      workflow_version_id: "00000000-0000-4000-8000-000000000003",
      workflow_digest: "e".repeat(64),
      execution_environment: "prod",
      execution_options_digest: "c".repeat(64),
      effects,
      issues: [],
    },
    approval_carries_over: false,
    schedules: [],
    boundary_growth: [],
    effect_changes: [],
  };
  const value = {
    locale,
    preference: locale,
    setPreference() {},
    t: (key, values) => translate(locale, key, values),
    tn: (key, count, values) => translatePlural(locale, key, count, values),
    dateTime: (date) => String(date),
  } as I18nValue;
  const model = authorityReviewModel({
    preview,
    connectorNames: new Map([[connector, "Example"]]),
    automation: { schedule: false, webhook: false },
    activation: true,
    carryOver: false,
  });
  return renderToStaticMarkup(
    <I18nContext.Provider value={value}>
      <GrantEffectReview
        model={model}
        growth={[]}
        problems={[]}
        loading={false}
        {...(toolPinsCompared === undefined ? {} : { toolPinsCompared })}
      />
    </I18nContext.Provider>,
  )
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

test("a connector that adds query parameters is named in plain words and by key, never by value", () => {
  const effects = [
    effect("search", {
      connector_query: { fixed: { format: "s3cr3t-format" }, credential: ["api_key"] },
    }),
  ];
  const de = render("de", effects);
  expect(de).toContain("Der Connector hängt an jede Anfrage dieses Schritts eigene");
  expect(de).toContain("die Parameter format, api_key");
  expect(de).not.toContain("s3cr3t");
  const en = render("en", effects);
  expect(en).toContain("The connector adds its own sign-in or fixed parameters");
  expect(en).toContain("the parameters format, api_key");
  expect(en).toContain("format=…&amp;api_key=…");
  expect(en).not.toContain("s3cr3t");
});

test("paging through the body says in plain words how far it goes and what moves", () => {
  const effects = [
    effect("search", {
      pagination: { params: ["cursor", "limit"], max_requests: 12, location: "body" },
    }),
  ];
  const de = render("de", effects);
  expect(de).toContain("Dieser Schritt liest bis zu 12 Seiten, und von Seite zu Seite");
  expect(de).toContain("bewegen sich von Seite zu Seite nur cursor, limit");
  const en = render("en", effects);
  expect(en).toContain("This step reads up to 12 pages, and between pages");
  expect(en).toContain("only cursor, limit move from page to page");
});

test("a step without either shape shows neither note", () => {
  const html = render("en", [effect("plain", {})]);
  expect(html).not.toContain("The connector adds");
  expect(html).not.toContain("This step reads");
});

function toolEffect(effectKind: "read" | "write", annotations: Record<string, boolean>): Effect {
  return {
    tenant_id: "00000000-0000-4000-8000-000000000001",
    step_id: "lookup",
    connector_id: connector,
    driver: "mcp",
    environment: "prod",
    request_digest: "d".repeat(64),
    target: "https://tools.example.test/mcp#search",
    configuration_digest: "a".repeat(64),
    credential_binding_digest: "b".repeat(64),
    rewrites_target: false,
    operation: "tools/call:search",
    effect: effectKind,
    mcp: {
      server: "https://tools.example.test/mcp",
      tool: "search",
      effect: effectKind,
      variables: { "input.q": { enum: ["alpha", "beta"] } },
      arguments: [{ path: ["q"], var: "input.q" }],
      fixed_arguments_digest: "e".repeat(64),
      max_calls: 3,
      descriptor: {
        name: "search",
        annotations,
        input_schema_digest: "f".repeat(64),
        digest: "0123456789abcdef".repeat(4),
      },
    },
  } as unknown as Effect;
}

test("a tool call shows the stated effect, the tool's own claim as a hint, and that it is pinned", () => {
  const de = render("de", [toolEffect("read", { readOnlyHint: true })], true);
  expect(de).toContain("Du gibst diesen Tool-Aufruf als einen frei, der nur liest.");
  expect(de).toContain(
    "Der Server führt dieses Tool als nur lesend, was SubKit nicht prüfen kann.",
  );
  expect(de).toContain("hält der nächste Run an");
  expect(de).not.toContain("gib ihn nur frei, wenn du das Tool kennst.");
  expect(de).toContain("tools/call:search https://tools.example.test/mcp · search");
  expect(de).toContain("0123456789ab");
  const en = render("en", [toolEffect("read", { readOnlyHint: true })], true);
  expect(en).toContain("You approve this tool call as one that only reads.");
  expect(en).toContain("the next run stops and asks you to review again");
});

test("a stated read the tool does not confirm is called out", () => {
  const en = render("en", [toolEffect("read", {})], true);
  expect(en).toContain("The server does not say whether this tool changes data.");
  expect(en).toContain("so approve it only if you know the tool.");
  const de = render("de", [toolEffect("read", { destructiveHint: true })], true);
  expect(de).toContain("Daten löschen oder überschreiben kann");
  expect(de).toContain("gib ihn nur frei, wenn du das Tool kennst.");
});

test("a stated write stays a write whatever the tool says about itself", () => {
  const en = render("en", [toolEffect("write", { readOnlyHint: true })]);
  expect(en).toContain("You approve this tool call as one that may change data.");
  expect(en).not.toContain("only reads.");
  expect(en).not.toContain("approve it only if you know the tool.");
});

test("without a server comparison the hint is worded as recorded on the step, never as the server's", () => {
  for (const compared of [undefined, false]) {
    const en = render("en", [toolEffect("read", { readOnlyHint: true })], compared);
    expect(en).toContain("The step records this tool as read-only");
    expect(en).toContain("SubKit has not compared that with the server for you.");
    expect(en).not.toContain("The server lists this tool");
    const de = render("de", [toolEffect("read", { readOnlyHint: true })], compared);
    expect(de).toContain("SubKit hat das für dich nicht mit dem Server verglichen.");
    expect(de).not.toContain("Der Server führt dieses Tool");
  }
});
