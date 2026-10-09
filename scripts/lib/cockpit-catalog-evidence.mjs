import { LOCALE_TAGS, translate } from "../../apps/cockpit/src/lib/i18n.ts";
import { WORKFLOW_OPERATING_STATUSES } from "../../packages/shared/src/workflow-operating-status.ts";

const CREATED = "2024-01-01T12:00:00.000Z";
const UPDATED = "2025-07-11T12:00:00.000Z";
const TESTED = "2024-03-19T12:00:00.000Z";
const ROUTE = "**/v1/**";
const STATUS_KEYS = {
  active: "status.active",
  waiting_approval: "workflowStrip.state.grant",
  waiting_connector: "workflowStrip.state.connector",
  failing: "workflowStrip.state.failing",
  stopped: "workflowStrip.state.stopped",
  repair_required: "automation.state.repair",
  unapproved: "workflowStrip.state.unapproved",
  disabled: "workflowStrip.state.disabled",
  unknown: "automation.state.unknown",
};
const categoryAt = (index) => ["finance", "support", "other"][index % 3];
const idAt = (kind, index) => `0a738614-5c4f-4a53-${kind}-${String(index + 1).padStart(12, "0")}`;
const EXPECTED_KIND_SLUGS = {
  oauth: ["evidence-oauth"],
  mcp: ["evidence-mcp-known", "evidence-mcp-unknown", "evidence-mcp-empty", "evidence-mcp-oauth"],
  key: ["evidence-key"],
};
const title = (row) => row.name ?? row.display_name;

function require(condition, message) {
  if (!condition) throw new Error(message);
}

function workflowRows(tenantId) {
  return WORKFLOW_OPERATING_STATUSES.map((status, index) => {
    const scheduled = ["active", "waiting_approval", "stopped"].includes(status);
    const scheduleState =
      status === "stopped" ? "paused" : status === "waiting_approval" ? "held" : "active";
    const noSteps = status === "unapproved";
    const waitingConnector = status === "waiting_connector";
    return {
      id: idAt("8a01", index),
      tenant_id: tenantId,
      slug: `evidence-${status}`,
      name: `Evidence ${status}`,
      operating_status: status,
      category: categoryAt(index),
      category_source: "human",
      description: index === 0 ? null : `Catalog example ${index + 1}`,
      description_source: index % 2 === 1 ? "llm" : "human",
      lifecycle: status === "disabled" ? "archived" : noSteps ? "draft" : "active",
      current_version_id: noSteps ? null : idAt("8b01", index),
      draft_version_id: null,
      current_version: noSteps ? null : 1,
      creator: null,
      checksum: null,
      created_at: CREATED,
      updated_at: UPDATED,
      last_executed_at: status === "failing" ? UPDATED : null,
      health_state: status === "failing" ? "degraded" : "ok",
      health_reason: null,
      health_changed_at: null,
      invalid: false,
      connector_references: waitingConnector
        ? [
            {
              step_id: "fetch",
              connector_id: idAt("8c01", 3),
              slug: "evidence-oauth",
              name: "Evidence OAuth",
              reason: "available",
            },
          ]
        : [],
      connectors: waitingConnector ? ["evidence-oauth"] : [],
      steps: noSteps
        ? []
        : waitingConnector
          ? [
              {
                id: "fetch",
                kind: "request",
                connector_id: idAt("8c01", 3),
                method: "GET",
                path: "/records",
              },
            ]
          : [{ id: "prepare", kind: "transform", expression: "return input;" }],
      input_schema: null,
      output_schema: null,
      output_transform: null,
      output_transform_function: null,
      response_filters: null,
      validation_expression: null,
      validation_function: null,
      timeout_ms: null,
      max_llm_tokens_per_run: null,
      trigger: scheduled ? { kind: "schedule", cron: "0 8 * * 1", tz: "UTC" } : null,
      schedule: scheduled
        ? {
            id: idAt("8d01", index),
            cron: "0 8 * * 1",
            timezone: "UTC",
            paused: status === "stopped",
            execution_mode: "prod",
            admission_hold:
              status === "waiting_approval"
                ? { reason_code: "execution_authority_required", observed_at: UPDATED }
                : null,
            state: scheduleState,
            next_fire_at: scheduleState === "active" ? "2026-10-12T08:00:00.000Z" : null,
            last_enqueued_at: null,
          }
        : null,
      webhooks_active: 0,
      effective_trigger: scheduled
        ? { kind: "schedule", source: "binding", state: scheduleState }
        : { kind: "request", source: "default", state: "active" },
    };
  });
}

