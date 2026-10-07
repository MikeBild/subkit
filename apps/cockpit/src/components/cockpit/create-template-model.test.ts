import { describe, expect, test } from "bun:test";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  type ConnectorTemplate,
  freeSlug,
  joinNames,
  missingConnectors,
  SIGN_IN_LABEL,
  type SolutionEntry,
  solutionBoundary,
  solutionDraftBody,
  solutionMatches,
  solutionNeeds,
  solutionSteps,
  solutionText,
  solutionTrigger,
  sortedTemplates,
  templateConnectorBody,
  templateConnectProblem,
  templateKeyHeader,
  templateMatches,
  templateNeedsAddress,
  templateSignIn,
} from "./create-template-model";

const GA = "52000000-0000-4000-8000-000000000001";
const GMAIL = "52000000-0000-4000-8000-000000000002";
const BOUND_GA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function report(gaBound: boolean): SolutionEntry {
  const ga = gaBound ? BOUND_GA : GA;
  return {
    template_slug: null,
    recipe_slug: "daily-analytics-report",
    title: "Email a daily Google Analytics report",
    description: "Every morning, reads yesterday's numbers and sends them as one mail.",
    category: "analytics",
    tags: [],
    difficulty: "intermediate",
    connectors: [
      {
        placeholder: GA,
        template: "google-analytics",
        template_name: "Google Analytics 4",
        connector_id: gaBound ? BOUND_GA : null,
        connector_name: gaBound ? "GA4 marketing" : null,
      },
      {
        placeholder: GMAIL,
        template: "google-gmail",
        template_name: "Gmail",
        connector_id: null,
        connector_name: null,
      },
    ],
    sample_input: { property_id: "123456789" },
    workflow: {
      name: "daily-analytics-report",
      trigger: { kind: "schedule", cron: "0 7 * * *", tz: "Europe/Berlin" },
      steps: [
        { kind: "request", id: "totals", method: "POST", side_effects: "read", connector_id: ga },
        {
          kind: "request",
          id: "top_pages",
          method: "POST",
          side_effects: "read",
          connector_id: ga,
        },
        { kind: "transform", id: "build_report" },
        {
          kind: "request",
          id: "send_report",
          method: "POST",
          connector_id: GMAIL,
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
        },
      ],
    },
  };
}

const de = (key: TranslationKey) => translate("de", key);

function template(overrides: Partial<ConnectorTemplate>): ConnectorTemplate {
  return {
    version: 1,
    slug: "anthropic",
    name: "Anthropic",
    driver: "http",
    base_url: "https://api.anthropic.com/v1",
    auth_type: "header",
    oauth: null,
    default_skill: null,
    ingestion_source: "unsupported",
    ingestion_url: null,
    icon: "anthropic.svg",
    description: "Anthropic Claude API",
    category: "ai",
    tags: [],
    aliases: ["claude"],
    setup_instructions: "Create an API key.",
    auth_options: [],
    url_pattern: null,
    keywords: [],
    inline_schema: null,
    probe_endpoint: null,
    credential_hints: [
      {
        field: "value",
        label: "API key",
        placeholder: "",
        doc_url: null,
        secret: true,
        header_name: "x-api-key",
      },
    ],
    base_url_options: [],
    pagination_defaults: null,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
    example_paths: [],
    operator_quirks: {},
    recipes: [],
    aws_service: null,
    aws_region: null,
    verified_at: null,
    respects_robots: false,
    source: "builtin",
    id: null,
    ...overrides,
  } as ConnectorTemplate;
}

describe("solution templates: list, detail, create", () => {
  test("shipped solutions read in the cockpit language, others keep the engine's words", () => {
    expect(solutionText(report(false), de)).toEqual({
      title: "Tagesbericht per Mail",
      line: "Schickt jeden Morgen Besuche und Top-Seiten aus Google Analytics per Mail.",
    });
    const custom = { ...report(false), recipe_slug: "custom" };
    expect(solutionText(custom, de)).toEqual({ title: custom.title, line: custom.description });
  });

  test("the detail names trigger, steps and the connectors it needs", () => {
    const entry = report(false);
    expect(solutionTrigger(entry)).toBe("schedule");
    expect(solutionSteps(entry).map((step) => step.id)).toEqual([
      "totals",
      "top_pages",
      "build_report",
      "send_report",
    ]);
    expect(solutionNeeds(entry)).toEqual(["Google Analytics 4", "Gmail"]);
  });

  test("the boundary says per connector whether it reads or writes, by its own name once bound", () => {
    expect(solutionBoundary(report(true))).toEqual([
      { name: "GA4 marketing", effect: "read", host: null },
      { name: "Gmail", effect: "write", host: "gmail.googleapis.com" },
    ]);
  });

  test("needed connectors read as one list in the cockpit language", () => {
    expect(joinNames(["Gmail", "Google Drive"], "de-DE")).toBe("Gmail und Google Drive");
    expect(joinNames(["Gmail", "Google Drive", "Stripe"], "en-US")).toBe(
      "Gmail, Google Drive, and Stripe",
    );
    expect(joinNames(["Slack"], "de-DE")).toBe("Slack");
  });

  test("only unbound connectors are missing", () => {
    expect(missingConnectors(report(true)).map((c) => c.template)).toEqual(["google-gmail"]);
    expect(missingConnectors(report(false))).toHaveLength(2);
  });

  test("the draft keeps the bound workflow, takes the recipe slug and records its origin", () => {
    const body = solutionDraftBody(report(true));
    expect(body.recipe).toEqual({ vertical: "solutions", slug: "daily-analytics-report" });
    const definition = body.definition as { slug: string; steps: Array<{ connector_id?: string }> };
    expect(definition.slug).toBe("daily-analytics-report");
    expect(definition.steps[0]?.connector_id).toBe(BOUND_GA);
  });

  test("search finds a solution by its title, its words and the connectors it needs", () => {
    const entry = report(false);
    const text = solutionText(entry, de);
    expect(solutionMatches(entry, text, "")).toBe(true);
    expect(solutionMatches(entry, text, "tagesbericht")).toBe(true);
    expect(solutionMatches(entry, text, "gmail")).toBe(true);
    expect(solutionMatches(entry, text, "stripe")).toBe(false);
  });
});

