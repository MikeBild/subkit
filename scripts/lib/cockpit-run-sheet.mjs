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
  await page
    .waitForFunction(
      (text) =>
        document.querySelector('[data-testid="runs-summary"]')?.textContent?.trim() === text,
      expected,
      { timeout: 5000 },
    )
    .catch(async (error) => {
      throw new Error(
        `${where}: ${why} — "${(await summary.innerText()).trim()}", expected "${expected}"`,
        { cause: error },
      );
    });
}

async function sheetWidth(page, testId) {
  const sheet = page.locator(`[data-testid="${testId}"]`);
  await sheet.waitFor({ state: "visible" });
  return {
    size: await sheet.getAttribute("data-sheet-size"),
    width: Math.round((await sheet.boundingBox())?.width ?? 0),
  };
}

async function assertCodeBlocksFit(page, where) {
  const cut = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] [data-slot="code-block"]')]
      .filter((block) => {
        const pre = block.querySelector("pre");
        const sheet = block.closest('[role="dialog"]')?.getBoundingClientRect();
        return (
          (pre && pre.scrollWidth > pre.clientWidth + 1) ||
          (sheet && block.getBoundingClientRect().right > sheet.right + 1)
        );
      })
      .map((block) => block.getAttribute("data-testid") ?? "?"),
  );
  if (cut.length)
    throw new Error(`${where}: code blocks hide text to the right — ${cut.join(", ")}`);
}

export async function verifyRunSheet(page, stand, uuid, language, where) {
  const copy = COPY[language];
  const wide = (page.viewportSize()?.width ?? 0) >= 1024;

  await stand.visit(page, `?run=${uuid}`);
  await page.locator('[data-testid="run-detail-error"]').waitFor({ state: "visible" });
  const direct = await sheetWidth(page, "run-detail");
  await assertCodeBlocksFit(page, `${where}/direct`);

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
  const failedCount = (route) => {
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
  await page.reload({ waitUntil: "networkidle" });
  const kept = await page.locator('[data-testid="runs-search"]').inputValue();
  if (kept !== "Monatsreport")
    throw new Error(`${where}: a reload lost the search — the field reads "${kept}"`);
  await page.locator('[data-testid="runs-search"]').fill("");
  await page.waitForURL((url) => !url.searchParams.has("runs_q"), { timeout: 3000 });

  const listed = await sheetWidth(page, "resource-runs");
  await page
    .locator(
      `[data-testid="resource-runs"] [data-testid="data-table-${wide ? "" : "mobile-"}row-link-0"]`,
    )
    .click();
  await page.locator('[data-testid="run-detail-body"]').waitFor({ state: "visible" });
  const opened = await sheetWidth(page, "run-detail");
  if (direct.size !== listed.size || opened.width !== listed.width || direct.width !== opened.width)
    throw new Error(
      `${where}: the run sheet changes width with the way in — direct ${JSON.stringify(direct)}, list ${JSON.stringify(listed)}, from the list ${JSON.stringify(opened)}`,
    );
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
  await page.waitForTimeout(900);
  if (await page.locator('[role="tooltip"]').count())
    throw new Error(`${where}: opening the sheet opened a tooltip on its first button`);
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

  await page.reload({ waitUntil: "networkidle" });
  const reloaded = await page.locator('[data-testid="catalog-search"]').inputValue();
  if (reloaded !== host.q)
    throw new Error(`${where}: a reload after closing the runs lost the catalog search`);
}