function connectorRows(tenantId) {
  return [
    {
      slug: "evidence-mcp-known",
      display_name: "Evidence MCP seven",
      driver: "mcp",
      auth_type: "none",
      tools_count: 7,
      last_tested_at: TESTED,
    },
    {
      slug: "evidence-mcp-unknown",
      display_name: "Evidence MCP unknown",
      driver: "mcp",
      auth_type: "none",
      tools_count: null,
      last_tested_at: null,
    },
    {
      slug: "evidence-mcp-empty",
      display_name: "Evidence MCP zero",
      driver: "mcp",
      auth_type: "none",
      tools_count: 0,
      last_tested_at: TESTED,
    },
    {
      slug: "evidence-oauth",
      display_name: "Evidence OAuth",
      driver: "http",
      auth_type: "oauth2",
      tools_count: null,
      last_tested_at: TESTED,
    },
    {
      slug: "evidence-key",
      display_name: "Evidence header key",
      driver: "http",
      auth_type: "header",
      tools_count: null,
      last_tested_at: null,
    },
    {
      slug: "evidence-mcp-oauth",
      display_name: "Evidence authenticated MCP",
      driver: "mcp",
      auth_type: "oauth2",
      tools_count: null,
      last_tested_at: null,
    },
    {
      slug: "evidence-public",
      display_name: "Evidence public HTTP",
      driver: "http",
      auth_type: "none",
      tools_count: null,
      last_tested_at: null,
    },
  ].map((specific, index) => ({
    id: idAt("8c01", index),
    tenant_id: tenantId,
    description: `Connector example ${index + 1}`,
    description_source: index % 2 === 1 ? "llm" : "human",
    category: categoryAt(index),
    category_source: "human",
    environment: "prod",
    base_url: `https://${specific.slug}.example.test`,
    dsn: null,
    config: specific.driver === "mcp" ? { mcp: { transport: "http" } } : {},
    operator_quirks: {},
    template_slug: null,
    template_name: null,
    template_source: null,
    template_version: null,
    template_snapshot: null,
    enabled: true,
    last_error: null,
    health_state: index === 3 ? "needs_reauth" : "ok",
    health_reason: null,
    health_error_code: null,
    circuit_state: "closed",
    circuit_opened_at: null,
    circuit_failure_count: 0,
    needs_reauth: index === 3,
    auth_failed_at: index === 3 ? UPDATED : null,
    auth_failed_reason: null,
    sign_in:
      index === 3
        ? { kind: "oauth", start: `/v1/connectors/${idAt("8c01", index)}/oauth/start` }
        : null,
    created_at: CREATED,
    updated_at: UPDATED,
    ...specific,
  }));
}

function categoriesFor(rows) {
  return ["finance", "support", "other"].map((category) => ({
    category,
    count: rows.filter((row) => row.category === category).length,
  }));
}

function kindMatches(row, kind) {
  if (!kind) return true;
  if (kind === "mcp") return row.driver === "mcp";
  if (kind === "oauth")
    return (
      row.driver !== "mcp" &&
      ["oauth2", "oauth2_client", "oauth2_private_key"].includes(row.auth_type)
    );
  if (kind === "key")
    return (
      row.driver !== "mcp" &&
      ["header", "query", "bearer", "basic", "aws_sigv4"].includes(row.auth_type)
    );
  throw new Error(`Unexpected connector kind ${kind}`);
}

function visibleRows(page) {
  return page.getByTestId(/^data-table-(?:mobile-)?row-\d+$/).filter({ visible: true });
}

async function contains(locator, expected, context) {
  await locator.filter({ hasText: expected }).waitFor({ state: "visible" });
  require((await locator.innerText()).includes(expected), `${context}: missing ${expected}`);
}

async function choose(page, testId, value) {
  await page.getByTestId(testId).click();
  await page.getByTestId(`${testId}-option-${value}`).click();
}