describe("connector templates: list, detail, connect", () => {
  test("the sign-in follows the template's auth type", () => {
    expect(templateSignIn({ auth_type: "oauth2" })).toBe("account");
    expect(templateSignIn({ auth_type: "bearer" })).toBe("key");
    expect(templateSignIn({ auth_type: "header" })).toBe("key");
    expect(templateSignIn({ auth_type: "none" })).toBe("none");
    for (const auth_type of ["basic", "query", "aws_sigv4"] as const)
      expect(templateSignIn({ auth_type })).toBe("elsewhere");
    for (const key of Object.values(SIGN_IN_LABEL)) expect(translate("de", key)).not.toBe(key);
  });

  test("a header template names its header, others leave it to the person", () => {
    expect(templateKeyHeader(template({}))).toBe("x-api-key");
    expect(templateKeyHeader(template({ credential_hints: [] }))).toBeNull();
  });

  test("an address is asked only when the template has none or a placeholder in it", () => {
    expect(templateNeedsAddress(template({}))).toBe(false);
    expect(templateNeedsAddress(template({ base_url: null }))).toBe(true);
    expect(
      templateNeedsAddress(template({ base_url: "https://{shop}.myshopify.com/admin/api" })),
    ).toBe(true);
    expect(templateNeedsAddress(template({ base_url: "", driver: "postgres" }))).toBe(false);
  });

  test("the list is sorted by name and searchable by name, slug, alias and category", () => {
    const list = [
      template({
        slug: "stripe",
        name: "Stripe",
        category: "payments",
        aliases: [],
        description: "Stripe REST API",
      }),
      template({}),
    ];
    expect(sortedTemplates(list).map((t) => t.slug)).toEqual(["anthropic", "stripe"]);
    expect(list.filter((t) => templateMatches(t, "claude")).map((t) => t.slug)).toEqual([
      "anthropic",
    ]);
    expect(list.filter((t) => templateMatches(t, "PAYMENTS")).map((t) => t.slug)).toEqual([
      "stripe",
    ]);
  });

  test("a second connector from the same template gets its own slug and name", () => {
    expect(freeSlug("anthropic", new Set())).toBe("anthropic");
    expect(freeSlug("anthropic", new Set(["anthropic", "anthropic-2"]))).toBe("anthropic-3");
    expect(templateConnectorBody(template({}), new Set())).toEqual({
      name: "Anthropic",
      slug: "anthropic",
      driver: "http",
      environment: "prod",
      auth_type: "header",
      template_slug: "anthropic",
    });
    const second = templateConnectorBody(
      template({ base_url: null }),
      new Set(["anthropic"]),
      " https://proxy.example.com/v1 ",
    );
    expect(second).toEqual(
      expect.objectContaining({
        name: "Anthropic 2",
        slug: "anthropic-2",
        base_url: "https://proxy.example.com/v1",
      }),
    );
  });

  test("connecting asks for what the template cannot fill in", () => {
    const base = {
      signIn: "key" as const,
      needsAddress: false,
      address: "",
      secret: "sk-test",
      header: null,
      callbackUrl: null,
    };
    expect(templateConnectProblem(base)).toBeNull();
    expect(templateConnectProblem({ ...base, secret: " " })).toBe("create.connector.secretMissing");
    expect(templateConnectProblem({ ...base, header: "" })).toBe("create.template.headerMissing");
    expect(templateConnectProblem({ ...base, needsAddress: true, address: "http://x" })).toBe(
      "create.connector.addressInvalid",
    );
    expect(templateConnectProblem({ ...base, signIn: "account", secret: "" })).toBe(
      "signIn.failed.publicUrl",
    );
    expect(
      templateConnectProblem({
        ...base,
        signIn: "account",
        secret: "",
        callbackUrl: "https://subkit.example.com/cb",
      }),
    ).toBeNull();
  });
});
