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
    const reviewTitle = page.getByTestId("attention-review-title");
    const expectedTitle = locale === "de" ? "1 Reparatur vorgeschlagen" : "1 repair proposed";
    if ((await reviewTitle.innerText()).trim() !== expectedTitle)
      throw new Error("The review sheet title does not identify the Monthly report proposal");
    const workflowLink = page.getByTestId("attention-review-workflow");
    await workflowLink.waitFor({ state: "visible" });
    if ((await workflowLink.innerText()).trim() !== "Monthly report")
      throw new Error("The review sheet workflow subtitle does not identify Monthly report");
    const workflowTarget = new URL(await workflowLink.getAttribute("href"), page.url());
    if (workflowTarget.pathname !== `/cockpit/workflows/${id}`)
      throw new Error("The review sheet workflow subtitle does not link to its workflow");
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

export async function verifyOverviewDecisionVerbs(page, stand, id, locale) {
  const now = new Date().toISOString();
  const digest = "c".repeat(64);
  const candidate = {
    id,
    workflow_id: id,
    workflow_name: "Quarterly report",
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
    diff: {
      workflow_step_id: "fetch",
      proposal: {
        kind: "update_field_path",
        classification: "safe",
        description: "Map the response identifier",
        reasoning: "The provider changed the result shape",
        patch: { path: "data.id", value: "data.result.id" },
      },
    },
  };
  const entry = {
    id: `workflow:${id}`,
    class: "failing",
    severity: "urgent",
    kind: "workflow",
    subject: { kind: "workflow", id, name: "Quarterly report" },
    reason: "patch_proposed",
    cause_class: null,
    counts: { patches: 1 },
    since: now,
    deadline: null,
    detail: null,
    actions: [{ verb: "review", href: `/cockpit?review=workflow:${id}`, primary: true }],
  };
  const patterns = ["**/v1/patch-candidates**", "**/v1/attention*"];
  const attemptedMutations = [];
  const trackMutation = (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/v1/") && request.method() !== "GET")
      attemptedMutations.push({ method: request.method(), path: url.pathname });
  };
  page.on("request", trackMutation);
  const handler = async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") {
      attemptedMutations.push({ method: request.method(), path });
      return route.fulfill({ status: 405, contentType: "application/json", body: "{}" });
    }
    if (path === "/v1/attention")
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          schema_version: "attention.v1",
          generated_at: now,
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
            ].map((key) => [key, "answered"]),
          ),
          status: { health_state: "healthy", next_run_at: null },
          items: [entry],
        }),
      });
    if (path === "/v1/patch-candidates")
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ items: [candidate], total: 1, reviewable_total: 1 }),
      });
    if (path === `/v1/patch-candidates/${id}/preview`)
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...candidate,
          candidate_id: id,
          reviewable: true,
          review_digest: digest,
          base_version_id: null,
        }),
      });
    return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
  };
  for (const pattern of patterns) await page.route(pattern, handler);
  const card = page.getByTestId("review-decision-0");
  try {
    await stand.visit(page, `?review=workflow:${id}`);
    await page.getByTestId("attention-review-body").waitFor();
    await card.waitFor({ state: "visible" });
    const approve = page.getByTestId("review-decision-0-approve");
    await approve.waitFor({ state: "visible" });
    const expectedApprove = locale === "de" ? "Freigeben" : "Approve";
    if ((await approve.innerText()).trim() !== expectedApprove)
      throw new Error("The primary review action does not use the selected approval verb");
    const reject = page.getByTestId("review-decision-0-reject");
    await reject.waitFor({ state: "visible" });
    const expectedReject = locale === "de" ? "Ablehnen" : "Reject";
    if ((await reject.innerText()).trim() !== expectedReject)
      throw new Error("The rejection action does not use the selected rejection verb");
    await reject.click();
    const note = page.getByTestId("review-decision-0-note");
    await note.waitFor({ state: "visible" });
    const expectedNoteLabel = locale === "de" ? "Notiz" : "Note";
    const expectedPlaceholder =
      locale === "de" ? "Warum wird das abgelehnt?" : "Why is this rejected?";
    const expectedScope =
      locale === "de"
        ? "Die Notiz wird mit der Ablehnung festgehalten."
        : "The note is recorded with the rejection.";
    if ((await note.getAttribute("aria-label")) !== expectedNoteLabel)
      throw new Error("The rejection note field does not have the localized label");
    if ((await note.getAttribute("placeholder")) !== expectedPlaceholder)
      throw new Error("The rejection note field does not have the localized prompt");
    await page.getByText(expectedScope, { exact: true }).waitFor({ state: "visible" });
    await note.fill("Keep the proposed change for later review");
    await page.getByTestId("review-decision-0-reject-cancel").click();
    if ((await note.count()) !== 0)
      throw new Error("Cancel did not close the rejection note field");
    if ((await card.count()) !== 1) throw new Error("Cancel removed the unresolved decision row");
    await page.getByTestId("review-decision-0-reject").click();
    const reopenedNote = page.getByTestId("review-decision-0-note");
    await reopenedNote.waitFor({ state: "visible" });
    if ((await reopenedNote.inputValue()) !== "")
      throw new Error("Cancel did not reset the rejection note before reopening");
    await page.getByTestId("review-decision-0-reject-cancel").click();
    if ((await reopenedNote.count()) !== 0)
      throw new Error("The reopened rejection note did not close on cancel");
    if (attemptedMutations.length !== 0)
      throw new Error(
        `Review fixture received unexpected mutation requests: ${JSON.stringify(attemptedMutations)}`,
      );
  } finally {
    page.off("request", trackMutation);
    for (const pattern of patterns) await page.unroute(pattern, handler);
  }
}

