export async function verifyWorkflowPreview(page, stand, workflowId, locale) {
  const requests = [];
  const history = (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        items: [{ id: "old-version-run", workflow_version_id: "old-version" }],
      }),
    });
  const schedules = (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        schedules: [
          {
            id: "schedule-active",
            workflow_id: workflowId,
            paused: false,
            cron: "0 6 * * *",
            timezone: "UTC",
            execution_mode: "prod",
          },
          {
            id: "schedule-paused",
            workflow_id: workflowId,
            paused: true,
            cron: "paused-fixture",
            timezone: "UTC",
            execution_mode: "prod",
          },
          {
            id: "schedule-foreign",
            workflow_id: "other-workflow",
            paused: false,
            cron: "foreign-fixture",
            timezone: "UTC",
            execution_mode: "prod",
          },
        ],
        total: 3,
      }),
    });
  const intercept = async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON();
    requests.push(body);
    if (body.hold_writes !== true || !["draft", "step"].includes(body.source)) {
      throw new Error("Cockpit preview attempted a live execution");
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        execution_id: "preview-fixture",
        status: "succeeded",
        steps: [{ step_key: "fetch", held: true }],
      }),
    });
  };
  await page.route("**/v1/executions", intercept);
  await page.route("**/v1/executions?**", history);
  await page.route("**/v1/schedules?**", schedules);
  try {
    await stand.visit(page, `workflows/${workflowId}`);
    const whole = page.getByTestId("workflow-test-run");
    await page.getByTestId("workflow-invocation-tab-schedule").click();
    const rhythm = page.getByTestId("schedule-rhythm-fact");
    await page
      .getByTestId("workflow-schedule")
      .filter({ hasText: locale === "de" ? "täglich um 06:00" : "daily at 06:00" })
      .waitFor();
    const scheduleText = await page.getByTestId("workflow-schedule").innerText();
    if (scheduleText.includes("foreign-fixture"))
      throw new Error("Cockpit presents another workflow's schedule as this one's");
    if (!(await rhythm.count())) throw new Error("The schedule's rhythm is not stated");
    await page.getByTestId("workflow-tabs-tab-structure").click();
    await page
      .locator(
        '[data-testid="workflow-step-list-row-link-0"], [data-testid="workflow-step-list-mobile-row-link-0"]',
      )
      .filter({ visible: true })
      .first()
      .waitFor();
    if (await whole.count())
      throw new Error("The draft preview is offered while the draft has no changes");
    await page.getByTestId("workflow-step-2-menu").filter({ visible: true }).first().click();
    await page.getByTestId("workflow-step-2-up").click();
    await page.getByRole("menu").waitFor({ state: "detached" });
    await page.getByTestId("step-savebar").waitFor();
    if (await page.getByRole("dialog").count())
      throw new Error("Choosing a row menu item also opened the row's sheet");
    await whole.waitFor({ state: "visible" });
    const filled = await page
      .getByTestId("detail-workflows")
      .locator('button[data-variant="default"], a[data-variant="default"]')
      .count();
    if (filled !== 1) throw new Error(`An unsaved draft shows ${filled} filled actions`);
    const expected = locale === "de" ? "Als Vorschau ausführen" : "Run as preview";
    if ((await whole.innerText()) !== expected) throw new Error("Preview label is not localized");
    if (await page.getByText(/temporären Kopie|temporary copy: steps/).count())
      throw new Error("The preview's explanation stands on the page as a paragraph again");
    await whole.focus();
    await whole.press("Enter");
    await page.getByTestId("workflow-test-result").filter({ hasText: '"held": true' }).waitFor();
    if (requests[0]?.source !== "draft") throw new Error("Whole preview lost its definition");
    const toggle = page
      .locator(
        '[data-testid="workflow-step-list-row-link-0"], [data-testid="workflow-step-list-mobile-row-link-0"]',
      )
      .filter({ visible: true })
      .first();
    await toggle.focus();
    await toggle.press("Enter");
    const step = page.getByTestId("workflow-step-0-test");
    await step.focus();
    await step.press("Enter");
    await page
      .getByTestId("workflow-step-0-test-result")
      .filter({ hasText: '"held": true' })
      .waitFor();
    if (requests.length !== 2 || requests[1]?.source !== "step") {
      throw new Error("Step preview lost its exact source or dispatched twice");
    }
    await page.keyboard.press("Escape");
    await page.getByTestId("workflow-step-0-sheet").waitFor({ state: "detached" });
    await page.getByTestId("step-savebar-discard").click();
    await page.getByTestId("step-savebar").waitFor({ state: "detached" });
    await page.reload();
    await page
      .locator(
        '[data-testid="workflow-step-list-row-link-0"], [data-testid="workflow-step-list-mobile-row-link-0"]',
      )
      .filter({ visible: true })
      .first()
      .waitFor();
    if (await page.getByTestId("workflow-test-result").count()) {
      throw new Error("Reload presents a temporary preview as persisted execution evidence");
    }
  } finally {
    await page.unroute("**/v1/executions", intercept);
    await page.unroute("**/v1/executions?**", history);
    await page.unroute("**/v1/schedules?**", schedules);
  }
}
