import { RUNS_FILTER_PARAMS } from "../../apps/cockpit/src/app/links.ts";
import { translate } from "../../apps/cockpit/src/lib/i18n.ts";
import { assertNoTooltipWithoutHover } from "./cockpit-unprompted-tooltip.mjs";

const COPY = {
  de: {
    summary: "240 Läufe in 7 Tagen · 120 fehlgeschlagen",
    total: "240 Läufe in 7 Tagen",
    customSummary: "240 Läufe · 120 fehlgeschlagen",
    runningStepTotal: "Schritt 1 von 4",
  },
  en: {
    summary: "240 runs in 7 days · 120 failed",
    total: "240 runs in 7 days",
    customSummary: "240 runs · 120 failed",
    runningStepTotal: "Step 1 of 4",
  },
};

const FILTER_KEYS = [
  "runs_workflow",
  "runs_status",
  "runs_source",
  "runs_q",
  "runs_from",
  "runs_to",
];

async function summaryReads(page, expected, where, why, includeWindowLabel = false) {
  const summary = page.locator('[data-testid="runs-summary"]');
  await summary.waitFor({ state: "visible", timeout: 5000 }).catch((error) => {
    throw new Error(`${where}: ${why} — the summary line is gone`, { cause: error });
  });
  const window = page.getByTestId("runs-window-filter");
  await window.waitFor({ state: "visible" });
  const label = (await window.innerText()).trim();
  if (!label) throw new Error(`${where}: the default time window has no readable label`);
  const fullExpected = includeWindowLabel ? `${expected} · ${label}` : expected;
  await page
    .waitForFunction(
      (text) =>
        document.querySelector('[data-testid="runs-summary"]')?.textContent?.trim() === text,
      fullExpected,
      { timeout: 5000 },
    )
    .catch(async (error) => {
      throw new Error(
        `${where}: ${why} — "${(await summary.innerText()).trim()}", expected "${fullExpected}"`,
        { cause: error },
      );
    });
}

