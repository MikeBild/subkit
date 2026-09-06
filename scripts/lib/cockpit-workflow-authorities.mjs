/** Browser interactions use fixtures; the route integration suite verifies database enforcement. */
export async function verifyWorkflowAuthorities(page, stand, workflowId, locale, capture) {
  const id = "00000000-0000-4000-8000-000000000101";
  const olderId = "00000000-0000-4000-8000-000000000102";
  const versionId = "00000000-0000-4000-8000-000000000103";
  const now = Date.now();
  const authority = {
    id,
    workflow_id: workflowId,
    workflow_version_id: versionId,
    effect_manifest_digest: "a".repeat(64),
    execution_environment: "prod",
    valid_from: new Date(now - 60_000).toISOString(),
    valid_until: new Date(now + 3_600_000).toISOString(),
    max_runs: 3,
    reserved_runs: 1,
    remaining_runs: 2,
    active_version: false,
    ready_for_new_run: false,
    state: "approved",
    created_at: new Date(now - 60_000).toISOString(),
    created_by: id,
    revoked_at: null,
    revoked_by: null,
    target_constraints: { targets: ["https://reports.example.test/monthly"] },
    effect_manifest: {
      schema_version: 1,
      tenant_id: id,
      workflow_id: workflowId,
      workflow_version_id: versionId,
      workflow_digest: "b".repeat(64),
      execution_environment: "prod",
      execution_options_digest: "c".repeat(64),
      effects: [
        {
          tenant_id: id,
          step_id: "publish-report",
          connector_id: id,
          driver: "http",
          environment: "prod",
          request_digest: "d".repeat(64),
          configuration_digest: "e".repeat(64),
          credential_binding_digest: "f".repeat(64),
          target: "https://reports.example.test/monthly",
          rewrites_target: false,
          operation: "POST",
          effect: "write",
        },
      ],
      issues: [],
    },
  };
  let revoked = false;
  let writes = 0;
  let failRead = false;
  const pattern = `**/v1/workflows/${workflowId}/execution-authorities**`;
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "POST") {
      if (!url.pathname.endsWith(`/${id}/revoke`))
        throw new Error("Authority UI wrote to an unreviewed target");
      writes += 1;
      revoked = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...authority,
          state: "revoked",
          revoked_at: new Date(now).toISOString(),
        }),
      });
    }
    if (failRead)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "unavailable" } }),
      });
    const older = url.searchParams.get("cursor") === id;
    const item = older
      ? { ...authority, id: olderId, state: "exhausted", remaining_runs: 0, reserved_runs: 3 }
      : revoked
        ? { ...authority, state: "revoked", revoked_at: new Date(now).toISOString() }
        : authority;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [item], next_cursor: older ? null : id }),
    });
  };
  await page.route(pattern, handler);
  try {
    await stand.visit(page, `workflows/${workflowId}`);
    const card = page.getByTestId(`authority-${id}`);
    await card.waitFor();
    await capture("history");
    const text = await card.innerText();
    for (const expected of [
      versionId,
      "https://reports.example.test/monthly",
      "POST",
      locale === "de" ? "Noch 2 von 3 Runs verfügbar" : "2 of 3 runs remaining",
      locale === "de"
        ? "Dies ist nicht die aktive Workflow-Version."
        : "This is not the active workflow version.",
    ]) {
      if (!text.includes(expected)) throw new Error(`Authority boundary missing: ${expected}`);
    }
    await page.getByTestId("authority-more").click();
    await page.getByTestId(`authority-${olderId}`).waitFor();
    await page.reload();
    await card.waitFor();
    if (writes !== 0) throw new Error("Reading or reloading authority history caused a mutation");
    const trigger = page.getByTestId(`authority-revoke-${id}`);
    await trigger.focus();
    await trigger.press("Enter");
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    await capture("revoke");
    if (!(await dialog.innerText()).includes(id))
      throw new Error("Revoke review omitted the exact authority");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    if (writes !== 0) throw new Error("Dismissing the review revoked an authority");
    await trigger.press("Enter");
    await page.getByTestId("authority-revoke-confirm").click();
    await dialog.waitFor({ state: "hidden" });
    await card.getByText(locale === "de" ? "Widerrufen" : "Revoked", { exact: true }).waitFor();
    await page.reload();
    await card.getByText(locale === "de" ? "Widerrufen" : "Revoked", { exact: true }).waitFor();
    if (writes !== 1 || (await page.getByTestId(`authority-revoke-${id}`).count()))
      throw new Error("Revoked authority did not persist after reload");
    failRead = true;
    await page.getByTestId("authority-refresh").click();
    await page.getByTestId("workflow-authorities").getByRole("alert").waitFor();
    if (await card.count()) throw new Error("Failed refresh still advertises a stale authority");
    failRead = false;
    await page.getByTestId("authority-refresh").click();
    await card.waitFor();
    const overflow = await page
      .getByTestId("workflow-authorities")
      .evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    if (overflow) throw new Error("Authority history overflows the viewport");
    await verifyGrant(page, stand, workflowId, locale, authority, capture);
  } finally {
    await page.unroute(pattern, handler);
  }
}

