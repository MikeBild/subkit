import { assertSingleTriggers, TRANSCRIPT } from "./cockpit-single-trigger.mjs";

/** Database enforcement is covered by the scheduler and HTTP integration suites. */
export async function verifyScheduleHolds(page, stand, workflowId, locale, capture) {
  const schedulePattern = "**/v1/schedules*";
  const attentionPattern = "**/v1/attention*";
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
  const open = () => (cleared ? heldSchedules.slice(1) : heldSchedules);
  const schedules = (route) => route.fulfill({ json: { schedules: open(), total: open().length } });
  // Übersicht's answer for the same installation: one stopped entry per held
  // workflow, and nothing else — so the badge has one number to agree with.
  const attention = (route) =>
    route.fulfill({
      json: {
        schema_version: "attention.v1",
        generated_at: new Date().toISOString(),
        sources: Object.fromEntries(
          [
            "conversations",
            "schedules",
            "freshness",
            "failures",
            "patches",
            "connectors",
            "connections",
            "secret_approvals",
            "skills",
            "budget",
            "risk",
          ].map((source) => [source, "answered"]),
        ),
        status: { health_state: "critical", next_run_at: null },
        items: open().map((held) => ({
          id: `workflow:${held.workflow_id}`,
          class: "stopped",
          severity: "critical",
          kind: "workflow",
          subject: { kind: "workflow", id: held.workflow_id, name: held.workflow_name },
          reason: held.admission_hold.reason_code,
          trigger: { kind: "schedule", name: null },
          cause_class: null,
          counts: {},
          since: held.admission_hold.observed_at,
          deadline: null,
          detail: null,
          actions: [
            {
              verb: "review",
              href: `/cockpit?review=workflow:${held.workflow_id}`,
              primary: true,
              permission: "workflow:write",
            },
          ],
        })),
      },
    });
  await page.route(schedulePattern, schedules);
  await page.route(attentionPattern, attention);
  try {
    await stand.visit(page, "");
    const entries = page.locator('[data-testid="attention-list"] > li');
    await entries.first().waitFor();
    if ((await entries.count()) !== 13)
      throw new Error(`Übersicht lists ${await entries.count()} held workflows, not 13`);
    if (await page.getByTestId("attention-calm").count())
      throw new Error("Held schedules presented as all done");
    // The badge sits in the sidebar, which narrow widths render off-canvas and
    // so not at all until opened; there the list carries the check alone.
    const badgeLocator = page.getByTestId("nav-overview-count");
    if (await badgeLocator.count()) {
      const badge = (await badgeLocator.first().innerText()).trim();
      if (badge !== "13") throw new Error(`Übersicht's badge reads ${badge}, the list holds 13`);
      if ((await badgeLocator.first().getAttribute("data-attention-stopped")) !== "true")
        throw new Error("Stopped workflows and the badge is not red");
    }
    const first = entries.first();
    if (!(await first.innerText()).includes("Held publishing workflow"))
      throw new Error("The held workflow is not named on its entry");
    await capture("today");
    await first.locator('[data-testid$="-primary"]').click();
    const sheet = page.getByTestId("attention-review");
    await sheet.waitFor();
    if (!page.url().includes(`review=workflow`))
      throw new Error("The review sheet has no address of its own");
    const card = sheet.getByTestId("schedule-admission-held");
    await card.waitFor();
    if ((await sheet.getByTestId("schedule-admission-held").count()) !== 1)
      throw new Error("The sheet holds another workflow's hold");
    if ((await card.innerText()).includes(locale === "de" ? "vorbereitet" : "prepared"))
      throw new Error("A hold with nothing prepared claims a prepared version");
    // The action under the words it acts on, not askew beside them.
    const actionBox = await card.getByTestId("schedule-admission-review").boundingBox();
    const sinceBox = await card.getByTestId("schedule-admission-since").boundingBox();
    if (!actionBox || !sinceBox || actionBox.y < sinceBox.y + sinceBox.height - 1)
      throw new Error("The schedule card's action sits beside its text, not below it");
    const details = card.getByTestId("schedule-admission-details");
    if ((await details.getAttribute("open")) !== null)
      throw new Error("Technical schedule details should start collapsed");
    await details.locator("summary").focus();
    await page.keyboard.press("Enter");
    if ((await details.getAttribute("open")) === null)
      throw new Error("Schedule details not keyboard accessible");
    await page.keyboard.press("Enter");
    await capture("decision");
    // Back closes the sheet: it has an address, so the browser's own button
    // is the way out.
    await page.goBack();
    await sheet.waitFor({ state: "hidden" });
    await stand.visit(page, `?review=workflow:${heldSchedules[1].workflow_id}`);
    const prepared = page.getByTestId("attention-review").getByTestId("schedule-admission-held");
    await prepared.waitFor();
    if (!(await prepared.innerText()).includes(locale === "de" ? "vorbereitet" : "prepared"))
      throw new Error("A waiting prepared version is not mentioned where the decision is made");
    await stand.visit(page, `?review=workflow:${workflowId}`);
    await card.waitFor();
    await card.getByRole("link").click();
    await page.getByTestId("detail-workflows").waitFor();
    // The held schedule is the page's one state — "approval needed" — with the
    // one action that resolves it, in the panel and nowhere else on the page.
    // No badge repeats it, and nothing only scrolls to it.
    const automation = page.getByTestId("workflow-automation");
    await page.getByTestId("workflow-automation-action").waitFor();
    if ((await automation.getAttribute("data-state")) !== "grant")
      throw new Error(
        `A held schedule reads as "${await automation.getAttribute("data-state")}", not as approval needed`,
      );
    const approve = locale === "de" ? "Jetzt freigeben" : "Approve now";
    if ((await page.getByTestId("workflow-automation-action").innerText()).trim() !== approve)
      throw new Error("The panel does not offer the approval the held schedule waits for");
    await page.waitForLoadState("networkidle");
    await assertSingleTriggers(page, `${locale}/schedule-held workflow page`, {
      approvalOpeners: 1,
    });
    if (await page.getByTestId("authority-schedule-held").count())
      throw new Error("The held schedule is announced a second time by a badge");
    if (
      !(await page.getByTestId("workflow-automation-triggers").innerText()).includes(
        locale === "de" ? "täglich um 08:00" : "daily at 08:00",
      )
    )
      throw new Error("The panel does not name the schedule it is about");

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
      const beforeCount = (await page.getByTestId("nav-overview-count").count())
        ? Number(await page.getByTestId("nav-overview-count").innerText())
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
      // No review card in this transcript: the hand-off is the one way in.
      await page.waitForLoadState("networkidle");
      await assertSingleTriggers(page, `${locale}/chat hand-off`, {
        ...TRANSCRIPT,
        approvalOpeners: 1,
      });
      await capture("chat-saved-handoff");
      await page.getByTestId("chat-context-toggle").click();
      // The context panel is a view of its own. It says the held schedule's
      // sentence once — under the next action — and offers the review once.
      const panel = page.getByRole("dialog");
      await panel.getByTestId("chat-context-review-schedule").waitFor();
      const sentence =
        locale === "de"
          ? "Automatische Läufe sind für diesen Ablauf noch nicht freigegeben"
          : "Automatic runs for this workflow are not approved yet";
      const said = (await panel.innerText()).split(sentence).length - 1;
      if (said !== 1)
        throw new Error(`The context panel says the held schedule's sentence ${said} times`);
      await assertSingleTriggers(page, `${locale}/chat context panel`, {
        root: '[role="dialog"]',
        approvalOpeners: 1,
      });
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
          suggested_bounds_basis: { kind: "manual" },
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
                document.querySelector('[data-testid="nav-overview-count"]')?.textContent?.trim() ??
                  0,
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
              document.querySelector('[data-testid="nav-overview-count"]')?.textContent?.trim() ??
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
    await page.unroute(attentionPattern, attention);
  }
}
