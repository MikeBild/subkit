/** Exercise the built cockpit; HTTP integration tests separately prove no write is sent. */
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
    // What starts the workflow, in words, heads "Verwenden". A paused schedule
    // is marked as one, a foreign one is absent.
    const triggers = page.getByTestId("workflow-automation-triggers");
    await triggers
      .filter({ hasText: locale === "de" ? "täglich um 06:00" : "daily at 06:00" })
      .waitFor();
    const triggerText = await triggers.innerText();
    if (triggerText.includes("foreign-fixture"))
      throw new Error("Cockpit presents another workflow's schedule as this one's");
    if (
      !triggerText.includes(
        locale === "de" ? "paused-fixture (UTC) (pausiert)" : "paused-fixture (UTC) (paused)",
      )
    )
      throw new Error(`Cockpit presents a paused schedule as active: ${triggerText}`);
    // The previews stand with the steps, in "Aufbau".
    await page.getByTestId("workflow-tabs-tab-aufbau").click();
    await whole.waitFor({ state: "visible" });
    await page.getByTestId("workflow-step-0-never-ran").filter({ visible: true }).waitFor();
    const expected = locale === "de" ? "Als Vorschau ausführen" : "Run as preview";
    if ((await whole.innerText()) !== expected) throw new Error("Preview label is not localized");
    // What the preview does is one sentence behind the help icon, not a
    // paragraph beside the button.
    if (await page.getByText(/temporären Kopie|temporary copy: steps/).count())
      throw new Error("The preview's explanation stands on the page as a paragraph again");
    await whole.focus();
    await whole.press("Enter");
    await page.getByTestId("workflow-test-result").filter({ hasText: '"held": true' }).waitFor();
    if (requests[0]?.source !== "draft") throw new Error("Whole preview lost its definition");
    // A step's own preview is offered where its configuration is: its sheet.
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
    await page.reload();
    await whole.waitFor({ state: "visible" });
    if (await page.getByTestId("workflow-test-result").count()) {
      throw new Error("Reload presents a temporary preview as persisted execution evidence");
    }
  } finally {
    await page.unroute("**/v1/executions", intercept);
    await page.unroute("**/v1/executions?**", history);
    await page.unroute("**/v1/schedules?**", schedules);
  }
}