export async function verifyOverviewOperationsSummary(page, stand) {
  await stand.visit(page, "");
  const runsFigure = page.getByTestId("operations-figure-runs").filter({ visible: true });
  await runsFigure.waitFor({ state: "visible" });
  const runsTitle = runsFigure.locator(":scope > p").first();
  const runsTitleText = (await runsTitle.innerText()).trim();
  if (runsTitleText !== "Ausführungen · 24 Std")
    throw new Error(
      `Overview runs title showed "${runsTitleText}" instead of Ausführungen · 24 Std`,
    );
  const runsFigureText = await runsFigure.innerText();
  if (runsFigureText.includes("Läufe") || runsFigureText.includes("in 24 h"))
    throw new Error("Overview runs tile contains Dummy-only title or subtitle copy");
  const failedSubtitle = page.getByTestId("operations-figure-runs-detail");
  await failedSubtitle.waitFor({ state: "visible" });
  if ((await failedSubtitle.innerText()).trim() !== "4 fehlgeschlagen")
    throw new Error("Overview runs subtitle did not show the exact localized failed count");
  const connectorSubtitle = page.getByTestId("operations-figure-connectorHealth-detail");
  await connectorSubtitle.waitFor({ state: "visible" });
  if ((await connectorSubtitle.innerText()).trim() !== "5 brauchen Anmeldung")
    throw new Error("Overview connector subtitle did not show the exact localized sign-in count");
  const budgetFigure = page.getByTestId("operations-figure-budget").filter({ visible: true });
  await budgetFigure.waitFor({ state: "visible" });
  const budgetLabel = (await budgetFigure.locator(":scope > p").nth(0).innerText()).trim();
  if (budgetLabel !== "Nutzung · Monat")
    throw new Error(
      `Overview budget tile label showed "${budgetLabel}" instead of Nutzung · Monat`,
    );
  const budgetPrimary = budgetFigure.locator(":scope > p").nth(1);
  const budgetAmount = (await budgetPrimary.locator("span").nth(0).innerText())
    .replace(/\s+/gu, " ")
    .trim();
  if (budgetAmount !== "mind. 412,87 €")
    throw new Error(`Overview budget amount showed "${budgetAmount}" instead of mind. 412,87 €`);
  const budgetShare = (await page.getByTestId("operations-figure-budget-detail").innerText())
    .replace(/\s+/gu, " ")
    .trim();
  if (!budgetShare.includes("95 % des Tokenkontingents"))
    throw new Error(
      `Overview budget detail showed "${budgetShare}" instead of including 95 % des Tokenkontingents`,
    );
  if ((await budgetFigure.getAttribute("data-budget-pressure")) !== "critical")
    throw new Error("Overview budget tile did not retain the critical budget pressure state");
  const budgetText = await budgetFigure.innerText();
  if (budgetText.includes("übrig") || budgetText.includes("7.500.000"))
    throw new Error(
      "Overview budget tile did not follow the approved shortened amount-and-percent display",
    );
  const failureRow = page.getByTestId("overview-failures-row-0").filter({ visible: true });
  await failureRow.waitFor({ state: "visible" });
  const causeText = (await failureRow.locator("td").nth(1).innerText()).trim();
  if (causeText !== "write_products · Anmeldung abgelehnt")
    throw new Error(
      `Overview failure cause showed "${causeText}" instead of the exact step and cause`,
    );
  const failuresText = await page.getByTestId("overview-failures").last().innerText();
  if (failuresText.includes("PRIVATE_FAILURE_SENTINEL_DO_NOT_RENDER"))
    throw new Error("Overview failure row exposed a technical error message");
}

