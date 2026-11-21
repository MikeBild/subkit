import { describe, expect, test } from "bun:test";
import { type TranslationKey, translate } from "@/lib/i18n";
import { stepKindKey } from "@/lib/workflow-steps";
import {
  addressedConnectors,
  bindingChoice,
  bindingConnectorId,
  type ConnectorTemplate,
  choiceOf,
  choiceValue,
  findSolution,
  freeSlug,
  joinNames,
  missingConnectors,
  NEW_CONNECTOR,
  planSolution,
  SIGN_IN_LABEL,
  type SolutionEntry,
  solutionAddressProblem,
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

function fixtureWorkflow(shape: Record<string, unknown>): SolutionEntry["workflow"] {
  return shape as unknown as SolutionEntry["workflow"];
}

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
        candidates: gaBound ? [{ id: BOUND_GA, slug: "ga4-marketing", name: "GA4 marketing" }] : [],
      },
      {
        placeholder: GMAIL,
        template: "google-gmail",
        template_name: "Gmail",
        connector_id: null,
        connector_name: null,
        candidates: [],
      },
    ],
    sample_input: { property_id: "123456789" },
    workflow: fixtureWorkflow({
      name: "daily-analytics-report",
      trigger: { kind: "schedule", cron: "0 7 * * *", tz: "Europe/Berlin" },
      steps: [
        {
          kind: "request",
          id: "totals",
          method: "POST",
          side_effects: "read",
          connector_id: ga,
          on_error: "fail",
        },
        {
          kind: "request",
          id: "top_pages",
          method: "POST",
          side_effects: "read",
          connector_id: ga,
          on_error: "fail",
        },
        { kind: "transform", id: "build_report", on_error: "fail" },
        {
          kind: "request",
          id: "send_report",
          method: "POST",
          connector_id: GMAIL,
          url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
          on_error: "fail",
        },
      ],
    }),
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

  test("template steps read with the glossary step names, code included", () => {
    expect(solutionSteps(report(false)).map((step) => de(stepKindKey(step)))).toEqual([
      "Dienst abfragen",
      "Dienst abfragen",
      "Code",
      "An Dienst senden",
    ]);
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

  test("the draft takes the planned slug, the bound connectors and records its origin", () => {
    const entry = report(true);
    const plan = planSolution(entry, { choices: {}, created: {}, takenSlugs: new Set() });
    expect(plan).toEqual({
      slug: "daily-analytics-report",
      name: "daily-analytics-report",
      create: entry.connectors.slice(1),
      mapping: {},
    });
    const body = solutionDraftBody(entry, plan, {
      [GMAIL]: "gggggggg-gggg-4ggg-8ggg-gggggggggggg",
    });
    expect(body.recipe).toEqual({ vertical: "solutions", slug: "daily-analytics-report" });
    const definition = body.definition as {
      slug: string;
      name: string;
      steps: Array<{ connector_id?: string }>;
    };
    expect(definition.slug).toBe("daily-analytics-report");
    expect(definition.steps.map((step) => step.connector_id)).toEqual([
      BOUND_GA,
      BOUND_GA,
      undefined,
      "gggggggg-gggg-4ggg-8ggg-gggggggggggg",
    ]);
  });

  test("the same solution twice gives two workflows and reuses the connector made the first time", () => {
    const first = report(true);
    const firstPlan = planSolution(first, { choices: {}, created: {}, takenSlugs: new Set() });
    expect(firstPlan.create.map((c) => c.template)).toEqual(["google-gmail"]);
    const made = "gggggggg-gggg-4ggg-8ggg-gggggggggggg";
    const refreshed = report(true);
    const gmail = refreshed.connectors[1];
    if (!gmail) throw new Error("gmail binding missing");
    gmail.candidates = [{ id: made, slug: "google-gmail", name: "Gmail" }];
    const secondPlan = planSolution(refreshed, {
      choices: {},
      created: {},
      takenSlugs: new Set(["daily-analytics-report"]),
    });
    expect(secondPlan).toEqual({
      slug: "daily-analytics-report-2",
      name: "daily-analytics-report-2",
      create: [],
      mapping: { [GMAIL]: made },
    });
  });

  test("a retry after a refused draft reuses what the first try created", () => {
    const made = "gggggggg-gggg-4ggg-8ggg-gggggggggggg";
    const plan = planSolution(report(true), {
      choices: {},
      created: { [GMAIL]: made },
      takenSlugs: new Set(["daily-analytics-report", "daily-analytics-report-2"]),
    });
    expect(plan.create).toEqual([]);
    expect(plan.mapping).toEqual({ [GMAIL]: made });
    expect(plan.slug).toBe("daily-analytics-report-3");
  });

  test("a person picks between candidates or asks for a new connector", () => {
    const entry = report(false);
    const ga = entry.connectors[0];
    if (!ga) throw new Error("ga binding missing");
    ga.candidates = [
      { id: "aaaaaaaa-0000-4000-8000-000000000001", slug: "ga-a", name: "GA A" },
      { id: "aaaaaaaa-0000-4000-8000-000000000002", slug: "ga-b", name: "GA B" },
    ];
    expect(choiceOf(ga, {})).toEqual({
      kind: "existing",
      id: "aaaaaaaa-0000-4000-8000-000000000001",
    });
    expect(choiceOf(ga, { [GA]: "aaaaaaaa-0000-4000-8000-000000000002" })).toEqual({
      kind: "existing",
      id: "aaaaaaaa-0000-4000-8000-000000000002",
    });
    expect(choiceOf(ga, { [GA]: NEW_CONNECTOR })).toEqual({ kind: "new" });
    expect(choiceOf(ga, { [GA]: "not-a-candidate" })).toEqual({
      kind: "existing",
      id: "aaaaaaaa-0000-4000-8000-000000000001",
    });
    const plan = planSolution(entry, {
      choices: { [GA]: NEW_CONNECTOR },
      created: {},
      takenSlugs: new Set(),
    });
    expect(plan.create.map((c) => c.template)).toEqual(["google-analytics", "google-gmail"]);
  });

  test("a binding shows the chosen connector or the address a new one will get", () => {
    const bound = report(true);
    const open = report(false);
    const [ga, gmail] = open.connectors;
    const [boundGa] = bound.connectors;
    if (!ga || !gmail || !boundGa) throw new Error("bindings missing");
    const templates = [{ slug: "google-gmail", base_url: "https://gmail.googleapis.com" }];
    expect(bindingChoice(boundGa, {}, templates, {})).toEqual({
      connectorId: BOUND_GA,
      address: null,
    });
    expect(bindingChoice(gmail, {}, templates, { [GMAIL]: "ignored" })).toEqual({
      connectorId: null,
      address: "https://gmail.googleapis.com",
    });
    expect(bindingChoice(ga, {}, templates, { [GA]: "https://ga.example" })).toEqual({
      connectorId: null,
      address: "https://ga.example",
    });
    expect(choiceValue(boundGa, {})).toBe(BOUND_GA);
    expect(choiceValue(boundGa, { [GA]: NEW_CONNECTOR })).toBe(NEW_CONNECTOR);
    expect(bindingConnectorId(boundGa)).toBe(BOUND_GA);
    expect(bindingConnectorId(boundGa, { connectorId: null, address: null })).toBeNull();
    expect(bindingConnectorId(ga)).toBeNull();
  });

  test("a solution is found by its recipe slug", () => {
    const entry = report(false);
    expect(findSolution([entry], "daily-analytics-report")).toBe(entry);
    expect(findSolution([entry], "missing")).toBeNull();
  });

  test("only a new connector whose template has no address asks for one", () => {
    const templates = [
      { slug: "google-analytics", base_url: "https://analyticsdata.googleapis.com" },
      { slug: "google-gmail", base_url: null },
    ];
    const needed = addressedConnectors(report(true), templates, {});
    expect(needed.map((c) => c.template)).toEqual(["google-gmail"]);
    expect(addressedConnectors(report(true), [], {})).toEqual([]);
    const withCandidate = report(true);
    const gmail = withCandidate.connectors[1];
    if (!gmail) throw new Error("gmail binding missing");
    gmail.candidates = [{ id: "gggggggg-gggg-4ggg-8ggg-gggggggggggg", slug: "mail", name: "Mail" }];
    expect(addressedConnectors(withCandidate, templates, {})).toEqual([]);
    expect(addressedConnectors(withCandidate, templates, { [GMAIL]: NEW_CONNECTOR })).toHaveLength(
      1,
    );
    expect(solutionAddressProblem(needed, {})).toBe("create.connector.addressInvalid");
    expect(solutionAddressProblem(needed, { [GMAIL]: "http://insecure.example" })).toBe(
      "create.connector.addressInvalid",
    );
    expect(solutionAddressProblem(needed, { [GMAIL]: " https://api.example.com " })).toBeNull();
    expect(solutionAddressProblem([], {})).toBeNull();
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
    expect(templateSignIn({ auth_type: "signed_jwt" })).toBe("machine");
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
