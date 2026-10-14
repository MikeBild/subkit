import { translate } from "../../apps/cockpit/src/lib/i18n.ts";
import { closeRecordSheet } from "./cockpit-record-sheet.mjs";
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

export async function verifyUsageWorkflowNavigation(page, stand, label, knownWorkflowId) {
  const deniedWorkflowId = "catalog-record-1";
  const goneWorkflowId = "0e6b2c52-7d1f-4d8e-9d55-5f0c2f7a9e10";
  await page.route(`**/v1/workflows/${deniedWorkflowId}`, (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "forbidden", message: "workflow" } }),
    }),
  );
  const deniedResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/v1/workflows/${deniedWorkflowId}` && response.status() === 403;
  });
  const goneResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === `/v1/workflows/${goneWorkflowId}` && response.status() === 404;
  });
  const initialUsageRequests = Promise.all(
    [
      ["/v1/stats/llm", "flow"],
      ["/v1/stats/llm", "workflow"],
      ["/v1/stats/llm", "model"],
      ["/v1/stats/executions", "workflow_id"],
    ].map(([path, axis]) =>
      page.waitForRequest((request) => {
        const url = new URL(request.url());
        return url.pathname === path && url.searchParams.get("group_by") === axis;
      }),
    ),
  );
  await stand.visit(page, "usage");
  await Promise.all([deniedResponse, goneResponse]);
  const defaultWindow = page.getByTestId("usage-window-7d");
  await defaultWindow.waitFor({ state: "visible" });
  if (
    (await defaultWindow.getAttribute("data-state")) !== "on" ||
    (await defaultWindow.innerText()).trim() !== translate("de", "resource.usage.windowOption.7d")
  )
    throw new Error(`${label}: usage does not visibly select seven days by default`);
  for (const request of await initialUsageRequests) {
    const url = new URL(request.url());
    const from = Date.parse(url.searchParams.get("from") ?? "");
    const to = Date.parse(url.searchParams.get("to") ?? "");
    if (url.searchParams.get("bucket") !== "day" || to - from !== 7 * 24 * 60 * 60 * 1000)
      throw new Error(`${label}: the initial ${url.pathname} request does not cover seven days`);
  }
  const row = (index) =>
    page.getByTestId(`usage-consumption-table-row-${index}`).filter({ visible: true }).first();
  const named = row(0);
  const forbidden = row(1);
  const gone = row(2);
  const workflowLink = named.getByTestId("usage-workflow-link");
  await workflowLink.waitFor({ state: "visible" });
  const knownPath = `/cockpit/workflows/${knownWorkflowId}`;
  if (new URL(await workflowLink.getAttribute("href"), page.url()).pathname !== knownPath)
    throw new Error(`${label}: the named usage workflow link is not its exact internal route`);
  if ((await forbidden.innerText()).includes("Name nicht lesbar") === false)
    throw new Error(`${label}: a forbidden workflow lookup must be presented as unreadable`);
  if ((await forbidden.innerText()).includes("Monatsreport für alle Tochtergesellschaften"))
    throw new Error(`${label}: a forbidden workflow lookup disclosed the protected workflow name`);
  if (
    (await gone.innerText()).includes(
      "Ein Workflow, den dieser Arbeitsbereich nicht mehr führt",
    ) === false
  )
    throw new Error(`${label}: a missing workflow lookup must be presented as gone`);
  for (const [description, candidate] of [
    ["forbidden", forbidden],
    ["gone", gone],
  ]) {
    if ((await candidate.getByTestId("usage-workflow-link").count()) !== 0)
      throw new Error(`${label}: a ${description} workflow must not expose a workflow link`);
    await candidate.locator("td").nth(1).click();
    if (new URL(page.url()).pathname !== "/cockpit/usage")
      throw new Error(`${label}: clicking a ${description} workflow row opened a workflow`);
  }
  await named.locator("td").nth(1).click();
  await page.waitForURL((url) => url.pathname === knownPath);
  if (new URL(page.url()).pathname !== knownPath)
    throw new Error(`${label}: clicking a non-link cell did not open the named workflow`);
}

export async function verifyNotificationActions(page, stand, label) {
  const t = (key) => translate("de", key);
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
    await closeRecordSheet(page.getByTestId(sheet));
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
  const channelCases = [
    {
      index: 0,
      platformKey: "notifications.platform.inbox",
      target: t("notifications.target.inbox"),
    },
    { index: 1, platformKey: "notifications.platform.slack", target: "C0001" },
    { index: 2, platformKey: "notifications.platform.googleChat", target: "spaces/AAA" },
  ];
  const desktopChannels = page
    .getByTestId("notifications-channels-table-desktop")
    .filter({ visible: true });
  await desktopChannels
    .getByRole("columnheader", { name: t("notifications.column.target"), exact: true })
    .waitFor({ state: "visible" });
  for (const { index, platformKey, target } of channelCases) {
    const row = desktopChannels
      .getByTestId(`notifications-channels-table-row-${index}`)
      .filter({ visible: true });
    await row.waitFor({ state: "visible" });
    const cells = row.locator("td");
    const platform = (await cells.nth(0).innerText()).trim();
    if (platform !== t(platformKey))
      throw new Error(`${label}: channel row ${index} labels its platform "${platform}"`);
    const shownTarget = (await cells.nth(1).innerText()).trim();
    if (shownTarget !== target)
      throw new Error(
        `${label}: channel row ${index} shows target "${shownTarget}", not "${target}"`,
      );
  }
  for (const { index, platformKey, target } of channelCases) {
    await openRow("notifications-channels-table", index, "notifications-channel-sheet");
    const channelSheet = page.getByTestId("notifications-channel-sheet");
    const platform = t(platformKey);
    await channelSheet.getByText(platform, { exact: true }).waitFor({ state: "visible" });
    const targetLabel = t("notifications.column.target");
    const targetFact = channelSheet.locator("dt").filter({ hasText: targetLabel });
    await targetFact.waitFor({ state: "visible" });
    const shownTarget = (await targetFact.locator("xpath=../dd").innerText()).trim();
    if (shownTarget !== target)
      throw new Error(
        `${label}: ${platform} detail shows target "${shownTarget}", not "${target}"`,
      );
    if (index === 1 && !(await page.getByTestId("notifications-channel-delete").isDisabled()))
      throw new Error(`${label}: a channel two rules deliver to can be removed`);
    if (index === 2 && !(await page.getByTestId("notifications-channel-delete").isEnabled()))
      throw new Error(`${label}: an unused channel cannot be removed`);
    await closeSheet("notifications-channel-sheet");
  }
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
