/** Database enforcement is covered by the scheduler and HTTP integration suites. */
export async function verifyScheduleHolds(page, stand, workflowId, locale, snapshot, capture) {
  const schedulePattern = "**/v1/schedules*";
  const overviewPattern = "**/v1/operational-overview*";
  const schedule = {
    id: workflowId,
    workflow_id: workflowId,
    workflow_name: "Held publishing workflow",
    workflow_slug: "held-publishing",
    paused: false,
    cron: "0 8 * * *",
    timezone: "Europe/Berlin",
    execution_mode: "prod",
    input: null,
    created_at: new Date().toISOString(),
    admission_hold: {
      reason_code: "execution_authority_required",
      observed_at: new Date().toISOString(),
    },
  };
  const schedules = (route) => route.fulfill({ json: { schedules: [schedule], total: 1 } });
  const overview = (route) => {
    const data = snapshot();
    Object.assign(data.core.blocked, { value: 1, severity: "critical", value_state: "observed" });
    Object.assign(data.core.health, {
      value: null,
      state: "critical",
      severity: "critical",
      value_state: "missing",
    });
    for (const section of data.sections)
      for (const metric of section.metrics) {
        if (metric.id === "executions.success_ratio")
          Object.assign(metric, { value: null, value_state: "missing" });
      }
    return route.fulfill({ json: data });
  };
  await page.route(schedulePattern, schedules);
  await page.route(overviewPattern, overview);
  try {
    await stand.visit(page, "");
    await page
      .getByText(locale === "de" ? "Keine Läufe (24 h)" : "No runs (24 h)", { exact: true })
      .waitFor();
    if (
      !(await page.getByTestId("overview-page").innerText()).includes(
        locale === "de" ? "Kritisch" : "Critical",
      )
    )
      throw new Error("Known hold is hidden by missing success evidence");
    await capture("overview");
    await stand.visit(page, "decisions");
    const card = page.getByTestId("schedule-admission-held");
    await card.waitFor();
    if (await page.getByTestId("decisions-empty").count())
      throw new Error("Held schedules presented as an empty queue");
    await capture("decision");
    await card.getByRole("link").click();
    await page.getByTestId("detail-workflows").waitFor();
    await page.getByTestId("authority-grant-open").waitFor();
  } finally {
    await page.unroute(schedulePattern, schedules);
    await page.unroute(overviewPattern, overview);
  }
}
