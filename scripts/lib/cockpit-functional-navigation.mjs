export async function verifyReviewCloseHistory(page, stand, label) {
  const open = page
    .locator('[data-testid="attention-list"] [data-attention-verb="review"]:visible')
    .first();
  const sheet = page.locator('[data-testid="attention-review"]');
  await stand.visit(page, "usage");
  await stand.visit(page, "");
  await open.click();
  await sheet.waitFor({ state: "visible" });
  await page.locator('[data-testid="attention-review-close"]').click();
  await sheet.waitFor({ state: "hidden" });
  if (new URL(page.url()).searchParams.get("review"))
    throw new Error(`${label}: the closed sheet is still in the address`);
  await page.goBack();
  await page
    .locator('[data-testid="resource-usage"], [data-testid="admin-usage"]')
    .first()
    .waitFor({
      state: "attached",
      timeout: 10_000,
    })
    .catch(() => {});
  const url = new URL(page.url());
  if ((await sheet.isVisible().catch(() => false)) || url.searchParams.has("review"))
    throw new Error(`${label}: Back after closing reopens the review sheet`);
  if (!url.pathname.endsWith("/usage"))
    throw new Error(
      `${label}: Back after closing lands on ${url.pathname}, not where the reader was`,
    );
}

export async function verifyNotificationActions(page, stand, label) {
  await stand.visit(page, "settings?tab=notifications");
  await page.getByTestId("notifications-rules").waitFor({ state: "visible" });
  const machineValues = (index) =>
    page
      .locator(`[data-testid="notifications-rule-${index}"] [data-machine-value="true"]`)
      .allInnerTexts();
  if ((await machineValues(0)).length !== 0)
    throw new Error(`${label}: the seeded rule prints an event as the engine's value`);
  const hostile = (await machineValues(2)).join(" | ");
  if (
    hostile !==
    "vendor.custom_integration.quarterly_reconciliation_completed_with_warnings | billing-*"
  )
    throw new Error(`${label}: the hostile rule marks ${hostile}, not its one unknown event`);
  const openRow = async (table, index, sheet) => {
    await page
      .locator(
        `[data-testid="${table}-row-link-${index}"], [data-testid="${table}-mobile-row-link-${index}"]`,
      )
      .filter({ visible: true })
      .first()
      .click();
    await page.getByTestId(sheet).waitFor({ state: "visible" });
  };
  const closeSheet = async (sheet) => {
    await page.getByTestId(sheet).locator('[data-slot="sheet-close"]').click();
    await page.getByTestId(sheet).waitFor({ state: "detached" });
  };
  await openRow("notifications-rules-table", 1, "notifications-rule-sheet");
  const ruleSheet = page.getByTestId("notifications-rule-sheet");
  await ruleSheet.getByTestId("action-menu").click();
  if (!(await page.getByTestId("notifications-rule-delete").isEnabled()))
    throw new Error(`${label}: a rule's sheet offers no way to delete it`);
  if (!(await page.getByTestId("notifications-rule-toggle").isVisible()))
    throw new Error(`${label}: a rule's sheet offers no way to pause it`);
  await page.keyboard.press("Escape");
  await page.getByTestId("notifications-rule-edit").click();
  const ruleDialog = page.getByTestId("notifications-rule-dialog");
  await ruleDialog.waitFor({ state: "visible" });
  if (!(await page.getByTestId("notifications-rule-name").inputValue()).trim())
    throw new Error(`${label}: editing a rule does not start from its name`);
  await page.getByTestId("notifications-rule-dialog-cancel").click();
  await ruleDialog.waitFor({ state: "detached" });
  await closeSheet("notifications-rule-sheet");
  await openRow("notifications-channels-table", 1, "notifications-channel-sheet");
  if (!(await page.getByTestId("notifications-channel-delete").isDisabled()))
    throw new Error(`${label}: a channel two rules deliver to can be removed`);
  await closeSheet("notifications-channel-sheet");
  await openRow("notifications-channels-table", 2, "notifications-channel-sheet");
  if (!(await page.getByTestId("notifications-channel-delete").isEnabled()))
    throw new Error(`${label}: an unused channel cannot be removed`);
  await closeSheet("notifications-channel-sheet");
}

const ENDLESS_LISTS = {
  workflows: { path: "/v1/workflows", firstPage: 25, paging: "offset" },
  audit: { path: "/v1/audit-log", firstPage: 50, paging: "cursor" },
};

export async function verifyListPagination(page, stand, label, route) {
  const list = ENDLESS_LISTS[route];
  const row = (index) => page.getByTestId(`data-table-row-${index}`);
  const followUps = [];
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (url.pathname !== list.path) return;
    const follows =
      list.paging === "offset"
        ? url.searchParams.get("offset") === String(list.firstPage)
        : Boolean(url.searchParams.get("cursor"));
    if (follows) followUps.push(url.search);
  };
  page.on("request", onRequest);
  try {
    await stand.visit(page, route);
    await row(0).waitFor();
    for (let attempt = 0; attempt < 20 && (await row(list.firstPage).count()) === 0; attempt += 1) {
      await page.evaluate(() => {
        const scope = document.querySelector('[data-testid="data-table-desktop"]');
        for (let box = scope; box; box = box.parentElement)
          if (/auto|scroll/.test(getComputedStyle(box).overflowY)) box.scrollTop = box.scrollHeight;
        window.scrollTo(0, document.documentElement.scrollHeight);
      });
      await page.waitForTimeout(150);
    }
  } finally {
    page.off("request", onRequest);
  }
  if (followUps.length === 0)
    throw new Error(`${label}: scrolling to the end asked the engine for no next page`);
  if ((await row(list.firstPage).count()) === 0)
    throw new Error(
      `${label}: row ${list.firstPage + 1} never appeared after scrolling to the end`,
    );
}