export async function verifyOverviewDecisionHistory(page, stand, mockApi) {
  const expectedActions = [
    "patch_candidate.approved",
    "patch_candidate.rejected",
    "skill_candidate.approved",
    "skill_candidate.rejected",
    "approval.granted",
    "approval.approved",
    "approval.rejected",
    "approval.declined",
    "workflow.authority_granted",
    "workflow.authority_revoked",
    "policy.denied",
    "approval.dispatch_denied",
    "execution.boundary_refused",
    "rbac.role_created",
    "rbac.role_deleted",
    "rbac.permission_granted",
    "rbac.permission_revoked",
    "rbac.user_role_assigned",
    "rbac.user_role_revoked",
    "user.created",
    "user.deleted",
    "user.role_changed",
    "api_key.issued",
    "api_key.revoked",
    "workflow.deleted",
    "workflow.version_restored",
    "knowledge_source.restored",
    "schedule.created",
    "schedule.deleted",
    "connector.deleted",
    "secret.version_created",
    "secret.version_revoked",
    "settings.changed",
  ];
  const auditRequests = [];
  const trackAudit = (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/v1/audit-log") auditRequests.push(url);
  };
  page.on("request", trackAudit);
  try {
    await stand.visit(page, "");
    const historyLink = page.getByTestId("attention-history");
    await historyLink.waitFor();
    if ((await historyLink.innerText()).trim() !== "Was bereits entschieden wurde")
      throw new Error("Overview history link label does not match the selected German copy");
    const target = new URL(await historyLink.getAttribute("href"), page.url());
    if (target.pathname !== "/cockpit/audit" || target.searchParams.get("scope") !== "decisions")
      throw new Error("Overview history link did not target the decisions audit");
    await historyLink.click();
    await page.getByTestId("resource-audit").waitFor();
    const current = new URL(page.url());
    if (current.pathname !== "/cockpit/audit" || current.searchParams.get("scope") !== "decisions")
      throw new Error("Overview decision history did not navigate to the decisions audit");
    const scopedRequest = auditRequests.find((url) => url.searchParams.has("action"));
    const actions = scopedRequest?.searchParams.get("action")?.split(",") ?? [];
    if (JSON.stringify(actions) !== JSON.stringify(expectedActions))
      throw new Error("Decision history did not load the curated decisions audit filter");

    const overrideBootstrap = "**/v1/cockpit/bootstrap";
    const withoutAuditPermission = async (route) => {
      await mockApi({
        request: () => route.request(),
        fulfill: async (response) => {
          const body = JSON.parse(response.body);
          body.permissions = body.permissions.filter((permission) => permission !== "audit:read");
          await route.fulfill({ ...response, body: JSON.stringify(body) });
        },
      });
    };
    await page.route(overrideBootstrap, withoutAuditPermission);
    try {
      const auditRequestCount = auditRequests.length;
      await stand.visit(page, "");
      if ((await page.getByTestId("attention-history").count()) !== 0)
        throw new Error("Decision history link appeared without audit:read");
      if (auditRequests.length !== auditRequestCount)
        throw new Error("Overview loaded the audit API without audit:read");
    } finally {
      await page.unroute(overrideBootstrap, withoutAuditPermission);
    }
  } finally {
    page.off("request", trackAudit);
  }
}