export async function verifyRunSheet(page, stand, uuid, language, where) {
  const copy = COPY[language];
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;

  await stand.visit(page, `?run=${uuid}`);
  await page.locator('[data-testid="run-detail-error"]').waitFor({ state: "visible" });
  await page.getByTestId("run-detail").waitFor({ state: "visible" });

  await page
    .locator(
      wide
        ? '[data-testid="run-detail-step-list-row-0"] td >> nth=1'
        : '[data-testid="run-detail-step-list-mobile-row-0"]',
    )
    .click();
  await page
    .locator('[data-testid="run-step-sheet"]')
    .waitFor({ state: "visible", timeout: 3000 })
    .catch((error) => {
      throw new Error(`${where}: a step row with a chevron did not open its step`, {
        cause: error,
      });
    });
  await page.locator('[data-testid="run-step-close"]').click();
  await page.locator('[data-testid="run-step-sheet"]').waitFor({ state: "hidden" });
  await page.locator('[data-testid="run-detail"]').waitFor({ state: "visible" });

  const runningId = "018f4b4a-6d33-7b3a-9c2d-123456789ab9";
  const startedAt = new Date(Date.now() - 60_000).toISOString();
  const runningDetail = {
    id: runningId,
    workflow_id: uuid,
    workflow_name: "Identity progress fixture",
    workflow_version_id: "018f4b4a-6d33-7b3a-9c2d-123456789ab8",
    execution_authority_id: null,
    hold_writes: false,
    source_kind: "saved",
    source_ref: null,
    status: "running",
    request_source: "api",
    caller: {
      kind: "user",
      principal_id: uuid,
      provider: null,
      product_id: null,
      verified_by: null,
      channel: "api",
      origin_execution_id: null,
    },
    parent_execution_id: null,
    started_at: startedAt,
    finished_at: null,
    created_at: startedAt,
    trace_id: null,
    outcome: {
      kind: "running",
      failed_step: null,
      cause_class: null,
      error_code: null,
      connector: null,
      steps: { total: 1, succeeded: 0, failed: 0, held: 0, skipped: 0 },
      output_contract: "none",
      planned_steps: 4,
    },
  };
  const runningSteps = {
    items: [
      {
        id: "018f4b4a-6d33-7b3a-9c2d-123456789ac0",
        step_key: "read_current",
        step_index: 0,
        kind: "request",
        status: "running",
        duration_ms: null,
        retry_count: 0,
        result_storage_uri: null,
        result_sha256: null,
        result_preview: null,
        credential_snapshots: [],
        started_at: startedAt,
        finished_at: null,
        request_meta: { connector: { connector_id: null }, extras: { effect_kind: "read" } },
      },
    ],
    next_cursor: null,
  };
  const progressPath = `/v1/executions/${runningId}`;
  const progressStepsPath = `${progressPath}/steps`;
  const progressRequests = { detail: 0, steps: 0, otherMethods: [] };
  const runningFixture = async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      progressRequests.otherMethods.push({ method: request.method(), path });
      return route.fulfill({ status: 405, body: "Method not allowed" });
    }
    if (path === progressPath) {
      progressRequests.detail += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(runningDetail),
      });
    }
    if (path === progressStepsPath) {
      progressRequests.steps += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(runningSteps),
      });
    }
    return route.fallback();
  };
  await page.route("**/v1/executions/**", runningFixture);
  try {
    await stand.visit(page, `?run=${runningId}`);
    const progress = page.getByTestId("run-detail-progress");
    await progress.waitFor({ state: "visible" });
    const deadline = Date.now() + 3000;
    while (progressRequests.steps === 0 && Date.now() < deadline) await page.waitForTimeout(25);
    const progressText = (await progress.innerText()).trim();
    if (
      !progressText.endsWith(copy.runningStepTotal) ||
      !progressRequests.detail ||
      !progressRequests.steps ||
      progressRequests.otherMethods.length > 0
    ) {
      throw new Error(
        `${where}: expected progress ending in ${copy.runningStepTotal}; observed line "${progressText}" with fixture requests ${JSON.stringify(progressRequests)}`,
      );
    }
  } finally {
    await page.unroute("**/v1/executions/**", runningFixture);
  }

  let refused = 0;
  let windowReads = 0;
  const windows = { list: null, failed: null };
  const failedCount = (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("status") === "failed" && params.get("limit") === "3") return route.fallback();
    const from = Date.parse(params.get("started_from") ?? "");
    const to = Date.parse(params.get("started_to") ?? "");
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from !== 7 * 86_400_000)
      throw new Error(`${where}: the default request is not bounded to exactly seven days`);
    windowReads += 1;
    const range = `${params.get("started_from")}/${params.get("started_to")}`;
    if (!params.has("status")) windows.list = range;
    if ((params.get("status") ?? "").includes(",")) windows.failed = range;
    if (!(new URL(route.request().url()).searchParams.get("status") ?? "").includes(","))
      return route.fallback();
    refused += 1;
    return route.fulfill({ status: 500, json: { error: { code: "internal", message: "down" } } });
  };
  await page.route("**/v1/executions?**", failedCount);
  try {
    await stand.visit(page, "?runs=all");
    await summaryReads(
      page,
      copy.total,
      where,
      "a failed count that cannot be read must not hide the total",
    );
    if (!windowReads) throw new Error(`${where}: no bounded default run request was observed`);
    const deadline = Date.now() + 15_000;
    while (refused < 4 && Date.now() < deadline) await page.waitForTimeout(250);
    if (refused < 4)
      throw new Error(
        `${where}: the failed count was asked ${refused} times, not once and three retries — the error state was never reached`,
      );
    if (!windows.list || windows.list !== windows.failed)
      throw new Error(
        `${where}: the total and failed-count queries use different seven-day bounds`,
      );
    await page.waitForTimeout(300);
    await summaryReads(page, copy.total, where, "the total vanished once the failed count gave up");
  } finally {
    await page.unroute("**/v1/executions?**", failedCount);
  }

  await stand.visit(page, "?runs=all");
  await summaryReads(
    page,
    copy.summary,
    where,
    "the summary uses the compact seven-day window wording",
  );

  await stand.visit(
    page,
    "?runs=all&runs_from=2026-09-01T00%3A00%3A00.000Z&runs_to=2026-10-01T00%3A00%3A00.000Z",
  );
  await summaryReads(
    page,
    copy.customSummary,
    where,
    "an explicit custom time window keeps its concrete date label",
    true,
  );

  await page.locator('[data-testid="runs-search"]').fill("Monatsreport");
  await page.waitForURL(/[?&]runs_q=Monatsreport/, { timeout: 3000 }).catch((error) => {
    throw new Error(`${where}: the search is not kept in the address — ${page.url()}`, {
      cause: error,
    });
  });
  const reloadRequests = [];
  const reloadFailures = [];
  const reloadResponse = (response) => {
    const path = new URL(response.url()).pathname;
    if (path.startsWith("/v1/")) reloadRequests.push({ path, status: response.status() });
  };
  const reloadFailure = (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith("/v1/"))
      reloadFailures.push({ path, error: request.failure()?.errorText ?? "unknown" });
  };
  page.on("response", reloadResponse);
  page.on("requestfailed", reloadFailure);
  let reloaded;
  try {
    reloaded = await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="runs-search"]').waitFor({ state: "visible" });
  } catch (error) {
    const state = await Promise.race([
      page
        .evaluate(() => ({
          pathname: window.location.pathname,
          searchKeys: [...new URLSearchParams(window.location.search).keys()],
          runs: new URLSearchParams(window.location.search).get("runs"),
          readyState: document.readyState,
          testIds: [...document.querySelectorAll("[data-testid]")]
            .map((element) => element.getAttribute("data-testid"))
            .filter((value, index, values) => values.indexOf(value) === index)
            .slice(0, 80),
        }))
        .catch(() => ({ unavailable: true })),
      new Promise((resolve) => setTimeout(() => resolve({ unavailable: true }), 1000)),
    ]);
    throw new Error(
      `${where}: the runs search did not survive reload — ${JSON.stringify({
        documentStatus: reloaded?.status() ?? null,
        state,
        requests: reloadRequests.slice(-40),
        failures: reloadFailures.slice(-20),
      })}`,
      { cause: error },
    );
  } finally {
    page.off("response", reloadResponse);
    page.off("requestfailed", reloadFailure);
  }
  const kept = await page.locator('[data-testid="runs-search"]').inputValue();
  if (kept !== "Monatsreport")
    throw new Error(`${where}: a reload lost the search — the field reads "${kept}"`);
  await page.locator('[data-testid="runs-search"]').fill("");
  await page.waitForURL((url) => !url.searchParams.has("runs_q"), { timeout: 3000 });

  await page.getByTestId("resource-runs").waitFor({ state: "visible" });
  await page
    .locator(
      `[data-testid="resource-runs"] [data-testid="data-table-${wide ? "" : "mobile-"}row-link-0"]`,
    )
    .click();
  await page.locator('[data-testid="run-detail-body"]').waitFor({ state: "visible" });
  await page.getByTestId("run-detail").waitFor({ state: "visible" });
  if (
    wide &&
    !(await page
      .locator('[data-testid="run-detail-step-list-desktop"]')
      .isVisible()
      .catch(() => false))
  )
    throw new Error(`${where}: the steps of a run show as cards instead of a table`);

  await stand.visit(page, "");
  await page.locator('[data-testid="overview-all-runs"]').click();
  await page.locator('[data-testid="resource-runs"]').waitFor({ state: "visible" });
  await assertNoTooltipWithoutHover(page, `${where} · runs sheet`);
  await page.keyboard.press("Escape");
  await page
    .locator('[data-testid="resource-runs"]')
    .waitFor({ state: "hidden", timeout: 3000 })
    .catch((error) => {
      throw new Error(`${where}: one Escape did not close the sheet`, { cause: error });
    });
}

