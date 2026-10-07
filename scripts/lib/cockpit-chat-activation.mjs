import { assertSingleTriggers, TRANSCRIPT } from "./cockpit-single-trigger.mjs";

export async function verifyChatActivation(page, stand, conversation, locale) {
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
        {
          id: "automation-review",
          role: "assistant",
          created_at: conversation.updated_at,
          parts: [
            {
              type: "dynamic-tool",
              toolName: "review_workflow_automation",
              toolCallId: "review-automation",
              state: "output-available",
              input: { workflow_id: workflowId },
              output: {
                ok: true,
                data: {
                  kind: "workflow_automation_review",
                  workflow_id: workflowId,
                  schedules: [{ workflow_id: workflowId, environment: "prod" }],
                },
              },
            },
          ],
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
  const baseAnswer = await page.evaluate(async () => (await fetch("/v1/attention")).json());
  const baseAttention = {
    ...baseAnswer,
    items: baseAnswer.items.filter((item) => item.id !== `workflow:${workflowId}`),
  };
  await route("**/v1/attention*", (r) =>
    fulfill(r, {
      ...baseAttention,
      items: completed
        ? baseAttention.items
        : [
            {
              id: `workflow:${workflowId}`,
              class: "stopped",
              severity: "critical",
              kind: "workflow",
              subject: { kind: "workflow", id: workflowId, name: "Daily report" },
              reason: "execution_authority_required",
              cause_class: null,
              counts: {},
              since: new Date().toISOString(),
              deadline: null,
              detail: null,
              actions: [
                {
                  verb: "review",
                  href: `/cockpit?review=workflow:${workflowId}`,
                  primary: true,
                  permission: "workflow:write",
                },
              ],
            },
            ...baseAttention.items,
          ],
    }),
  );
  await route(`**/v1/workflows/${workflowId}`, (r) =>
    fulfill(r, {
      id: workflowId,
      name: "Daily report",
      slug: "daily-report",
      lifecycle: "active",
      current_version: completed ? 3 : 2,
      current_version_id: completed ? draftId : activeId,
      draft_version_id: completed ? null : draftId,
      webhooks_active: 0,
    }),
  );
  await route(`**/v1/workflows/${workflowId}/automation-status`, (r) =>
    fulfill(r, {
      schedules: [
        {
          schedule_id: workflowId,
          workflow_id: workflowId,
          state: completed ? "authorized" : "approval_required",
          ready: completed,
          cron: "0 8 * * *",
          timezone: "UTC",
          environment: "prod",
          next_run_at: "2026-10-01T08:00:00.000Z",
        },
      ],
      inbound_hooks: [],
    }),
  );
  await route(`**/v1/workflows/${workflowId}/diagnosis?*`, (r) =>
    fulfill(r, {
      workflow_id: workflowId,
      workflow_version_id: completed ? draftId : activeId,
      environment: "prod",
      is_current: completed,
      diagnoses: [],
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
                target: "https://mail.example.com/v1/messages/send",
                report_delivery: {
                  kind: "gmail_report",
                  from: "sender@example.test",
                  to: "recipient@example.test",
                  content_type: "text/html",
                },
              },
              {
                step_id: "purge",
                effect: "destructive",
                operation: "DELETE",
                target: "https://store.example.test/bucket/reports/expired/*",
                storage: {
                  base_url: "https://store.example.test/bucket/",
                  key_prefix: "reports/expired/",
                  operation: "DELETE",
                  max_bytes: 10,
                  max_keys: 1000,
                  paginate: false,
                  content_type: null,
                  max_deletes: 4321,
                },
              },
              {
                step_id: "retire",
                effect: "write",
                operation: "POST",
                target: "https://api.example.test/v2/sites/{input.site}/releases",
                boundary: {
                  base_url: "https://api.example.test/v2",
                  method: "POST",
                  origin: "https://api.example.test",
                  segments: ["", "v2", "sites", { var: "input.site" }, "releases"],
                  variables: { "input.site": { enum: ["site-alpha"] } },
                  query: { fixed: {}, variable: [] },
                  max_body_bytes: 54321,
                  max_calls: 7,
                },
              },
              {
                step_id: "stats",
                effect: "read",
                operation: "GET",
                target: "https://api.example.test/v2/sites/{input.site}/stats/{item.id}",
                boundary: {
                  base_url: "https://api.example.test/v2",
                  method: "GET",
                  origin: "https://api.example.test",
                  segments: ["", "v2", "sites", { var: "input.site" }, "stats", { var: "item.id" }],
                  variables: {
                    "input.site": { enum: ["site-alpha"] },
                    "item.id": { class: "uuid" },
                    "scope.window.data.start": { class: "timestamp" },
                  },
                  query: {
                    fixed: { tz: "UTC" },
                    variable: [{ key: "from", var: "scope.window.data.start" }],
                  },
                  max_body_bytes: 0,
                  max_calls: 31,
                },
              },
              {
                step_id: "mystery",
                effect: "read",
                operation: "GET",
                target: "https://api.example.test/v2/mystery/{item.key}",
                boundary: {
                  base_url: "https://api.example.test/v2",
                  method: "GET",
                  origin: "https://api.example.test",
                  segments: ["", "v2", "mystery", { var: "item.key" }],
                  variables: { "item.key": { class: "anything_goes" } },
                  query: { fixed: {}, variable: [] },
                  max_body_bytes: 0,
                  max_calls: 1,
                },
              },
              {
                step_id: "archive",
                effect: "write",
                operation: "POST",
                target: "https://api.example.test/v2/sites/{input.site}/archive",
                boundary: {
                  base_url: "https://api.example.test/v2",
                  method: "POST",
                  origin: "https://api.example.test",
                  segments: ["", "v2", "sites", { var: "input.site" }, "archive"],
                  variables: { "input.site": { enum: ["site-alpha"] } },
                  query: { fixed: {}, variable: [] },
                  max_body_bytes: 2048,
                  max_calls: 1,
                  destructive: true,
                },
              },
              {
                step_id: "drop",
                effect: "destructive",
                operation: "DELETE",
                target: "https://api.example.test/v2/sites/{input.site}/cache",
                boundary: {
                  base_url: "https://api.example.test/v2",
                  method: "DELETE",
                  origin: "https://api.example.test",
                  segments: ["", "v2", "sites", { var: "input.site" }, "cache"],
                  variables: { "input.site": { enum: ["site-alpha"] } },
                  query: { fixed: {}, variable: [] },
                  max_body_bytes: 0,
                  max_calls: 1,
                  destructive: true,
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
      suggested_bounds_basis: { kind: "schedule", scheduled_runs: 3 },
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
    const count = page.getByTestId("nav-overview-count");
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
    const action = page.getByTestId("chat-automation-tool-review");
    await page.getByTestId("chat-transcript").getByTestId("chat-automation-tool").waitFor();
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
    const removal = page.getByTestId("authority-storage-boundary-destructive");
    await removal.waitFor();
    const removalText = await removal.innerText();
    if (!removalText.includes("reports/expired/")) throw new Error("Removal folder not shown");
    if (!removalText.replace(/[.,\u202f\u00a0 ]/g, "").includes("4321"))
      throw new Error("Removal ceiling not shown to the approver");
    if (!/löschen|delete/i.test(removalText))
      throw new Error("A removal boundary does not say that it deletes");
    if (/\blesen\b|\bread\b/i.test(removalText))
      throw new Error("A removal boundary is presented to the approver as a read");
    if ((await page.getByTestId("authority-storage-boundary").count()) !== 0)
      throw new Error("A removal boundary was also rendered as a non-destructive panel");
    const sendPanels = page.getByTestId("authority-request-boundary");
    await sendPanels.first().waitFor();
    if ((await sendPanels.count()) !== 2)
      throw new Error("A cautious request boundary was also rendered as a non-destructive panel");
    const classText = (await sendPanels.allInnerTexts()).find((text) =>
      text.includes("/stats/{item.id}"),
    );
    if (!classText) throw new Error("The class-bound request is not shown with its target");
    if (!classText.includes("from={scope.window.data.start}"))
      throw new Error("A varying query value is missing from the reviewed target");
    if (!/UUID/.test(classText) || !/UTC/.test(classText))
      throw new Error("A value class is not described to the approver in words");
    if (!/only what the value looks like|nur, wie der Wert aussieht/i.test(classText))
      throw new Error("The approver is not told that a class approves a form, not a list");
    const sendText = await sendPanels.first().innerText();
    const sendDigits = sendText.replace(/[.,\u202f\u00a0 ]/g, "");
    if (!sendText.includes("/v2/sites/{input.site}/releases"))
      throw new Error("Request boundary does not show its reviewed target");
    if (!sendText.includes("site-alpha"))
      throw new Error("Request boundary does not show the only value its variable may take");
    if (!sendDigits.includes("54321")) throw new Error("Request size ceiling not shown");
    if (!/\b7\b/.test(sendText)) throw new Error("Request call ceiling not shown");
    if (!/not yet counted|noch nicht mitgezählt/i.test(sendText))
      throw new Error("The call ceiling is presented as enforced, which it is not yet");
    if (!/run time|Laufzeit/i.test(sendText))
      throw new Error("The approver is not told that the content is decided at run time");
    if (/\blesen\b|\bread\b/i.test(sendText))
      throw new Error("A sending request boundary is presented to the approver as a read");
    const cautious = page.getByTestId("authority-request-boundary-destructive");
    if ((await cautious.count()) !== 3)
      throw new Error("A destructive or unrecognised request boundary is shown as harmless");
    const cautiousTexts = await cautious.allInnerTexts();
    const dropText = cautiousTexts.find((text) => text.includes("/v2/sites/{input.site}/cache"));
    if (!dropText) throw new Error("Request removal does not show its reviewed target");
    if (!/löschen|delete/i.test(dropText))
      throw new Error("A request removal does not say that it deletes");
    const mysteryText = cautiousTexts.find((text) => text.includes("/v2/mystery/{item.key}"));
    if (!mysteryText || !/anything_goes/.test(mysteryText))
      throw new Error("An unrecognised rule is not named to the approver");
    if (!/nicht freigeben|Do not approve/i.test(mysteryText))
      throw new Error("An unrecognised rule does not warn against approving");
    const archiveText = cautiousTexts.find((text) =>
      text.includes("/v2/sites/{input.site}/archive"),
    );
    if (!archiveText) throw new Error("The author's destructive mark on a POST was dropped");
    if (!/entfernt|removes/i.test(archiveText))
      throw new Error("A POST marked destructive does not tell the approver why it is cautious");
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
    const deadline = Date.now() + 5_000;
    let after = await decisionCount();
    while (after === before && Date.now() < deadline) {
      await page.waitForTimeout(250);
      after = await decisionCount();
    }
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
    if (
      (await page.getByTestId("chat-transcript").getByTestId("chat-automation-tool").count()) !== 1
    )
      throw new Error("The review card is outside the chronological transcript");
    if (await page.getByTestId("chat-schedule-next-step").count())
      throw new Error("The held-schedule hand-off repeats the review card's way into the approval");
    await page.waitForLoadState("networkidle");
    await assertSingleTriggers(page, `${locale}/chat-activation`, {
      ...TRANSCRIPT,
      approvalOpeners: 1,
    });
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
    const singleRunEntry = action;
    await singleRunEntry.waitFor();
    await singleRunEntry.click();
    await page.getByTestId("authority-activate-only").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    if (activations !== 1 || messages !== 0 || grants !== 3)
      throw new Error(
        `Putting a version into service alone also sent ${messages} chat turn(s) or granted something`,
      );
    await singleRunEntry.waitFor();
    await singleRunEntry.click();
    await page.getByTestId("authority-single-run").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    if (
      activations !== 2 ||
      messages !== 1 ||
      grants !== 3 ||
      !page.url().includes(`/chat/${conversation.id}`)
    )
      throw new Error("One-shot handoff did not stay in chat exactly once");
  } finally {
    for (const [pattern, handler] of routes.reverse()) await page.unroute(pattern, handler);
  }
}