export async function verifyCatalogEvidence(page, stand, locale, capture, { tenantId }) {
  require(typeof tenantId === "string", "Catalog fixtures need the canonical tenant ID");
  require(WORKFLOW_OPERATING_STATUSES.length === Object.keys(STATUS_KEYS).length &&
    WORKFLOW_OPERATING_STATUSES.every(
      (status) => status in STATUS_KEYS,
    ), "Catalog fixture must cover every shared operating status");
  const t = (key, values) => translate(locale, key, values);
  const workflow = workflowRows(tenantId);
  const connector = connectorRows(tenantId);
  const requests = [];
  const categoryResponse = ["finance", "support", "other"].map((category) => {
    const counts = {
      workflow: workflow.filter((row) => row.category === category).length,
      connector: connector.filter((row) => row.category === category).length,
      knowledge_source: 0,
      skill: 0,
      file: 0,
    };
    return {
      category,
      total: counts.workflow + counts.connector,
      counts,
      llm_counts: {
        workflow: workflow.filter(
          (row) => row.category === category && row.description_source === "llm",
        ).length,
        connector: connector.filter(
          (row) => row.category === category && row.description_source === "llm",
        ).length,
        knowledge_source: 0,
        skill: 0,
        file: 0,
      },
    };
  });
  const handler = async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const url = new URL(route.request().url());
    if (url.pathname === "/v1/categories")
      return route.fulfill({ json: { categories: categoryResponse } });
    const source =
      url.pathname === "/v1/workflows"
        ? workflow
        : url.pathname === "/v1/connectors"
          ? connector
          : null;
    if (!source) return route.fallback();
    const query = Object.fromEntries(url.searchParams);
    const filtered = source.filter(
      (row) =>
        (!query.operating_status || row.operating_status === query.operating_status) &&
        (!query.description_source || row.description_source === query.description_source) &&
        (!query.category || row.category === query.category) &&
        kindMatches(row, query.kind),
    );
    const offset = Number(query.offset ?? 0);
    const items = filtered.slice(offset, offset + Number(query.limit ?? 25));
    requests.push({ path: url.pathname, query, ids: items.map((row) => row.id) });
    return route.fulfill({
      json: { items, total: filtered.length, categories: categoriesFor(source) },
    });
  };
  async function expectRows(resource, expected, query, requestStart = null) {
    await page
      .getByTestId("catalog-summary")
      .filter({
        hasText: t(`resource.${resource}.summary.${expected.length === 1 ? "one" : "other"}`, {
          count: expected.length,
        }),
      })
      .waitFor({ state: "visible" });
    for (const item of expected)
      await contains(
        visibleRows(page).filter({ hasText: title(item) }),
        title(item),
        "catalog result row",
      );
    require((await visibleRows(page).count()) ===
      expected.length, "Catalog result must contain exactly the filtered records");
    if (requestStart !== null)
      require(requests
        .slice(requestStart)
        .some(
          (request) =>
            request.path === `/v1/${resource}` &&
            Object.entries(query).every(([key, value]) => (request.query[key] ?? null) === value) &&
            request.ids.join("|") === expected.map((item) => item.id).join("|"),
        ), "First-use catalog filter must reach the API after its action and return the expected records");
  }
  async function resetRows(resource, rows) {
    await page.getByTestId("catalog-clear-filters").click();
    await expectRows(resource, rows, {});
    const query = new URL(page.url()).searchParams;
    require([
      "operating_status",
      "category",
      "kind",
      "q",
      "connector",
      "health",
      "description_source",
    ].every((key) => !query.has(key)), "Reset must remove all catalog URL filters");
  }
  await page.route(ROUTE, handler);
  try {
    await stand.visit(page, "workflows");
    await expectRows("workflows", workflow, { operating_status: null });
    await contains(
      page.getByTestId("catalog-categories-open"),
      t("catalogCategories.summary.other", { count: 2 }),
      "category count",
    );
    await contains(
      page.getByTestId("catalog-summary"),
      t("catalog.aiCount", { count: 4 }),
      "workflow AI count",
    );
    const active = visibleRows(page).filter({ hasText: "Evidence active" });
    await contains(active, t("catalogMeta.empty"), "missing description placeholder");
    const day = new Intl.DateTimeFormat(LOCALE_TAGS[locale], {
      weekday: "long",
      timeZone: "UTC",
    }).format(new Date("2024-01-01T12:00:00.000Z"));
    await contains(
      active,
      `${t("workflows.trigger.schedule")} · ${t("cron.weekly", { day, time: "08:00" })}`,
      "saved schedule rhythm",
    );
    await capture("catalog-workflows-all");
    for (const status of WORKFLOW_OPERATING_STATUSES) {
      const requestStart = requests.length;
      await choose(page, "catalog-status-filter", status);
      const selected = workflow.filter((row) => row.operating_status === status);
      await expectRows("workflows", selected, { operating_status: status }, requestStart);
      await contains(visibleRows(page), t(STATUS_KEYS[status]), "positive operating status");
      await capture(`catalog-status-${status}`);
    }
    await resetRows("workflows", workflow);

    for (const [resource, rows, aiCount] of [
      ["workflows", workflow, 4],
      ["connectors", connector, 3],
    ]) {
      await stand.visit(page, resource);
      await expectRows(resource, rows, { description_source: null, category: null });
      await contains(
        page.getByTestId("catalog-categories-open"),
        t("catalogCategories.summary.other", { count: 2 }),
        "category count",
      );
      await contains(
        page.getByTestId("catalog-summary"),
        t("catalog.aiCount", { count: aiCount }),
        "AI count",
      );
      await page.getByTestId("catalog-categories-open").click();
      await contains(
        page.getByTestId("catalog-categories-sheet"),
        "Finance",
        "category link target",
      );
      await capture(`catalog-${resource}-categories`);
      await page
        .getByTestId("catalog-categories-sheet")
        .locator('[data-slot="sheet-close"]')
        .click();
      const originRequestStart = requests.length;
      await page.getByTestId("catalog-origin-llm").click();
      await expectRows(
        resource,
        rows.filter((row) => row.description_source === "llm"),
        { description_source: "llm" },
        originRequestStart,
      );
      await capture(`catalog-${resource}-ai`);
      await resetRows(resource, rows);
      const categoryRequestStart = requests.length;
      await choose(page, "catalog-category-filter", "finance");
      await expectRows(
        resource,
        rows.filter((row) => row.category === "finance"),
        { category: "finance" },
        categoryRequestStart,
      );
      await capture(`catalog-${resource}-category`);
      await resetRows(resource, rows);
    }
    for (const kind of ["oauth", "mcp", "key"]) {
      const requestStart = requests.length;
      const expected = EXPECTED_KIND_SLUGS[kind].map((slug) => {
        const row = connector.find((candidate) => candidate.slug === slug);
        require(row, `Missing independently expected fixture ${slug}`);
        return row;
      });
      await choose(page, "catalog-kind-filter", kind);
      await expectRows("connectors", expected, { kind }, requestStart);
      await capture(`catalog-connector-kind-${kind}`);
    }
    await resetRows("connectors", connector);
    for (const [name, count] of [
      ["Evidence MCP seven", 7],
      ["Evidence MCP zero", 0],
    ])
      await contains(
        visibleRows(page).filter({ hasText: name }),
        t("connectorDetail.tools.count.other", { count }),
        "saved MCP tool count",
      );
    const unknown = visibleRows(page).filter({ hasText: "Evidence MCP unknown" });
    require(!/\b\d+\s+(?:tools|Werkzeuge)\b/i.test(
      await unknown.innerText(),
    ), "Unknown tool count must not become an invented number");
    const desktop = await page.getByTestId("data-table-row-0").isVisible();
    if (desktop) {
      await page
        .getByRole("columnheader", { name: t("catalog.tested"), exact: true })
        .waitFor({ state: "visible" });
      const date = await page.evaluate(
        ({ value, tag }) =>
          new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }).format(
            new Date(value),
          ),
        { value: TESTED, tag: LOCALE_TAGS[locale] },
      );
      const differentDate = await page.evaluate(
        ({ value, tag }) =>
          new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }).format(
            new Date(value),
          ),
        { value: UPDATED, tag: LOCALE_TAGS[locale] },
      );
      const known = visibleRows(page).filter({ hasText: "Evidence MCP seven" });
      await contains(known, date, "recorded probe date");
      require(!(await known.innerText()).includes(
        differentDate,
      ), "Probe date must not substitute update date");
      await contains(unknown.locator("td").nth(3), "—", "unknown retained probe");
    }
    await capture("catalog-connector-recorded-facts");
  } finally {
    await page.unroute(ROUTE, handler);
  }
}
