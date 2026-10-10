import { assertNoTooltipWithoutHover } from "./cockpit-unprompted-tooltip.mjs";

const COPY = {
  de: { summary: "240 Läufe · 120 fehlgeschlagen", total: "240 Läufe" },
  en: { summary: "240 runs · 120 failed", total: "240 runs" },
};

const FILTER_KEYS = [
  "runs_workflow",
  "runs_status",
  "runs_source",
  "runs_q",
  "runs_from",
  "runs_to",
];

async function summaryReads(page, expected, where, why) {
  const summary = page.locator('[data-testid="runs-summary"]');
  await summary.waitFor({ state: "visible", timeout: 5000 }).catch((error) => {
    throw new Error(`${where}: ${why} — the summary line is gone`, { cause: error });
  });
  const window = page.getByTestId("runs-window-filter");
  await window.waitFor({ state: "visible" });
  const label = (await window.innerText()).trim();
  if (!label) throw new Error(`${where}: the default time window has no readable label`);
  const fullExpected = `${expected} · ${label}`;
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

  let refused = 0;
  let windowReads = 0;
  const failedCount = (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.get("status") === "failed" && params.get("limit") === "3") return route.fallback();
    const from = Date.parse(params.get("started_from") ?? "");
    const to = Date.parse(params.get("started_to") ?? "");
    if (!Number.isFinite(from) || !Number.isFinite(to) || to - from !== 7 * 86_400_000)
      throw new Error(`${where}: the default request is not bounded to exactly seven days`);
    windowReads += 1;
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
    "the summary counts failures in the loaded rows, not in the window",
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

export async function verifyRunsOverCatalog(page, stand, where) {
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
}
