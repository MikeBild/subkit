export async function verifyDecisionLifecycle(page, stand, id, locale, capture) {
  let applied = false;
  let attempts = 0;
  const digest = "a".repeat(64);
  const now = new Date().toISOString();
  const candidate = {
    id,
    workflow_id: id,
    workflow_name: "Monthly report",
    tenant_id: id,
    classification: "safe",
    status: "proposed",
    fixture_id: null,
    created_at: now,
    updated_at: now,
    connector_id: null,
    endpoint_key: null,
    reviewable: true,
    review_reason: null,
    review_digest: digest,
    base_version_id: id,
    diff: {
      workflow_step_id: "fetch",
      proposal: {
        kind: "update_field_path",
        classification: "safe",
        description: "Read the renamed identifier",
        reasoning: "The response moved its identifier",
        patch: { path: "data.id", value: "data.result.id" },
      },
    },
  };
  const patterns = [
    "**/v1/patch-candidates**",
    "**/v1/skill-candidates**",
    "**/v1/attention*",
    `**/v1/workflows/${id}/versions/*/authority-preview?*`,
  ];
  const entry = {
    id: `workflow:${id}`,
    class: "failing",
    severity: "urgent",
    kind: "workflow",
    subject: { kind: "workflow", id, name: "Monthly report" },
    reason: "patch_proposed",
    cause_class: null,
    counts: { patches: 1 },
    since: now,
    deadline: null,
    detail: null,
    actions: [
      {
        verb: "review",
        href: `/cockpit?review=workflow:${id}`,
        primary: true,
        permission: "workflow:write",
      },
    ],
  };
  const attention = () => ({
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
    status: { health_state: "healthy", next_run_at: null },
    items: applied ? [] : [entry],
  });
  const reply = (route, body, status = 200) =>
    route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  const handler = async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/v1/attention") return reply(route, attention());
    if (path === "/v1/skill-candidates")
      return reply(route, { items: [], total: 0, reviewable_total: 0 });
    if (path === "/v1/patch-candidates")
      return reply(route, {
        items: applied ? [] : [candidate],
        total: applied ? 0 : 1,
        reviewable_total: applied ? 0 : 1,
      });
    if (path.endsWith("/preview"))
      return reply(route, {
        ...candidate,
        candidate_id: id,
        fixture_available: false,
        before_step: { id: "fetch", kind: "request", data_selector: "data.id" },
        after_step: { id: "fetch", kind: "request", data_selector: "data.result.id" },
        changed_paths: ["data_selector"],
        proposal: candidate.diff.proposal,
        drift_summary: "Field moved",
      });
    if (path.endsWith("/prepare")) {
      if (applied) throw new Error("Preparation unexpectedly applied the repair");
      return reply(route, { workflow_version_id: id, review_digest: digest });
    }
    if (path.endsWith("/authority-preview"))
      return reply(route, {
        digest: "b".repeat(64),
        eligible_for_repeated_runs: true,
        unavailable_steps: [],
        manifest: {
          workflow_id: id,
          workflow_version_id: id,
          execution_environment: "dev",
          effects: [
            {
              step_id: "fetch",
              effect: "read",
              operation: "GET",
              target: "https://reports.example.test/monthly",
              connector_id: id,
            },
          ],
          issues: [],
        },
        execution_shape: {
          requests: [
            {
              step_id: "fetch",
              retry_policy_max_attempts: 1,
              redacted_request_json: '{"method":"GET","path":"/monthly"}',
              request_review_truncated: false,
              opaque_payload_omitted: false,
            },
          ],
          iterations: [],
          run_limit_is_request_limit: true,
        },
        suggested_bounds: {
          valid_from: now,
          valid_until: new Date(Date.parse(now) + 86_400_000).toISOString(),
          max_runs: 1,
        },
        suggested_bounds_basis: { kind: "manual" },
      });
    if (path.endsWith("/approve")) {
      if (request.postDataJSON().expected_review_digest !== digest)
        throw new Error("Approval omitted the reviewed digest");
      attempts++;
      if (attempts === 1)
        return reply(route, { code: "review_changed", message: "Review changed" }, 409);
      if (attempts === 3) {
        const authority = request.postDataJSON().execution_authority;
        if (
          !authority ||
          authority.workflow_version_id !== id ||
          authority.expected_manifest_digest !== "b".repeat(64) ||
          authority.max_runs !== null ||
          authority.valid_until !== null ||
          authority.execution_environment !== "dev"
        )
          throw new Error("Combined review lost its exact boundary or its until-revoked default");
      }
      applied = true;
      return reply(route, { applied: true, workflow_version_id: id });
    }
    return route.fallback();
  };
  for (const pattern of patterns) await page.route(pattern, handler);
  const listed = () =>
    page.locator(`[data-testid="attention-list"] [data-attention-id="workflow:${id}"]`).first();
  const openSheet = async () => {
    await stand.visit(page, `?review=workflow:${id}`);
    await page.getByTestId("attention-review-body").waitFor();
  };
  const header = page.getByTestId("attention-review-actions");
  const approveOnly = async () => {
    await header.locator('[data-testid$="-more"]').click();
    await page.getByRole("menuitem").filter({ visible: true }).first().waitFor();
    await page.locator('[role="menuitem"][data-testid$="-approve"]').click();
  };
  try {
    await openSheet();
    const card = page.locator(`article[data-decision-key="patch:${id}"]`);
    await card.waitFor();
    if ((await card.locator('[data-testid$="-approve"], [data-testid$="-more"]').count()) !== 0)
      throw new Error(
        "The only decision in the sheet keeps its actions in the card, not the header",
      );
    const facts = card.locator('[data-testid$="-facts"]');
    await facts.waitFor();
    const factText = await facts.innerText();
    for (const word of locale === "de" ? ["Vorher", "Nachher"] : ["Before", "After"])
      if (!factText.includes(word)) throw new Error(`The repair sheet does not state "${word}"`);
    if (!factText.includes("data.result.id"))
      throw new Error("The repair sheet does not show the changed value before it is opened");
    await header.getByTestId("authority-grant-open").waitFor();
    const headerButtons = await header.locator("button").filter({ visible: true }).count();
    if (headerButtons !== 2)
      throw new Error(`The sheet header offers ${headerButtons} buttons, not one act and a menu`);
    if (await header.locator('[data-testid$="-reject"]').filter({ visible: true }).count())
      throw new Error("Rejecting stands next to the act instead of in the menu");
    await approveOnly();
    await page
      .getByText(
        locale === "de"
          ? "Die geprüfte Änderung ist nicht mehr aktuell. Lade die Vorschau erneut."
          : "The reviewed change is no longer current. Reload the preview.",
        { exact: true },
      )
      .waitFor();
    await capture("failed-review");
    if ((await card.count()) !== 1) throw new Error("Failed approval removed the card");
    await listed().waitFor({ state: "attached" });
    await openSheet();
    await card.waitFor();
    await card.locator('[data-testid$="-facts"]').waitFor();
    await approveOnly();
    await page.getByTestId("attention-review").waitFor({ state: "hidden" });
    const audit = page.getByTestId("attention-decided-audit");
    await audit.waitFor();
    if (!(await audit.getAttribute("href"))?.includes("/cockpit/audit?"))
      throw new Error("The decision's toast does not lead to the audit trail");
    if (await listed().count()) throw new Error("The decided entry is still on Übersicht");
    await page.reload();
    await page.getByTestId("attention-page").waitFor();
    await page.getByTestId("attention").waitFor();
    if ((await listed().count()) !== 0 || attempts !== 2)
      throw new Error("Settled decision returned after reload");
    await capture("settled-reload");
    applied = false;
    await openSheet();
    await card.waitFor();
    await header.getByTestId("authority-grant-open").click();
    await page.getByTestId("authority-grant-review").waitFor();
    const dialog = page
      .getByRole("dialog")
      .filter({ has: page.getByTestId("authority-grant-review") });
    const reviewText = await dialog.innerText();
    if (
      !reviewText.includes("data.id") ||
      !reviewText.includes("data.result.id") ||
      !reviewText.includes("https://reports.example.test/monthly")
    )
      throw new Error("Combined dialog omitted the repair or target");
    for (const raw of ['"before"', '"after"', '"data_selector"'])
      if (reviewText.includes(raw))
        throw new Error(`Combined dialog shows the change as raw JSON (${raw})`);
    if (attempts !== 2 || applied) throw new Error("Preparing the boundary applied the repair");
    await dialog.evaluate(async (node) => {
      await Promise.all(
        node
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await capture("combined-review");
    await page.getByTestId("authority-grant-confirm").click();
    await card.waitFor({ state: "detached" });
    await stand.visit(page, "");
    await page.getByTestId("attention").waitFor();
    if ((await listed().count()) !== 0 || attempts !== 3)
      throw new Error("Combined approval did not settle after reload");
  } finally {
    for (const pattern of patterns) await page.unroute(pattern, handler);
  }
}
