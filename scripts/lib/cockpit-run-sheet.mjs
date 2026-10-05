import { assertNoTooltipWithoutHover } from "./cockpit-unprompted-tooltip.mjs";

const COPY = {
  de: { summary: "240 Läufe · 120 fehlgeschlagen" },
  en: { summary: "240 runs · 120 failed" },
};

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

  await stand.visit(page, "?runs=all");
  const summary = page.locator('[data-testid="runs-summary"]');
  await summary.waitFor({ state: "visible" });
  const line = (await summary.innerText()).trim();
  if (line !== copy.summary)
    throw new Error(
      `${where}: the summary counts failures in the loaded rows, not in the window — "${line}", expected "${copy.summary}"`,
    );

  await page.locator('[data-testid="runs-search"]').fill("Monatsreport");
  await page.waitForURL(/[?&]q=Monatsreport/, { timeout: 3000 }).catch((error) => {
    throw new Error(`${where}: the search is not kept in the address — ${page.url()}`, {
      cause: error,
    });
  });
  await page.reload({ waitUntil: "networkidle" });
  const kept = await page.locator('[data-testid="runs-search"]').inputValue();
  if (kept !== "Monatsreport")
    throw new Error(`${where}: a reload lost the search — the field reads "${kept}"`);
  await page.locator('[data-testid="runs-search"]').fill("");
  await page.waitForURL((url) => !url.searchParams.has("q"), { timeout: 3000 });

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
  await assertNoTooltipWithoutHover(page, `${where} · runs sheet`);
  await page.keyboard.press("Escape");
  await page
    .locator('[data-testid="resource-runs"]')
    .waitFor({ state: "hidden", timeout: 3000 })
    .catch((error) => {
      throw new Error(`${where}: one Escape did not close the sheet`, { cause: error });
    });
}
