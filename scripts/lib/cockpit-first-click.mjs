async function clickAt(page, locator, dx = 4) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("the click target has no box");
  await page.mouse.click(box.x + Math.min(dx, box.width / 2), box.y + box.height / 2);
}

async function arriveOnWorkflows(page, stand) {
  await stand.visit(page, "");
  await page.locator('[data-testid="nav-workflows"]').click();
  const link = page.locator('[data-testid="data-table-row-link-0"]');
  await link.waitFor({ state: "attached" });
  return link;
}

async function expectPath(page, pattern, where) {
  try {
    await page.waitForURL(pattern, { timeout: 3000 });
  } catch (error) {
    throw new Error(`${where}: one click did not open the row — the address stayed ${page.url()}`, {
      cause: error,
    });
  }
}

export async function verifyFirstClickOpens(page, stand, where) {
  if ((page.viewportSize()?.width ?? 0) < 1024) return;
  const link = await arriveOnWorkflows(page, stand);
  await clickAt(page, link);
  await expectPath(page, /\/cockpit\/workflows\/[^/?]+/, `${where}/link-right-after-navigation`);

  await arriveOnWorkflows(page, stand);
  const cell = page.locator('[data-testid="data-table-row-0"] td').nth(2);
  await clickAt(page, cell, 40);
  await expectPath(
    page,
    /\/cockpit\/workflows\/[^/?]+/,
    `${where}/plain-cell-right-after-navigation`,
  );

  await stand.visit(page, "?runs=all");
  const date = page.locator('[data-testid="resource-runs"] [data-testid="data-table-row-link-0"]');
  await date.waitFor({ state: "visible" });
  await clickAt(page, date);
  await page
    .locator('[data-testid="run-detail-body"]')
    .waitFor({ state: "visible", timeout: 3000 })
    .catch((error) => {
      throw new Error(`${where}: one click on the start time did not open the run`, {
        cause: error,
      });
    });
}
