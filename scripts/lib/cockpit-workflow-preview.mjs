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
          { workflow_id: workflowId, paused: false, cron: "0 6 * * *", timezone: "UTC" },
          { workflow_id: workflowId, paused: true, cron: "paused-fixture", timezone: "UTC" },
          {
            workflow_id: "other-workflow",
            paused: false,
            cron: "foreign-fixture",
            timezone: "UTC",
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
    await whole.waitFor({ state: "visible" });
    const schedule = page.getByTestId("workflow-schedule");
    await schedule.filter({ hasText: "0 6 * * *" }).waitFor();
    const scheduleText = await schedule.innerText();
    if (scheduleText.includes("paused-fixture") || scheduleText.includes("foreign-fixture")) {
      throw new Error("Cockpit presents a paused or foreign schedule as active");
    }
    await page.getByTestId("workflow-step-0-never-ran").waitFor();
    const expected = locale === "de" ? "Schritte als Vorschau" : "Preview steps";
    if ((await whole.innerText()) !== expected) throw new Error("Preview label is not localized");
    await whole.focus();
    await whole.press("Enter");
    await page.getByTestId("workflow-test-result").filter({ hasText: '"held": true' }).waitFor();
    if (requests[0]?.source !== "draft") throw new Error("Whole preview lost its definition");
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
