/** Chat stays on the exact saved draft through review, conflict and completion. */
export async function verifyChatActivation(page, stand, conversation, _locale) {
  await stand.visit(page, `chat/${conversation.id}`);
  const original = await page.evaluate(
    async (id) => (await fetch(`/v1/conversations/${id}`)).json(),
    conversation.id,
  );
  const workflowId = conversation.id;
  const activeId = "00000000-0000-4000-8000-000000000041";
  const draftId = "00000000-0000-4000-8000-000000000042";
  let completed = false,
    unsupported = false,
    opaque = false,
    conflict = true,
    expiredSession = false,
    grants = 0,
    activations = 0,
    messages = 0;
  const routes = [];
  const route = async (pattern, handler) => {
    await page.route(pattern, handler);
    routes.push([pattern, handler]);
  };
  const fulfill = (r, data) => r.fulfill({ json: data });
  await route(`**/v1/conversations/${conversation.id}`, (r) =>
    fulfill(r, {
      ...original,
      conversation: { ...original.conversation, target_workflow_id: workflowId },
      tool_calls: [],
      messages: [
        {
          id: "user-request",
          role: "user",
          created_at: conversation.updated_at,
          parts: [{ type: "text", text: "Bitte den Bericht vorbereiten." }],
        },
      ],
      resume_summary: {
        ...original.resume_summary,
        stage: "workflow_saved",
        unsaved: false,
        pending_approval: null,
        active_target: {
          kind: "workflow",
          id: workflowId,
          name: "Daily report",
          slug: "daily-report",
          environment: "prod",
        },
      },
    }),
  );
  await route("**/v1/schedules*", (r) =>
    fulfill(r, {
      schedules: completed
        ? []
        : [
            {
              id: workflowId,
              workflow_id: workflowId,
              workflow_name: "Daily report",
              workflow_slug: "daily-report",
              paused: false,
              cron: "0 8 * * *",
              timezone: "UTC",
              execution_mode: "prod",
              admission_hold: {
                reason_code: "execution_authority_required",
                observed_at: new Date().toISOString(),
              },
            },
          ],
      total: completed ? 0 : 1,
    }),
  );
  await route(`**/v1/workflows/${workflowId}`, (r) =>
    fulfill(r, {
      id: workflowId,
      current_version_id: completed ? draftId : activeId,
      draft_version_id: completed ? null : draftId,
    }),
  );
  await route(`**/v1/workflows/${workflowId}/automation-status`, (r) =>
    fulfill(r, {
      schedules: [{ ready: completed, next_run_at: "2026-10-01T08:00:00.000Z", timezone: "UTC" }],
    }),
  );
  await route(`**/v1/workflows/${workflowId}/draft`, (r) =>
    fulfill(r, {
      workflow_id: workflowId,
      version_id: draftId,
      current_version_id: activeId,
      version: 3,
      definition: { name: "Daily report", steps: [] },
    }),
  );
  await route(`**/v1/workflows/${workflowId}/versions/*/authority-preview?*`, (r) => {
    if (!r.request().url().includes(draftId))
      throw new Error("Chat reviewed the older active version");
    // Use one instant so the suggested duration is exactly 24 whole hours.
    const preparedAt = Date.now();
    return fulfill(r, {
      digest: "a".repeat(64),
      eligible_for_repeated_runs: !unsupported,
      unavailable_steps: [],
      manifest: {
        workflow_id: workflowId,
        workflow_version_id: draftId,
        execution_environment: "prod",
        effects: unsupported
          ? []
          : [
              {
                step_id: "send",
                effect: "write",
                operation: "POST",
                target: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
                report_delivery: {
                  kind: "gmail_report",
                  from: "sender@example.test",
                  to: "recipient@example.test",
                  content_type: "text/html",
                },
              },
            ],
        issues: [],
      },
      execution_shape: {
        requests: opaque
          ? [
              {
                step_id: "store",
                request_review_truncated: false,
                opaque_payload_omitted: true,
                redacted_request_json: "{}",
                retry_policy_max_attempts: 1,
              },
            ]
          : [],
        iterations: [],
        run_limit_is_request_limit: false,
      },
      schedules: [{ cron: "0 8 * * *", timezone: "UTC", next_run_at: "2026-10-01T08:00:00.000Z" }],
      suggested_bounds: {
        valid_from: new Date(preparedAt).toISOString(),
        valid_until: new Date(preparedAt + 86400000).toISOString(),
        max_runs: 3,
      },
    });
  });
  await route(`**/v1/workflows/${workflowId}/execution-authorities`, (r) => {
    if (r.request().method() !== "POST") return fulfill(r, { items: [] });
    const body = r.request().postDataJSON();
    if (
      body.workflow_version_id !== draftId ||
      body.activation?.expected_current_version_id !== activeId ||
      body.execution_environment !== "prod"
    )
      throw new Error("Activation lost its exact reviewed boundary");
    grants++;
    if (expiredSession)
      return r.fulfill({
        status: 403,
        json: { code: "human_session_expired", message: "expired" },
      });
    if (conflict)
      return r.fulfill({
        status: 409,
        json: { code: "authority_activation_changed", message: "changed" },
      });
    completed = true;
    return fulfill(r, { id: draftId });
  });
  await route(`**/v1/workflows/${workflowId}/activate-draft`, (r) => {
    const body = r.request().postDataJSON();
    if (
      body.workflow_version_id !== draftId ||
      body.expected_current_version_id !== activeId ||
      "max_runs" in body
    )
      throw new Error("One-shot preparation silently granted repeated execution");
    activations++;
    return fulfill(r, {
      workflow_version_id: draftId,
      activated: true,
      execution_authorized: false,
    });
  });
  await route(`**/v1/conversations/${conversation.id}/messages`, (r) => {
    messages++;
    if (!r.request().postDataJSON()?.message) throw new Error("Missing preparation request");
    return r.fulfill({
      contentType: "text/event-stream",
      body: `event: outcome\ndata: ${JSON.stringify({ conversation, status: "active" })}\n\n`,
    });
  });
  const decisionCount = async () => {
    const count = page.getByTestId("nav-decisions-count");
    // A refetch can briefly remove the badge. It does not mean the viewport
    // became mobile: toggling the desktop sidebar then would hide the result.
    const mobile = page.viewportSize().width < 768;
    const sidebar = page.locator('[data-slot="sidebar"]');
    const needsOpen = mobile
      ? !(await page.locator('[data-slot="sidebar"][data-mobile="true"]').isVisible())
      : (await sidebar.getAttribute("data-state")) === "collapsed";
    if (needsOpen) await page.getByTestId("sidebar-trigger").click();
    await count.waitFor();
    const value = Number(await count.innerText());
    if (mobile) {
      await page
        .locator('[data-slot="sheet-overlay"]')
        .click({ position: { x: page.viewportSize().width - 8, y: 20 } });
      await page.locator('[data-slot="sidebar"][data-mobile="true"]').waitFor({ state: "hidden" });
    }
    return value;
  };
  try {
    await stand.visit(page, `chat/${conversation.id}`);
    const action = page.getByTestId("chat-review-schedule");
    await action.waitFor();
    if (
      page.viewportSize().width >= 768 &&
      (await page.locator('[data-slot="sidebar"]').getAttribute("data-state")) === "expanded"
    )
      await page.getByTestId("sidebar-trigger").click();
    const before = await decisionCount();
    const bubble = page.getByTestId("chat-message-0-text-0");
    await bubble.waitFor();
    if ((await bubble.evaluate((n) => getComputedStyle(n).backgroundColor)) === "rgba(0, 0, 0, 0)")
      throw new Error("User request has no visible tone");
    await action.click();
    await page.getByTestId("authority-grant-confirm").waitFor();
    if (grants) throw new Error("Opening review granted permission");
    await page.getByTestId("authority-report-boundary").waitFor();
    if (
      !(await page.getByTestId("authority-report-boundary").innerText()).includes(
        "recipient@example.test",
      )
    )
      throw new Error("Missing reviewed recipient");
    await page.getByTestId("authority-grant-confirm").click();
    await page.getByTestId("authority-prepare").waitFor();
    if (!(await page.getByTestId("authority-grant-confirm").isDisabled()))
      throw new Error("Conflict did not block stale confirmation");
    conflict = false;
    expiredSession = true;
    await page.getByTestId("authority-prepare").click();
    await page.getByTestId("authority-grant-confirm").click();
    const signIn = page.getByTestId("authority-sign-in");
    await signIn.waitFor();
    if (
      !(await signIn.getAttribute("href")).includes(
        encodeURIComponent(`/cockpit/chat/${conversation.id}`),
      )
    )
      throw new Error("Session recovery lost the current conversation");
    if (await page.getByTestId("authority-prepare").count())
      throw new Error("Expired session incorrectly offered a grant retry");
    await page.getByTestId("authority-grant-cancel").click();
    expiredSession = false;
    await action.click();
    await page.getByTestId("authority-grant-confirm").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    await page.getByTestId("chat-schedule-next-step").waitFor({ state: "hidden" });
    await page.getByTestId("chat-automation-ready").waitFor();
    const after = await decisionCount();
    if (after !== before - 1)
      throw new Error(`Decision count did not decrease once: ${before} -> ${after}`);
    await page.reload();
    await page.getByTestId("chat-transcript").waitFor();
    if (await page.getByTestId("chat-schedule-next-step").count())
      throw new Error("Completed decision returned after reload");
    await page.getByTestId("chat-automation-ready").waitFor();
    completed = false;
    unsupported = true;
    opaque = true;
    await page.reload();
    await action.waitFor();
    const inTranscript = await page
      .getByTestId("chat-transcript")
      .getByTestId("chat-schedule-next-step")
      .count();
    if (inTranscript !== 1) throw new Error("Next action is outside the chronological transcript");
    await action.click();
    if (await page.getByTestId("authority-single-run").count())
      throw new Error("Unavailable one-shot action still displayed");
    if (await page.getByTestId("authority-incomplete").count())
      throw new Error("Unsupported actions mislabeled as missing details");
    if (!(await page.getByTestId("authority-adjust").isEnabled()))
      throw new Error("No actionable recovery in unsupported review");
    await page.getByTestId("authority-adjust").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    if (
      messages !== 1 ||
      activations !== 0 ||
      grants !== 3 ||
      !page.url().includes(`/chat/${conversation.id}`)
    )
      throw new Error(
        "Unsupported review did not continue in the same chat without granting permission",
      );
    messages = 0;
    opaque = false;
    await page.reload();
    await action.waitFor();
    await action.click();
    await page.getByTestId("authority-single-run").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    if (
      activations !== 1 ||
      messages !== 1 ||
      grants !== 3 ||
      !page.url().includes(`/chat/${conversation.id}`)
    )
      throw new Error("One-shot handoff did not stay in chat exactly once");
  } finally {
    for (const [pattern, handler] of routes.reverse()) await page.unroute(pattern, handler);
  }
}