async function verifyGrant(page, stand, workflowId, locale, baseAuthority, capture) {
  const previewPattern = `**/v1/workflows/${workflowId}/versions/*/authority-preview?*`;
  const grantPattern = `**/v1/workflows/${workflowId}/execution-authorities`;
  let currentReview;
  let previews = 0;
  let posts = 0;
  let incomplete = false;
  const preview = async (route) => {
    previews += 1;
    const url = new URL(route.request().url());
    const version = url.pathname.split("/").at(-2);
    const from = new Date().toISOString();
    currentReview = {
      digest: String(previews).padStart(64, "0"),
      manifest: {
        ...baseAuthority.effect_manifest,
        workflow_version_id: version,
        execution_environment: url.searchParams.get("environment"),
      },
      eligible_for_repeated_runs: true,
      unavailable_steps: [],
      suggested_bounds: {
        valid_from: from,
        valid_until: new Date(Date.parse(from) + 86_400_000).toISOString(),
        max_runs: 1,
      },
      execution_shape: {
        requests: [
          {
            step_id: "publish-report",
            retry_policy_max_attempts: 5,
            redacted_request_json: '{"recipient":"reviewed@example.test"}',
            request_review_truncated: incomplete,
            opaque_payload_omitted: false,
          },
        ],
        iterations: [{ step_id: "each", kind: "for_each", body_step_ids: ["publish-report"] }],
        run_limit_is_request_limit: false,
      },
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(currentReview),
    });
  };
  const grant = async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    posts += 1;
    const body = route.request().postDataJSON();
    if (
      body.expected_manifest_digest !== currentReview.digest ||
      body.workflow_version_id !== currentReview.manifest.workflow_version_id ||
      body.execution_environment !== "prod" ||
      body.valid_from !== currentReview.suggested_bounds.valid_from ||
      body.valid_until !== currentReview.suggested_bounds.valid_until ||
      body.max_runs !== 2
    ) {
      throw new Error(
        `Grant boundary mismatch: ${JSON.stringify({ actual: body, expected: { digest: currentReview.digest, version: currentReview.manifest.workflow_version_id, bounds: currentReview.suggested_bounds, environment: "prod", max_runs: 2 } })}`,
      );
    }
    await route.fulfill({
      status: posts === 1 ? 409 : 201,
      contentType: "application/json",
      body: JSON.stringify(
        posts === 1
          ? { code: "authority_manifest_changed", message: "Changed" }
          : { ...baseAuthority, ...body },
      ),
    });
  };
  await page.route(previewPattern, preview);
  await page.route(grantPattern, grant);
  try {
    await stand.visit(page, `workflows/${workflowId}`);
    await page.getByTestId("authority-grant-open").click();
    await page.getByTestId("authority-grant-review").waitFor();
    if (
      (await page.getByTestId("authority-runs").inputValue()) !== "1" ||
      (await page.getByTestId("authority-hours").inputValue()) !== "24"
    )
      throw new Error("Grant lost finite server defaults");
    if (
      !(await page.getByTestId("authority-environment").innerText()).includes(
        locale === "de" ? "Entwicklung" : "Development",
      )
    )
      throw new Error("Grant defaults to production");
    await page.getByTestId("authority-environment").click();
    await page
      .getByRole("option", { name: locale === "de" ? "Produktion" : "Production", exact: true })
      .click();
    await page.getByTestId("authority-grant-review").waitFor();
    await page.getByTestId("authority-grant-review").locator("summary").click();
    await capture("grant");
    if (
      !(await page.getByTestId("authority-grant-review").innerText()).includes(
        "reviewed@example.test",
      )
    )
      throw new Error("Grant hides the reviewed recipient");
    await page.getByTestId("authority-runs").fill("2");
    await page.getByTestId("authority-grant-confirm").click();
    await page
      .getByRole("alert")
      .filter({
        hasText:
          locale === "de"
            ? "Die Freigabe konnte nicht bestätigt werden"
            : "The grant could not be confirmed",
      })
      .waitFor();
    if (posts !== 1 || !(await page.getByTestId("authority-grant-confirm").isDisabled()))
      throw new Error("Conflict reapproves or retries itself");
    await page.getByTestId("authority-prepare").click();
    await page.getByTestId("authority-grant-review").waitFor();
    await page.getByTestId("authority-runs").fill("2");
    await page.getByTestId("authority-grant-confirm").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    if (posts !== 2 || previews !== 3)
      throw new Error("Grant request counts do not match explicit review decisions");
    incomplete = true;
    await page.getByTestId("authority-grant-open").click();
    await page.getByTestId("authority-grant-review").waitFor();
    if (!(await page.getByTestId("authority-grant-confirm").isDisabled()))
      throw new Error("Truncated review can be granted");
    await page.getByTestId("authority-grant-cancel").click();
    if (posts !== 2) throw new Error("Incomplete or cancelled review caused a grant");
  } finally {
    await page.unroute(previewPattern, preview);
    await page.unroute(grantPattern, grant);
  }
}
