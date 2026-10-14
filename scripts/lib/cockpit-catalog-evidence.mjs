import { LOCALE_TAGS, translate } from "../../apps/cockpit/src/lib/i18n.ts";
import { WORKFLOW_OPERATING_STATUSES } from "../../packages/shared/src/workflow-operating-status.ts";
import { closeRecordSheet } from "./cockpit-record-sheet.mjs";

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
const FILTERABLE_WORKFLOW_STATUSES = [
  "active",
  "waiting_approval",
  "waiting_connector",
  "failing",
  "stopped",
  "repair_required",
  "unapproved",
  "disabled",
];
const categoryAt = (index) => ["finance", "support", "other"][index % 3];
const idAt = (kind, index) => `0a738614-5c4f-4a53-${kind}-${String(index + 1).padStart(12, "0")}`;
const EXPECTED_KIND_SLUGS = {
  oauth: ["evidence-oauth"],
  mcp: ["evidence-mcp-known", "evidence-mcp-unknown", "evidence-mcp-empty", "evidence-mcp-oauth"],
  key: ["evidence-key"],
};
const SKILLS_SUMMARY_HELP_SENTENCES = {
  de: "Beschreibung und Kategorie helfen der KI, die passenden Skills zu finden.",
  en: "Description and category help the AI find the right skills.",
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

function visibleRowsFor(page, collectionId) {
  return page
    .getByTestId(new RegExp(`^${collectionId}-(?:mobile-)?row-\\d+$`))
    .filter({ visible: true });
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
  const knowledgeSource = ["human", "llm"].map((descriptionSource, index) => ({
    id: idAt("8e01", index),
    tenant_id: tenantId,
    name: `Evidence source ${descriptionSource}`,
    slug: `evidence-source-${descriptionSource}`,
    description: `Evidence ${descriptionSource} description`,
    description_source: descriptionSource,
    category: "finance",
    category_source: "human",
    tags: [],
    scope: "global",
    workflow_id: null,
    status: "active",
    last_error: null,
    source_type: "inline_text",
    source_uri: `evidence://${descriptionSource}`,
    mime_type: "text/markdown",
    version: "1",
    bytes_total: 120,
    chunk_count: index + 2,
    refresh_strategy: "manual",
    refresh_cron: null,
    last_refreshed_at: null,
    created_at: CREATED,
    updated_at: UPDATED,
  }));
  const skill = ["human", "llm"].map((descriptionSource, index) => ({
    id: idAt("8f01", index),
    tenant_id: tenantId,
    scope: "global",
    connector_id: null,
    workflow_id: null,
    slug: `evidence-skill-${descriptionSource}`,
    title: `Evidence skill ${descriptionSource}`,
    description: `Evidence ${descriptionSource} description`,
    description_source: descriptionSource,
    category: "finance",
    category_source: "human",
    body: "# Evidence skill",
    examples: [],
    best_practices: [],
    pitfalls: [],
    doc_refs: [],
    gates_tools: [],
    activates_when: [],
    input_schema: null,
    output_schema: null,
    side_effects: "read",
    idempotency: "none",
    maturity: "stable",
    tags: [],
    applies_to: index === 1 ? null : "both",
    status: "active",
    source: "manual",
    version: 1,
    created_at: CREATED,
    updated_at: UPDATED,
  }));
  const file = ["human", "llm"].map((descriptionSource, index) => ({
    id: idAt("9001", index),
    status: "ready",
    filename: `evidence-file-${descriptionSource}.md`,
    content_type: "text/markdown",
    size_bytes: (index + 1) * 120,
    sha256: null,
    scan_result: "clean",
    created_by: null,
    creator: null,
    created_at: CREATED,
    updated_at: UPDATED,
    replaced_at: null,
    deleted_at: null,
    slug: `evidence-file-${descriptionSource}`,
    reference: `@attachment:evidence-file-${descriptionSource}`,
    description: `Evidence ${descriptionSource} description`,
    description_source: descriptionSource,
    category: "finance",
    category_source: "human",
    usage: { workflows: 0, conversations: 0 },
  }));
  const resourcesByPath = {
    "/v1/workflows": workflow,
    "/v1/connectors": connector,
    "/v1/knowledge-sources": knowledgeSource,
    "/v1/skills": skill,
    "/v1/files": file,
  };
  const resourcesByKind = {
    workflow,
    connector,
    knowledge_source: knowledgeSource,
    skill,
    file,
  };
  const requests = [];
  const categoryResponse = ["finance", "support", "other"].map((category) => {
    const counts = Object.fromEntries(
      Object.entries(resourcesByKind).map(([kind, rows]) => [
        kind,
        rows.filter((row) => row.category === category).length,
      ]),
    );
    return {
      category,
      purpose: category === "finance" ? "Invoices and receipts" : null,
      purpose_source: category === "finance" ? "llm" : null,
      aliases: category === "finance" ? ["Accounting"] : [],
      revision: category === "finance" ? 3 : category === "support" ? 7 : null,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      counts,
      llm_counts: Object.fromEntries(
        Object.entries(resourcesByKind).map(([kind, rows]) => [
          kind,
          rows.filter(
            (row) =>
              row.category === category &&
              row.description_source === "llm" &&
              row.description?.trim(),
          ).length,
        ]),
      ),
    };
  });
  const categoryWrites = [];
  const handler = async (route) => {
    const url = new URL(route.request().url());
    if (route.request().method() === "POST" && url.pathname === "/v1/categories/finance/rename") {
      const body = route.request().postDataJSON();
      categoryWrites.push(body);
      if (body.to === "support")
        return route.fulfill({
          status: 409,
          json: { code: "conflict", message: "Category changed" },
        });
      const category = categoryResponse.find((item) => item.category === "finance");
      category.purpose = body.purpose;
      category.purpose_source = body.purpose ? "human" : null;
      category.aliases = body.aliases;
      category.revision += 1;
      return route.fulfill({
        json: { purpose_generation: body.purpose ? "not_requested" : "pending" },
      });
    }
    if (route.request().method() !== "GET") return route.fallback();
    if (url.pathname === "/v1/categories")
      return route.fulfill({ json: { categories: categoryResponse } });
    if (url.pathname === "/v1/skill-candidates")
      return route.fulfill({ json: { items: [], total: 0, next_cursor: null } });
    const skillDetail = skill.find((row) => url.pathname === `/v1/skills/${row.id}`);
    if (skillDetail) return route.fulfill({ json: skillDetail });
    const source = resourcesByPath[url.pathname];
    if (!source) return route.fallback();
    const query = Object.fromEntries(url.searchParams);
    const filtered = source.filter(
      (row) =>
        (!query.operating_status || row.operating_status === query.operating_status) &&
        (!query.description_source || row.description_source === query.description_source) &&
        (!query.category || row.category === query.category) &&
        (!query.q ||
          [row.name, row.title, row.filename, row.description]
            .filter(Boolean)
            .some((value) => value.toLowerCase().includes(query.q.toLowerCase()))) &&
        kindMatches(row, query.kind),
    );
    const offset = Number(query.offset ?? 0);
    const items = filtered.slice(offset, offset + Number(query.limit ?? 25));
    requests.push({ path: url.pathname, query, ids: items.map((row) => row.id) });
    return route.fulfill({
      json: {
        items,
        total: filtered.length,
        ...(url.pathname === "/v1/knowledge-sources"
          ? { sections_total: items.reduce((sum, row) => sum + row.chunk_count, 0) }
          : {}),
        ...(url.pathname === "/v1/workflows" || url.pathname === "/v1/connectors"
          ? { categories: categoriesFor(source) }
          : {}),
      },
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
    const workflowLastRunHeader = page
      .getByTestId("data-table-desktop")
      .getByRole("columnheader", { name: t("catalog.lastRun"), exact: true })
      .filter({ visible: true });
    require((await workflowLastRunHeader.count()) ===
      1, "Workflow catalog must retain one visible exact Last run column header");
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
    const missingDescription = active.getByText(t("catalogMeta.empty"), { exact: true });
    require((await missingDescription.count()) ===
      1, "A workflow with no description must render exactly one exact localized placeholder in its catalog row");
    await missingDescription.waitFor({ state: "visible" });
    const workflowStatusHeader = page
      .getByTestId("data-table-desktop")
      .getByRole("columnheader", { name: t("catalog.status"), exact: true })
      .filter({ visible: true });
    require((await workflowStatusHeader.count()) ===
      1, "Workflow catalog must render exactly one visible Status column header");
    await page.getByTestId("catalog-status-filter").click();
    const statusOptions = page
      .locator('[data-testid^="catalog-status-filter-option-"]')
      .filter({ visible: true });
    const actualStatusOptions = (await statusOptions.allTextContents()).map((label) =>
      label.trim(),
    );
    const expectedStatusOptions = [
      t("catalog.allStatuses"),
      ...FILTERABLE_WORKFLOW_STATUSES.map((status) => t(STATUS_KEYS[status])),
    ];
    require(actualStatusOptions.length === expectedStatusOptions.length &&
      actualStatusOptions.join("|") ===
        expectedStatusOptions.join(
          "|",
        ), `Workflow status filter must expose the eight selectable workflow statuses in order; got ${JSON.stringify(await statusOptions.evaluateAll((items) => items.map((item) => ({ id: item.getAttribute("data-testid"), text: item.textContent?.trim() }))))}`);
    await page.keyboard.press("Escape");
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
    for (const status of FILTERABLE_WORKFLOW_STATUSES) {
      const requestStart = requests.length;
      await choose(page, "catalog-status-filter", status);
      const selected = workflow.filter((row) => row.operating_status === status);
      await expectRows("workflows", selected, { operating_status: status }, requestStart);
      const statusCell = visibleRows(page)
        .filter({ hasText: title(selected[0]) })
        .locator("td")
        .nth(2);
      require((await statusCell.innerText())
        .trim()
        .startsWith(
          t(STATUS_KEYS[status]),
        ), `Workflow ${status} must render its mapped status label in the Status column`);
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
      const sheet = page.getByTestId("catalog-categories-sheet");
      const categoryLabels = (await sheet.locator("li span.font-medium").allTextContents()).map(
        (label) => label.trim(),
      );
      const expectedCategoryLabels = ["Finance", "Support", t("catalog.categoryOther")];
      require(categoryLabels.length === expectedCategoryLabels.length &&
        new Set(categoryLabels).size === expectedCategoryLabels.length &&
        expectedCategoryLabels.every((label) =>
          categoryLabels.includes(label),
        ), `Category sheet must list each fixture category exactly once; got ${JSON.stringify(categoryLabels)}`);
      await contains(sheet, "Finance", "category link target");
      await capture(`catalog-${resource}-categories`);
      if (resource === "workflows") {
        const search = page.getByTestId("catalog-categories-search");
        for (const text of ["Invoices", "Accounting", "finance"]) {
          await search.fill(text);
          await contains(sheet.locator("li"), "Finance", "category metadata search");
          require((await sheet.locator("li").count()) ===
            1, "Purpose and alias search must narrow the category list");
        }
        await sheet.getByTestId("catalog-category-edit").click();
        const dialog = page.getByTestId("catalog-category-dialog");
        require((await page.getByTestId("catalog-category-name").inputValue()) === "finance" &&
          (await page.getByTestId("catalog-category-purpose").inputValue()) ===
            "Invoices and receipts" &&
          (await page.getByTestId("catalog-category-aliases").inputValue()) ===
            "Accounting", "Editing Finance must preload its exact name, purpose, and aliases");
        await contains(
          dialog.getByTestId("catalog-category-origin"),
          t("catalogCategories.originAI"),
          "AI purpose adoption hint",
        );
        await dialog.getByRole("button", { name: t("common.save"), exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        require(categoryWrites[0]?.purpose === "Invoices and receipts" &&
          categoryWrites[0]?.expected_source_revision === 3 &&
          categoryWrites[0]?.expected_target_revision ===
            3, "Adopting AI purpose must retain text and both reviewed revisions");
        await sheet.getByTestId("catalog-category-edit").click();
        await page.getByTestId("catalog-category-purpose").fill("");
        await dialog.getByRole("button", { name: t("common.save"), exact: true }).click();
        await dialog.waitFor({ state: "hidden" });
        require(categoryWrites[1]?.purpose === null &&
          categoryWrites[1]?.expected_source_revision ===
            4, "Blank purpose must request generation against the current revision");
        await search.fill("finance");
        await sheet.getByTestId("catalog-category-edit").click();
        await page.getByTestId("catalog-category-name").fill("support");
        await contains(
          dialog.getByTestId("catalog-category-merge"),
          t("catalogCategories.mergeNoPurpose"),
          "merge target purpose consequence",
        );
        await dialog.getByRole("button", { name: t("common.save"), exact: true }).click();
        await dialog.getByRole("alert").waitFor({ state: "visible" });
        require(categoryWrites[2]?.expected_source_revision === 5 &&
          categoryWrites[2]?.expected_target_revision ===
            7, "Merge must carry both displayed revisions");
        require(await dialog
          .getByRole("button", { name: t("common.save"), exact: true })
          .isDisabled(), "Conflicting edit must not automatically retry");
        await dialog
          .getByRole("button", { name: t("catalogCategories.reload"), exact: true })
          .click();
        await dialog
          .locator('input[data-testid="catalog-category-name"][value="finance"]')
          .waitFor();
        require((await page.getByTestId("catalog-category-name").inputValue()) ===
          "finance", "Explicit conflict reload must return to reviewed source metadata");
        await dialog.getByRole("button", { name: t("common.close"), exact: true }).click();
        await search.fill("");
      }
      await closeRecordSheet(page.getByTestId("catalog-categories-sheet"));
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
    await page.getByTestId("catalog-kind-filter").click();
    const kindOptions = page
      .locator('[data-testid^="catalog-kind-filter-option-"]')
      .filter({ visible: true });
    const actualKindOptions = (await kindOptions.allTextContents()).map((label) => label.trim());
    const expectedKindOptions = [
      t("catalog.kindAll"),
      t("catalog.kind.oauth"),
      t("catalog.kind.mcp"),
      t("catalog.kind.key"),
    ];
    require(actualKindOptions.length === expectedKindOptions.length &&
      actualKindOptions.join("|") ===
        expectedKindOptions.join(
          "|",
        ), `Connector kind filter must expose All, OAuth, MCP, and key exactly; got ${JSON.stringify(actualKindOptions)}`);
    await page.keyboard.press("Escape");
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
      const testedLabel = locale === "de" ? "Geprüft" : "Tested";
      require(t("catalog.tested") ===
        testedLabel, `Connector catalog tested label must be ${testedLabel} in ${locale}`);
      await page
        .getByTestId("data-table-desktop")
        .getByRole("columnheader", { name: testedLabel, exact: true })
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
      const expectedMcpType = `${t("catalog.kind.mcp")} · ${t("connectorDetail.tools.count.other", { count: 7 })}`;
      require((await known.locator("td").nth(1).innerText()).trim() ===
        expectedMcpType, `Connector Type cell must be exactly ${expectedMcpType}`);
      await contains(known, date, "recorded probe date");
      require(!(await known.innerText()).includes(
        differentDate,
      ), "Probe date must not substitute update date");
      await contains(unknown.locator("td").nth(3), "—", "unknown retained probe");
    }
    await capture("catalog-connector-recorded-facts");

    for (const [route, endpoint, rows, kind, summaryTestId] of [
      [
        "knowledge",
        "/v1/knowledge-sources",
        knowledgeSource,
        "knowledge_source",
        "knowledge-summary",
      ],
      ["skills", "/v1/skills", skill, "skill", "skills-summary"],
      ["files", "/v1/files", file, "file", "files-summary"],
    ]) {
      await stand.visit(page, route);
      const summary = page.getByTestId(summaryTestId);
      const totalLabel =
        kind === "knowledge_source"
          ? `${t("knowledge.summary.other", { count: rows.length })} · ${t("knowledge.sections.other", { count: 5 })}`
          : kind === "skill"
            ? t("skills.summary.other", { count: rows.length })
            : t("files.summary.other", { count: rows.length, size: "360 B" });
      await contains(summary, totalLabel, `${route} summary count`);
      await contains(
        page.getByTestId("catalog-categories-open"),
        t("catalogCategories.summary.one", { count: 1 }),
        `${route} category count`,
      );
      await contains(summary, t("catalog.aiCount", { count: 1 }), `${route} AI count`);
      const resourceRows = visibleRowsFor(
        page,
        route === "knowledge" ? "knowledge-sources" : route,
      );
      if (route === "skills") {
        const help = page.getByTestId("skills-summary-help");
        await help.waitFor({ state: "visible" });
        const helpDescription = await page
          .locator(`[id="${await help.getAttribute("aria-describedby")}"]`)
          .textContent();
        const expectedHelpSentence = SKILLS_SUMMARY_HELP_SENTENCES[locale];
        require(typeof expectedHelpSentence === "string" &&
          helpDescription?.includes(
            expectedHelpSentence,
          ), `Skills help must state how description and category help AI find suitable skills in ${locale}`);
        require(helpDescription ===
          t(
            "skills.summaryHelp",
          ), "Skills help must include the full saved description and category guidance");
        const headers = await page
          .getByTestId("catalog-skills")
          .locator("thead tr")
          .first()
          .locator('th:not(:has(.sr-only)):not([aria-hidden="true"])')
          .allTextContents();
        require(headers
          .map((value) => value.trim())
          .filter(Boolean)
          .join("|") ===
          [
            t("skills.column.name"),
            t("resource.field.status"),
            t("skills.column.scope"),
            t("skills.column.where"),
            t("skills.column.changed"),
          ].join(
            "|",
          ), `Skills table must retain the exact five Cockpit data columns in order; got ${JSON.stringify(headers)}`);
        const emptyWhereRow = resourceRows.filter({ hasText: skill[1].title });
        require((await emptyWhereRow.locator("td").nth(3).innerText()).trim() ===
          "—", "A missing applies_to value must render as an em dash, without deriving from scope");
      }
      const rowName = (row) => row.name ?? row.title ?? row.filename;
      await contains(
        resourceRows.filter({ hasText: rowName(rows[0]) }),
        rowName(rows[0]),
        `${route} human row`,
      );
      await contains(
        resourceRows.filter({ hasText: rowName(rows[1]) }),
        rowName(rows[1]),
        `${route} AI row`,
      );
      const requestStart = requests.length;
      await page.getByTestId("catalog-origin-llm").click();
      const aiRows = rows.filter((row) => row.description_source === "llm");
      await contains(
        resourceRows.filter({ hasText: rowName(aiRows[0]) }),
        rowName(aiRows[0]),
        `${route} filtered AI row`,
      );
      require((await resourceRows.count()) ===
        1, `${route} AI filter must leave only AI-origin records`);
      require(requests
        .slice(requestStart)
        .some(
          (request) =>
            request.path === endpoint &&
            request.query.description_source === "llm" &&
            request.ids.join("|") === aiRows.map((row) => row.id).join("|"),
        ), `${route} AI filter must reach the correct API endpoint and return only AI-origin records`);
      await page.getByTestId("catalog-origin-all").click();
      await contains(
        resourceRows.filter({ hasText: rowName(rows[0]) }),
        rowName(rows[0]),
        `${route} restored human row`,
      );
      await contains(
        resourceRows.filter({ hasText: rowName(rows[1]) }),
        rowName(rows[1]),
        `${route} restored AI row`,
      );
      require((await resourceRows.count()) === 2, `${route} all filter must restore every record`);
      if (route === "knowledge" || route === "skills") {
        const collectionId = route === "knowledge" ? "knowledge-sources" : "skills";
        const searchId = route === "knowledge" ? "knowledge-search" : "skills-search";
        const noMatch = "catalog-evidence-no-match";
        const emptyRequestStart = requests.length;
        await page.getByTestId("catalog-origin-llm").click();
        await choose(page, "catalog-category-filter", "finance");
        await page.getByTestId(searchId).fill(noMatch);
        const filteredEmpty = page.locator(`[data-testid="${collectionId}-empty"]:visible`);
        await contains(filteredEmpty, t("resource.noMatches"), `${route} filtered empty state`);
        require(!(await filteredEmpty.innerText()).includes(
          t(route === "knowledge" ? "knowledge.empty" : "skills.empty"),
        ), `${route} filtered results must not show the zero-state message`);
        require((await resourceRows.count()) ===
          0, `${route} combined filters must leave no fixture rows`);
        require(requests
          .slice(emptyRequestStart)
          .some(
            (request) =>
              request.path === endpoint &&
              request.query.category === "finance" &&
              request.query.q === noMatch &&
              request.query.description_source === "llm" &&
              request.ids.length === 0,
          ), `${route} combined category and search filters must reach the API`);

        const resetRequestStart = requests.length;
        await page.locator(`[data-testid="${collectionId}-reset-filters"]:visible`).click();
        await contains(
          resourceRows.filter({ hasText: rowName(rows[0]) }),
          rowName(rows[0]),
          `${route} reset human row`,
        );
        await contains(
          resourceRows.filter({ hasText: rowName(rows[1]) }),
          rowName(rows[1]),
          `${route} reset AI row`,
        );
        require((await resourceRows.count()) ===
          rows.length, `${route} reset must restore every fixture row`);
        require((await page.getByTestId(searchId).inputValue()) ===
          "", `${route} reset must clear the search field`);
        await contains(
          page.getByTestId("catalog-category-filter"),
          t("catalog.allCategories"),
          `${route} reset category selection`,
        );
        require((await page.getByTestId("catalog-origin-all").getAttribute("data-state")) ===
          "on", `${route} reset must restore the All origin filter`);
        await page.reload();
        await contains(
          resourceRows.filter({ hasText: rowName(rows[0]) }),
          rowName(rows[0]),
          `${route} reloaded human row after reset`,
        );
        require(requests
          .slice(resetRequestStart)
          .some(
            (request) =>
              request.path === endpoint &&
              !request.query.category &&
              !request.query.q &&
              !request.query.description_source &&
              request.ids.join("|") === rows.map((row) => row.id).join("|"),
          ), `${route} reset followed by reload must request all fixtures without filters`);
      }
      if (route === "files") {
        const noMatch = "catalog-evidence-no-match";
        await page.getByTestId("files-search").fill(noMatch);
        const filteredFilesEmpty = page
          .getByTestId("files-page")
          .getByTestId("files-empty")
          .filter({ visible: true, hasText: t("resource.noMatches") })
          .first();
        await filteredFilesEmpty.waitFor({ state: "visible" });
        require((await visibleRowsFor(page, "files").count()) ===
          0, "Filtered files fixture must have no rows");
        await page.getByTestId("files-upload").waitFor({ state: "visible" });
        await page
          .getByTestId("files-page")
          .getByTestId("files-reset-filters")
          .filter({ visible: true })
          .first()
          .click();
        await contains(
          visibleRowsFor(page, "files").filter({ hasText: rowName(rows[0]) }),
          rowName(rows[0]),
          "files restored after reset",
        );
      }
      await capture(`catalog-${route}-origin-summary`);
    }
  } finally {
    await page.unroute(ROUTE, handler);
  }
}
