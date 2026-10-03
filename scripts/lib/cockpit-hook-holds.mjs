/**
 * A workflow only a webhook starts, held by the authority gate: Übersicht names
 * the webhook, the review sheet's hook card opens the approval where it stands,
 * and the approval asks for a sample call instead of running over `{}`.
 *
 * Database enforcement is covered by the engine journey for refused webhooks.
 */
export async function verifyHookHolds(page, stand, workflowId, locale, capture) {
  const slug = "findings-inbox";
  const observedAt = new Date().toISOString();
  const hook = {
    inbound_hook_id: "00000000-0000-4000-8000-000000000591",
    workflow_id: workflowId,
    slug,
    state: "approval_required",
    ready: false,
    environment: "prod",
    admission_hold: { reason_code: "execution_authority_required", observed_at: observedAt },
    last_refused_at: observedAt,
    last_refused_reason: "execution_authority_required",
  };
  const delivered = {
    id: "msg_2YcX",
    timestamp: 1_790_000_000,
    type: "finding.created",
    headers: { "content-type": "application/json" },
    body: { finding: { id: "F-17", severity: "high" } },
  };
  const attentionPattern = "**/v1/attention*";
  const statusPattern = `**/v1/workflows/${workflowId}/automation-status`;
  const previewPattern = `**/v1/workflows/${workflowId}/versions/*/authority-preview?*`;
  const preparePattern = `**/v1/workflows/${workflowId}/versions/*/prepare-authority`;
  const executionsPattern = "**/v1/executions?*";
  let prepared = false;
  const prepareBodies = [];
  const attention = (route) =>
    route.fulfill({
      json: {
        schema_version: "attention.v1",
        generated_at: observedAt,
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
        items: [
          {
            id: `workflow:${workflowId}`,
            class: "stopped",
            severity: "critical",
            kind: "workflow",
            subject: { kind: "workflow", id: workflowId, name: "Finding triage" },
            reason: "execution_authority_required",
            trigger: { kind: "inbound_hook", name: slug },
            cause_class: null,
            counts: {},
            since: observedAt,
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
        ],
      },
    });
  const status = (route) => route.fulfill({ json: { schedules: [], inbound_hooks: [hook] } });
  const preview = (route) => {
    const url = new URL(route.request().url());
    const from = new Date().toISOString();
    return route.fulfill({
      json: {
        digest: "d".repeat(64),
        manifest: {
          workflow_id: workflowId,
          workflow_version_id: url.pathname.split("/").at(-2),
          execution_environment: "prod",
          effects: [],
          issues: [],
        },
        // Unbound until the held run has observed a real call.
        eligible_for_repeated_runs: prepared,
        preparation_required: !prepared,
        unavailable_steps: prepared ? [] : ["notify"],
        // What the engine suggests for a hook that was barely called: thirty
        // days and the floor, with the reason beside it.
        suggested_bounds: {
          valid_from: from,
          valid_until: new Date(Date.parse(from) + 30 * 86_400_000).toISOString(),
          max_runs: 100,
        },
        suggested_bounds_basis: {
          kind: "hook",
          scheduled_runs: 0,
          observed_deliveries: 3,
          observed_days: 14,
          minimum_applied: true,
        },
        execution_shape: { requests: [], iterations: [], run_limit_is_request_limit: false },
      },
    });
  };
  const prepare = (route) => {
    const body = route.request().postDataJSON();
    prepareBodies.push(body);
    if (body.input === undefined)
      return route.fulfill({
        json: {
          prepared: false,
          reason: "input_required",
          trigger: { kind: "inbound_hook", slug },
        },
      });
    prepared = true;
    return route.fulfill({ json: { prepared: true } });
  };
  // The newest call this workflow received — what the sample field starts from.
  const executions = (route) => {
    const search = new URL(route.request().url()).searchParams;
    if (search.get("request_source") !== "webhook" || search.get("workflow_id") !== workflowId)
      return route.fallback();
    return route.fulfill({ json: { items: [{ input: delivered }], total: 1 } });
  };
  const routes = [
    [attentionPattern, attention],
    [statusPattern, status],
    [previewPattern, preview],
    [preparePattern, prepare],
    [executionsPattern, executions],
  ];
  for (const [pattern, handler] of routes) await page.route(pattern, handler);
  try {
    await stand.visit(page, "");
    const entry = page.locator('[data-testid="attention-list"] > li').first();
    await entry.waitFor();
    const sentence = await entry.innerText();
    if (!sentence.includes(slug)) throw new Error("Übersicht does not name the waiting webhook");
    if (sentence.includes(locale === "de" ? "Zeitplan" : "schedule"))
      throw new Error(`A held webhook is announced as a schedule: ${sentence}`);
    await capture("today");
    await entry.locator('[data-testid$="-primary"]').click();
    const sheet = page.getByTestId("attention-review");
    const card = sheet.getByTestId("inbound-hook-admission-held");
    await card.waitFor();
    if ((await card.innerText()).includes(locale === "de" ? "Zeitplan" : "Schedule"))
      throw new Error("The hook card speaks of a schedule");
    const action = card.getByTestId("inbound-hook-admission-review");
    const reason = card.getByTestId("inbound-hook-admission-reason");
    await action.waitFor();
    await reason.waitFor();
    // Both boxes in one frame: the sheet slides in, and two separate reads
    // measure two different positions of the same card.
    const [actionBox, reasonBox] = await card.evaluate((element) =>
      [
        '[data-testid="inbound-hook-admission-review"]',
        '[data-testid="inbound-hook-admission-reason"]',
      ].map((selector) => {
        const box = element.querySelector(selector)?.getBoundingClientRect();
        return box ? { x: box.x, y: box.y, height: box.height } : null;
      }),
    );
    if (!actionBox || !reasonBox)
      throw new Error("The hook card's action or reason is not laid out");
    // Under the words it acts on, and aligned with them — not beside them.
    if (actionBox.y < reasonBox.y + reasonBox.height - 1)
      throw new Error(
        `The hook card's action sits beside its text (action top ${actionBox.y}, text bottom ${reasonBox.y + reasonBox.height})`,
      );
    if (Math.abs(actionBox.x - reasonBox.x) > 2)
      throw new Error(
        `The hook card's action is not aligned with its text (action left ${actionBox.x}, text left ${reasonBox.x})`,
      );
    await capture("hook-card");
    const address = page.url();
    await action.click();
    await page.getByTestId("authority-grant-cancel").waitFor();
    if (page.url() !== address) throw new Error("The hook card's action left the review sheet");
    const sampleField = page.getByTestId("authority-sample-input");
    await sampleField.waitFor();
    if (prepareBodies.length !== 1 || prepareBodies[0].input !== undefined)
      throw new Error("The first preparation must ask without an input, and only once");
    if (!(await page.getByTestId("authority-sample").innerText()).includes(slug))
      throw new Error("The sample request does not name the webhook");
    if (await page.getByTestId("authority-grant-review").count())
      throw new Error("A review was shown before the trial run had a sample call");
    const prefilled = JSON.parse(await sampleField.inputValue());
    if (JSON.stringify(prefilled) !== JSON.stringify(delivered))
      throw new Error("The sample field does not start from the newest received call");
    await capture("hook-sample");
    await page.getByTestId("authority-sample-prepare").click();
    await page.getByTestId("authority-grant-review").waitFor();
    // A hook is not offered one run for one day: thirty days, sized from its
    // calls, with one line that says where the numbers come from — once the
    // reader chooses limits instead of "until revoked".
    await page.getByTestId("authority-limit-limited").click();
    if (
      (await page.getByTestId("authority-runs").inputValue()) !== "100" ||
      (await page.getByTestId("authority-hours").inputValue()) !== "720"
    )
      throw new Error("A hook-started workflow lost its thirty-day suggestion");
    const suggestion = await page.getByTestId("authority-suggestion").innerText();
    if (!suggestion.includes("14") || !/Webhook|webhook/.test(suggestion))
      throw new Error(`The suggested limits are not explained: ${suggestion}`);
    await capture("hook-suggestion");
    if (
      prepareBodies.length !== 2 ||
      JSON.stringify(prepareBodies[1].input) !== JSON.stringify(delivered)
    )
      throw new Error("The trial run did not receive the sample call");
    await page.getByTestId("authority-grant-cancel").click();
    await page.getByTestId("authority-grant-cancel").waitFor({ state: "hidden" });
    await page.goBack();
    await sheet.waitFor({ state: "hidden" });

    // On the workflow's own page the held hook is the one state — "approval
    // needed", judged in production, where a hook's deliveries run — with the
    // hook named in the panel and no badge beside it.
    await stand.visit(page, `workflows/${workflowId}`);
    const panel = page.getByTestId("workflow-automation");
    await page.getByTestId("workflow-automation-action").waitFor();
    if ((await panel.getAttribute("data-state")) !== "grant")
      throw new Error(
        `A held webhook reads as "${await panel.getAttribute("data-state")}", not as approval needed`,
      );
    if (!(await page.getByTestId("workflow-automation-triggers").innerText()).includes(slug))
      throw new Error("The panel does not name the webhook it is about");
    if (
      !(await page.getByTestId("workflow-automation-headline").innerText()).includes(
        locale === "de" ? "Produktion" : "Production",
      )
    )
      throw new Error("A webhook's approval is not judged in production");
    if (await page.getByTestId("authority-hook-held").count())
      throw new Error("The held webhook is announced a second time by a badge");
    await capture("workflow-page");
  } finally {
    for (const [pattern, handler] of routes) await page.unroute(pattern, handler);
  }
}
