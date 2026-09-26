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
    workflow_id:
      index === 0 ? workflowId : `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    workflow_name: index === 0 ? "Held publishing workflow" : `Scheduled workflow ${index + 1}`,
    // One of them has its repair already saved and waiting. That is the
    // ordinary shape of a hold that has been worked on, and it needs a
    // different next step: not "approve what is running" — that version is
    // exactly why it is held — but "put the prepared one into service".
    prepared_version_id: index === 1 ? "00000000-0000-4000-8000-000000000301" : null,
    admission_hold: {
      ...schedule.admission_hold,
      reason_code:
        index % 2 === 0 ? "execution_authority_required" : "execution_authority_unavailable",
    },
  }));
  let cleared = false;
  const schedules = (route) =>
    route.fulfill({
      json: {
        schedules: cleared ? heldSchedules.slice(1) : heldSchedules,
        total: cleared ? 12 : 13,
      },
    });
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
    // Sixteen, not fifteen: the workflow that is approved and failing counts as
    // an open decision too. It was invisible before — the page listed only what
    // could not start — and a badge that leaves it out is the reason nobody
    // looked.
    if (!count.includes(locale === "de" ? "16 offene Entscheidung" : "16 open decision"))
      throw new Error("Decision total excludes the held schedule or the failing workflow");
    if ((await cards.count()) !== 13) throw new Error("Held schedule queue lost entries");
    const toolbar = await page.getByTestId("decisions-toolbar").boundingBox();
    const firstCard = await card.boundingBox();
    if (!toolbar || !firstCard || toolbar.y >= firstCard.y)
      throw new Error("Controls buried below schedule holds");
    const preparedCard = cards.nth(1);
    const preparedText = await preparedCard.innerText();
    if (!preparedText.includes(locale === "de" ? "vorbereitet" : "prepared"))
      throw new Error("A waiting prepared version is not mentioned where the decision is made");
    if ((await card.innerText()).includes(locale === "de" ? "vorbereitet" : "prepared"))
      throw new Error("A hold with nothing prepared claims a prepared version");
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
    // Arriving from the tile still overrides a saved, unrelated kind filter —
    // that requirement is unchanged. What changed is how: the tile no longer
    // SETS the chip to "schedule", because that one kind covers two sections
    // and so the Blocked number listed the failing workflows too. The arrival
    // now scopes the page itself and says which number it came from.
    if (!(await page.getByTestId("decisions-focus").count()))
      throw new Error("A narrowed queue does not say it is narrowed");
    if (await page.getByTestId("decisions-failing").count())
      throw new Error("The blocked tile leads to the failing workflows as well");
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
    let unsaved = false;
    const saved = (route) =>
      route.fulfill({
        json: {
          ...original,
          elicitations: [],
          resume_summary: {
            ...original.resume_summary,
            stage: unsaved ? "workflow_drafting" : "workflow_saved",
            unsaved,
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
      const beforeCount = (await page.getByTestId("nav-decisions-count").count())
        ? Number(await page.getByTestId("nav-decisions-count").innerText())
        : null;
      if (
        !(await handoff.innerText()).includes(
          locale === "de" ? "für diesen Ablauf" : "this workflow",
        )
      )
        throw new Error("Chat does not explain which decision confirmation resolves");
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
      await page.getByTestId("chat-context-review-schedule").click();
      await page.getByTestId("authority-grant-cancel").waitFor();
      if (!page.url().includes(`/chat/${conversation.id}`)) throw new Error("Review left the chat");
      await page.getByTestId("authority-grant-cancel").click();
      await page.getByTestId("authority-grant-cancel").waitFor({ state: "hidden" });
      await page.keyboard.press("Escape");
      await page.getByTestId("chat-context-review-schedule").waitFor({ state: "hidden" });
      await page.getByTestId("chat-review-schedule").click();
      await page.getByTestId("authority-grant-cancel").waitFor();
      await capture("chat-run-review");
      await page.getByTestId("authority-grant-cancel").click();
      unsaved = true;
      await stand.visit(page, `chat/${conversation.id}`);
      await page.getByTestId("chat-continue-preparation").waitFor();
      if (await page.getByTestId("chat-schedule-next-step").count())
        throw new Error("Run authorization offered before preparation is complete");
      await capture("chat-unsaved-next-step");
      const continuePattern = `**/v1/conversations/${conversation.id}/messages`;
      let continuationCalls = 0;
      await page.route(continuePattern, async (route) => {
        continuationCalls++;
        const body = route.request().postDataJSON();
        if (
          typeof body.message !== "string" ||
          /save_workflow_draft|force_commit/.test(body.message)
        )
          throw new Error("Preparation action sends technical instructions to the user");
        unsaved = false;
        await route.fulfill({
          contentType: "text/event-stream",
          body: `event: outcome\ndata: ${JSON.stringify({ conversation, status: "active" })}\n\n`,
        });
      });
      try {
        await page.getByTestId("chat-continue-preparation").click();
        await page.getByTestId("chat-schedule-next-step").waitFor();
        if (continuationCalls !== 1)
          throw new Error("Preparation did not use one normal conversation turn");
      } finally {
        await page.unroute(continuePattern);
      }
      unsaved = false;
      const previewPattern = `**/v1/workflows/${workflowId}/versions/*/authority-preview?*`;
      const grantPattern = `**/v1/workflows/${workflowId}/execution-authorities`;
      let review;
      let grants = 0;
      await page.route(previewPattern, async (route) => {
        const url = new URL(route.request().url());
        const from = new Date().toISOString();
        review = {
          digest: "a".repeat(64),
          manifest: {
            workflow_id: workflowId,
            workflow_version_id: url.pathname.split("/").at(-2),
            execution_environment: "prod",
            effects: [],
          },
          eligible_for_repeated_runs: true,
          unavailable_steps: [],
          suggested_bounds: {
            valid_from: from,
            valid_until: new Date(Date.parse(from) + 86400000).toISOString(),
            max_runs: 1,
          },
          execution_shape: { requests: [], iterations: [], run_limit_is_request_limit: false },
        };
        await route.fulfill({ json: review });
      });
      await page.route(grantPattern, async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        const body = route.request().postDataJSON();
        if (
          body.workflow_version_id !== review.manifest.workflow_version_id ||
          body.execution_environment !== "prod" ||
          body.expected_manifest_digest !== review.digest
        )
          throw new Error("Chat grant lost its reviewed boundary");
        grants++;
        cleared = true;
        await route.fulfill({
          status: 201,
          json: { ...body, id: workflowId, ready_for_new_run: true },
        });
      });
      try {
        await page.getByTestId("chat-review-schedule").click();
        await page.getByTestId("authority-grant-review").waitFor();
        if (cleared || grants) throw new Error("Opening review resolved the decision");
        await page.getByTestId("authority-grant-confirm").click();
        await page.getByTestId("authority-grant-cancel").waitFor({ state: "hidden" });
        if (grants !== 1) throw new Error("Decision was not completed by one explicit grant");
        await page.getByTestId("chat-schedule-next-step").waitFor({ state: "hidden" });
        if (beforeCount !== null)
          await page.waitForFunction(
            (expected) =>
              Number(
                document
                  .querySelector('[data-testid="nav-decisions-count"]')
                  ?.textContent?.trim() ?? 0,
              ) === expected,
            beforeCount - 1,
          );
      } finally {
        await page.unroute(previewPattern);
        await page.unroute(grantPattern);
      }
      await stand.visit(page, `chat/${conversation.id}`);
      await page.getByTestId("chat-summary").waitFor();
      if (beforeCount !== null)
        await page.waitForFunction(
          (expected) =>
            Number(
              document.querySelector('[data-testid="nav-decisions-count"]')?.textContent?.trim() ??
                0,
            ) === expected,
          beforeCount - 1,
        );
      if (await page.getByTestId("chat-schedule-next-step").count())
        throw new Error("Resolved schedule still shown as blocked");
      await page.keyboard.press("Escape");
      await capture("chat-hold-resolved");
    } finally {
      await page.unroute(pattern, saved);
    }
  } finally {
    await page.unroute(schedulePattern, schedules);
    await page.unroute(overviewPattern, overview);
  }
}