export async function verifyRunsOverCatalog(page, stand, where, mockApi = null) {
  const host = { q: "foo", status: "active" };
  const hostKept = (url, when) => {
    const params = new URL(url).searchParams;
    if (params.get("q") !== host.q || params.get("status") !== host.status)
      throw new Error(`${where}: ${when} the catalog's own q and status left the address — ${url}`);
  };
  await stand.visit(page, `workflows?q=${host.q}&status=${host.status}&runs=all`);
  await page.locator('[data-testid="resource-runs"]').waitFor({ state: "visible" });
  hostKept(page.url(), "opening the runs");
  const read = await page.locator('[data-testid="runs-search"]').inputValue();
  if (read !== "")
    throw new Error(`${where}: the runs read the catalog's search "${read}" as their own`);
  if (new URL(page.url()).searchParams.has("runs_status"))
    throw new Error(`${where}: the runs read the catalog's status as their own — ${page.url()}`);

  await page.locator('[data-testid="runs-search"]').fill("Bericht");
  await page.waitForURL(/[?&]runs_q=Bericht/, { timeout: 3000 }).catch((error) => {
    throw new Error(`${where}: the runs search is not kept in its own key — ${page.url()}`, {
      cause: error,
    });
  });
  hostKept(page.url(), "searching the runs");

  await page.keyboard.press("Escape");
  await page.locator('[data-testid="resource-runs"]').waitFor({ state: "hidden", timeout: 3000 });
  hostKept(page.url(), "closing the runs");
  const left = [...new URL(page.url()).searchParams.keys()].filter(
    (key) => key === "runs" || FILTER_KEYS.includes(key),
  );
  if (left.length)
    throw new Error(`${where}: closing the runs left ${left.join(", ")} in the address`);
  const kept = await page.locator('[data-testid="catalog-search"]').inputValue();
  if (kept !== host.q)
    throw new Error(`${where}: the catalog search reads "${kept}" after the runs closed`);
  if (
    (await page
      .locator('[data-testid="catalog-workflows"] [data-testid$="-row-0"]:visible')
      .count()) === 0
  )
    throw new Error(`${where}: the catalog shows no rows after the runs closed`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .locator('[data-testid="catalog-workflows"] [data-testid$="-row-0"]:visible')
    .first()
    .waitFor({ state: "visible" });
  await page.locator('[data-testid="catalog-search"]').waitFor({ state: "visible" });
  const reloaded = await page.locator('[data-testid="catalog-search"]').inputValue();
  if (reloaded !== host.q)
    throw new Error(`${where}: a reload after closing the runs lost the catalog search`);

  if (!mockApi) return;

  const htmlLocale = (await page.locator("html").getAttribute("lang"))?.toLowerCase() ?? "";
  const language = htmlLocale.startsWith("de") ? "de" : htmlLocale.startsWith("en") ? "en" : null;
  if (!language)
    throw new Error(`${where}: unsupported or missing document language ${htmlLocale}`);
  const workflowFilterLabel = translate(language, "inbox.resource.workflow");
  const workflowId = "018f4b4a-6d33-7b3a-9c2d-123456789ad1";
  const workflowName = "O3-1 filter fixture";
  const workflowState = {
    hidePermission: false,
    workflowRequests: 0,
    bootstrapPermissionStates: [],
  };
  const filterFixtures = async (route) => {
    const request = route.request();
    if (request.method() !== "GET") return route.fallback();
    const url = new URL(request.url());
    if (url.pathname === "/v1/cockpit/bootstrap") {
      return mockApi({
        request: () => request,
        fulfill: async (response) => {
          if (response.status !== 200 || typeof response.body !== "string")
            throw new Error(`${where}: bootstrap permission fixture has no successful mock body`);
          const body = JSON.parse(response.body);
          const permissions = body.permissions ?? [];
          const sourceHasWorkflowRead = permissions.includes("workflow:read");
          if (!sourceHasWorkflowRead)
            throw new Error(`${where}: the baseline bootstrap fixture lacks workflow:read`);
          if (workflowState.hidePermission)
            body.permissions = permissions.filter((permission) => permission !== "workflow:read");
          workflowState.bootstrapPermissionStates.push({
            sourceHasWorkflowRead,
            deliveredHasWorkflowRead: body.permissions.includes("workflow:read"),
          });
          await route.fulfill({ ...response, body: JSON.stringify(body) });
        },
      });
    }
    if (url.pathname === "/v1/workflows") {
      workflowState.workflowRequests += 1;
      if (url.searchParams.get("limit") !== "200" || url.searchParams.get("offset") !== "0")
        return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [{ id: workflowId, name: workflowName }], total: 1 }),
      });
    }
    return route.fallback();
  };
  await page.route("**/v1/**", filterFixtures);
  try {
    await stand.visit(page, "?runs=all");
    const workflowChoice = page.getByTestId("runs-workflow-choice");
    await workflowChoice.waitFor({ state: "visible" });
    if (!workflowState.workflowRequests)
      throw new Error(`${where}: the permission-gated workflow choice fixture was not requested`);
    const expectedChoice = page.getByRole("combobox", { name: workflowFilterLabel, exact: true });
    await expectedChoice.waitFor({ state: "visible" });
    await expectedChoice.click();
    const workflowOption = page.getByTestId(`runs-workflow-choice-option-${workflowId}`);
    await workflowOption.waitFor({ state: "visible" });
    if ((await workflowOption.innerText()).trim() !== workflowName)
      throw new Error(`${where}: workflow filter option is not the scoped fixture name`);
    const selectedExecutionRequest = page.waitForRequest(
      (request) => {
        const url = new URL(request.url());
        return (
          request.method() === "GET" &&
          url.pathname === "/v1/executions" &&
          url.searchParams.get("workflow_id") === workflowId
        );
      },
      { timeout: 3000 },
    );
    await workflowOption.click();
    const selectedRequest = await selectedExecutionRequest.catch((error) => {
      throw new Error(
        `${where}: selecting a workflow did not request its executions with workflow_id=${workflowId}`,
        { cause: error },
      );
    });
    if (
      new URL(selectedRequest.url()).searchParams.get("workflow_id") !== workflowId ||
      new URL(selectedRequest.url()).pathname !== "/v1/executions"
    )
      throw new Error(`${where}: the selected workflow filter did not reach the executions API`);
    await page
      .waitForFunction(
        ({ key, id }) => new URLSearchParams(window.location.search).get(key) === id,
        { key: RUNS_FILTER_PARAMS.workflowId, id: workflowId },
        { timeout: 3000 },
      )
      .catch((error) => {
        throw new Error(
          `${where}: selecting the workflow did not bind ${RUNS_FILTER_PARAMS.workflowId} in the URL — ${page.url()}`,
          { cause: error },
        );
      });
    const clearWorkflow = page.getByTestId("runs-workflow-filter");
    await clearWorkflow.waitFor({ state: "visible" });
    if ((await clearWorkflow.innerText()).trim() !== translate(language, "runs.workflowFilter"))
      throw new Error(`${where}: workflow clear control has the wrong localized label`);
    await clearWorkflow.click();
    await page
      .waitForFunction(
        (key) => !new URLSearchParams(window.location.search).has(key),
        RUNS_FILTER_PARAMS.workflowId,
        { timeout: 3000 },
      )
      .catch((error) => {
        throw new Error(
          `${where}: clearing the workflow filter left ${RUNS_FILTER_PARAMS.workflowId} in the URL — ${page.url()}`,
          { cause: error },
        );
      });
    await expectedChoice.click();
    const allWorkflows = page.getByTestId("runs-workflow-choice-option-all");
    await allWorkflows.waitFor({ state: "visible" });
    if ((await allWorkflows.innerText()).trim() !== translate(language, "runs.allWorkflows"))
      throw new Error(`${where}: the all-workflows option has the wrong localized label`);
    if ((await allWorkflows.getAttribute("aria-selected")) !== "true")
      throw new Error(`${where}: clearing the filter did not restore the all-workflows option`);
    await page.keyboard.press("Escape");

    const requestsBeforeDenial = workflowState.workflowRequests;
    workflowState.hidePermission = true;
    await stand.visit(page, "?runs=all");
    if (await page.getByTestId("runs-workflow-choice").count())
      throw new Error(`${where}: workflow filter is visible without workflow:read`);
    if (workflowState.workflowRequests !== requestsBeforeDenial)
      throw new Error(`${where}: workflow choices were fetched without workflow:read`);
    if (
      workflowState.bootstrapPermissionStates.length < 2 ||
      !workflowState.bootstrapPermissionStates[0].deliveredHasWorkflowRead ||
      workflowState.bootstrapPermissionStates.at(-1).deliveredHasWorkflowRead
    )
      throw new Error(
        `${where}: the baseline and permission-restricted bootstrap states were not both applied`,
      );
  } finally {
    await page.unroute("**/v1/**", filterFixtures);
  }
}
