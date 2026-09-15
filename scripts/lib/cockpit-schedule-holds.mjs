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
  const heldSchedules = Array.from({ length: 13 }, (_, index) => ({
    ...schedule,
    id: `${workflowId}-${index}`,
    workflow_name: index === 0 ? "Held publishing workflow" : `Scheduled workflow ${index + 1}`,
    admission_hold: {
      ...schedule.admission_hold,
      reason_code:
        index % 2 === 0 ? "execution_authority_required" : "execution_authority_unavailable",
    },
  }));
  let cleared = false;
  const schedules = (route) =>
    route.fulfill({ json: { schedules: cleared ? [] : heldSchedules, total: cleared ? 0 : 13 } });
  const overview = (route) => {
    const data = snapshot();
    Object.assign(data.core.blocked, { value: 13, severity: "critical", value_state: "observed" });
    Object.assign(data.core.health, {
      value: null,
      state: "critical",
      severity: "critical",
      value_state: "missing",
    });
    data.sections.push({
      id: "reliability",
      title: "Reliability",
      visualization: "kpi",
      metrics: [
        {
          id: "executions.success_ratio",
          value: null,
          value_state: "missing",
          severity: "unknown",
          kind: "ratio",
          drilldown: { path: "/cockpit/runs" },
        },
      ],
      drilldown: { path: "/cockpit/runs" },
    });
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
    const cards = page.getByTestId("schedule-admission-held");
    const card = cards.first();
    await card.waitFor();
    if (await page.getByTestId("decisions-empty").count())
      throw new Error("Held schedules presented as an empty queue");
    const count = await page.locator('[data-testid="decisions-page"]').innerText();
    if (!count.includes(locale === "de" ? "15 offene Entscheidung" : "15 open decision"))
      throw new Error("Decision total excludes the held schedule");
    if ((await cards.count()) !== 13) throw new Error("Held schedule queue lost entries");
    const toolbar = await page.getByTestId("decisions-toolbar").boundingBox();
    const firstCard = await card.boundingBox();
    if (!toolbar || !firstCard || toolbar.y >= firstCard.y)
      throw new Error("Controls buried below schedule holds");
    const details = card.getByTestId("schedule-admission-details");
    if ((await details.getAttribute("open")) !== null)
      throw new Error("Technical schedule details should start collapsed");
    await details.locator("summary").focus();
    await page.keyboard.press("Enter");
    if ((await details.getAttribute("open")) === null)
      throw new Error("Schedule details not keyboard accessible");
    await page.keyboard.press("Enter");
    await capture("decision");
    await page.getByTestId("decisions-chip-0").click();
    if ((await cards.count()) !== 0)
      throw new Error("Fix filter does not exclude scheduled workflows");
    await page.getByTestId("decisions-chip-all").click();
    await page.getByTestId("decisions-chip-2").click();
    if (
      (await cards.count()) !== 13 ||
      (await page.getByTestId("decisions-current").count()) ||
      (await page.getByTestId("decisions-empty-filtered").count())
    )
      throw new Error("Schedule filter does not isolate held workflows");
    await page.getByTestId("decisions-section-suggestions").click();
    if (await cards.count()) throw new Error("Holds leaked into suggestions");
    await page.getByTestId("decisions-section-decisions").click();
    await page.getByTestId("decisions-chip-all").click();
    await page.getByTestId("decisions-chip-0").click();
    await stand.visit(page, "decisions?bucket=blocked");
    await card.waitFor();
    if ((await page.getByTestId("decisions-chip-2").getAttribute("aria-pressed")) !== "true")
      throw new Error("Overview blocked link must override a saved unrelated kind filter");
    await page.getByTestId("decisions-chip-all").click();
    await card.getByRole("link").click();
    await page.getByTestId("detail-workflows").waitFor();
    await page.getByTestId("authority-grant-open").waitFor();
    await page.getByTestId("authority-schedule-held").waitFor();

    const conversations = await page.evaluate(async () =>
      (await fetch("/v1/conversations")).json(),
    );
    const conversation = conversations.items[0];
    const original = await page.evaluate(
      async (id) => (await fetch(`/v1/conversations/${id}`)).json(),
      conversation.id,
    );
    const pattern = `**/v1/conversations/${conversation.id}`;
    const saved = (route) =>
      route.fulfill({
        json: {
          ...original,
          elicitations: [],
          resume_summary: {
            ...original.resume_summary,
            stage: "workflow_saved",
            unsaved: false,
            pending_approval: null,
            active_target: {
              kind: "workflow",
              id: workflowId,
              name: "Held publishing workflow",
              slug: "held-publishing",
              environment: "prod",
            },
          },
        },
      });
    await page.route(pattern, saved);
    try {
      await stand.visit(page, `chat/${conversation.id}`);
      const handoff = page.getByTestId("chat-schedule-next-step");
      await handoff.waitFor();
      const navigationClosed = !(await page.getByTestId("nav-decisions-count").count());
      if (navigationClosed) await page.getByTestId("sidebar-trigger").click();
      const beforeCount = Number(await page.getByTestId("nav-decisions-count").innerText());
      if (navigationClosed) await page.getByTestId("sidebar-trigger").click();
      if (!(await handoff.innerText()).includes("13"))
        throw new Error("Chat does not explain remaining schedule count");
      if (
        !(await page.getByTestId("chat-summary").innerText()).includes(
          locale === "de" ? "gespeichert" : "Saved",
        )
      )
        throw new Error("Saved workflow still presented as unfinished preparation");
      if (
        (await page.getByTestId("chat-status").innerText()) !==
        (locale === "de" ? "Workflow gespeichert" : "Workflow saved")
      )
        throw new Error("Saved workflow still presented as running");
      await capture("chat-saved-handoff");
      await page.getByTestId("chat-context-toggle").click();
      if (
        !(await page.getByTestId("chat-context-checkpoint").innerText()).includes(
          locale === "de" ? "Keine ungespeicherten Änderungen" : "No unsaved changes",
        )
      )
        throw new Error("Saved checkpoint shown as unsaved");
      if (
        !(await page.getByTestId("chat-context-review-schedule").getAttribute("href")).endsWith(
          "#workflow-authorities",
        )
      )
        throw new Error("Context does not link to run permission");
      await page.keyboard.press("Escape");
      await page.getByTestId("chat-review-schedule").click();
      await page.getByTestId("workflow-authorities").waitFor();
      if (!page.url().endsWith("#workflow-authorities"))
        throw new Error("Handoff lost its review destination");
      await page.getByTestId("authority-grant-open").click();
      await page.getByTestId("authority-grant-cancel").waitFor();
      await capture("chat-run-review");
      await page.getByTestId("authority-grant-cancel").click();
      cleared = true;
      await stand.visit(page, `chat/${conversation.id}`);
      await page.getByTestId("chat-summary").waitFor();
      if (!(await page.getByTestId("nav-decisions-count").count()) && beforeCount > 13)
        await page.getByTestId("sidebar-trigger").click();
      await page.waitForFunction(
        (expected) =>
          Number(
            document.querySelector('[data-testid="nav-decisions-count"]')?.textContent?.trim() ?? 0,
          ) === expected,
        beforeCount - 13,
      );
      if (await page.getByTestId("chat-schedule-next-step").count())
        throw new Error("Resolved schedule still shown as blocked");
      await capture("chat-hold-resolved");
    } finally {
      await page.unroute(pattern, saved);
    }
  } finally {
    await page.unroute(schedulePattern, schedules);
    await page.unroute(overviewPattern, overview);
  }
}
