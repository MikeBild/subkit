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
    await page.reload();
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
    await verifyPreparedVersion(page, stand, workflowId, locale, capture);
    await verifyActivationWhenNotApprovable(page, stand, workflowId, capture);
    await verifyEnvironmentCorrection(page, stand, workflowId, capture);
  } finally {
    await page.unroute(pattern, handler);
  }
}

/**
 * A repaired version waiting next to the running one must be what the approval
 * judges.
 *
 * Three production workflows sat blocked at once with exactly this shape: the
 * running version could not be bound — which is why the schedule was held — and
 * the version that fixed it was saved one number higher. The page compiled the
 * approval from `current_version_id`, so the reader was shown the problems of
 * the version they were not supposed to approve, with no way to reach the one
 * that worked. The fixture therefore serves a workflow WITH a prepared draft;
 * without that this whole panel renders in no screenshot at all.
 */
async function verifyPreparedVersion(page, stand, workflowId, locale, capture) {
  const activeVersionId = "00000000-0000-4000-8000-000000000201";
  const draftVersionId = "00000000-0000-4000-8000-000000000202";
  const workflowPattern = `**/v1/workflows/${workflowId}`;
  const draftPattern = `**/v1/workflows/${workflowId}/draft`;
  const previewPattern = `**/v1/workflows/${workflowId}/versions/*/authority-preview?*`;
  const grantPattern = `**/v1/workflows/${workflowId}/execution-authorities`;
  const activatePattern = `**/v1/workflows/${workflowId}/activate-draft`;
  let reviewedVersion = null;
  let granted = null;
  let activated = null;
  const record = async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: workflowId,
        name: "Monatsreport",
        slug: "monatsreport",
        lifecycle: "active",
        current_version: 8,
        current_version_id: activeVersionId,
        draft_version_id: draftVersionId,
        steps: [{ id: "publish-report", name: "Report senden", kind: "request" }],
        updated_at: "2026-08-10T09:00:00.000Z",
      }),
    });
  };
  const draft = async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflow_id: workflowId,
        version_id: draftVersionId,
        version: 9,
        current_version_id: activeVersionId,
        digest: "9".repeat(64),
        definition: { name: "Monatsreport", steps: [] },
      }),
    });
  const preview = async (route) => {
    const url = new URL(route.request().url());
    reviewedVersion = url.pathname.split("/").at(-2);
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        digest: "d".repeat(64),
        manifest: {
          schema_version: 1,
          workflow_id: workflowId,
          workflow_version_id: reviewedVersion,
          // Echoed, not asserted: a review that answers for a different
          // environment than the one asked for is refused by the dialog, and
          // this scenario is about which VERSION is judged.
          execution_environment: url.searchParams.get("environment"),
          effects: [],
          issues: [],
        },
        eligible_for_repeated_runs: true,
        unavailable_steps: [],
        suggested_bounds: {
          valid_from: new Date().toISOString(),
          valid_until: new Date(Date.now() + 86_400_000).toISOString(),
          max_runs: 1,
        },
        execution_shape: { requests: [], iterations: [], run_limit_is_request_limit: false },
      }),
    });
  };
  const grant = async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    granted = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ id: draftVersionId, ...granted }),
    });
  };
  const activate = async (route) => {
    activated = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflow_version_id: draftVersionId,
        activated: true,
        execution_authorized: false,
      }),
    });
  };
  await page.route(workflowPattern, record);
  await page.route(draftPattern, draft);
  await page.route(previewPattern, preview);
  await page.route(grantPattern, grant);
  await page.route(activatePattern, activate);
  try {
    await stand.visit(page, `workflows/${workflowId}`);
    const waiting = page.getByTestId("authority-prepared-version");
    await waiting.waitFor();
    const text = await waiting.innerText();
    // Both numbers, because either one alone leaves the reader guessing which
    // version they are about to put into service.
    for (const expected of ["v9", "v8"])
      if (!text.includes(expected))
        throw new Error(`Prepared-version notice omits ${expected}: ${text}`);
    await capture("prepared");
    await page.getByTestId("authority-grant-open").click();
    await page.getByTestId("authority-grant-review").waitFor();
    if (reviewedVersion !== draftVersionId)
      throw new Error(
        `Approval judged ${reviewedVersion} while a prepared version was waiting — the running version is the one that could not be approved`,
      );
    const badge = await page.getByTestId("authority-grant-review").innerText();
    if (!badge.includes(locale === "de" ? "vorbereitet" : "prepared"))
      throw new Error("Review does not say which version it is judging");
    // The smaller decision has to be available on its own: a called child
    // needs its repaired version in service and no permission to run by
    // itself. Taking it must not grant anything.
    await page.getByTestId("authority-activate-only").click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    if (activated?.workflow_version_id !== draftVersionId)
      throw new Error("Putting a version into service used a version nobody reviewed");
    if (activated?.expected_current_version_id !== activeVersionId)
      throw new Error("Activation did not state which version it replaces");
    if (granted) throw new Error("Putting a version into service also granted permission to run");

    await page.getByTestId("authority-grant-open").click();
    await page.getByTestId("authority-grant-review").waitFor();
    const confirm = page.getByTestId("authority-grant-confirm");
    // Wait for the dialog to STOP working, not for a stopwatch. Ten seconds was
    // enough on a laptop and not on a CI runner, and a fixture that fails by
    // being slower than its own guess measures the machine, not the product.
    // The two states are distinguished below: still preparing, or a review this
    // dialog will not grant from.
    await page
      .waitForFunction(
        () => {
          const node = document.querySelector('[data-testid="authority-grant-confirm"]');
          return Boolean(node) && !node.disabled;
        },
        { timeout: 60_000 },
      )
      .catch(() => {});
    if (await confirm.isDisabled()) {
      // Which of the two reasons: still working, or a review the dialog will
      // not grant from. The re-check button appears only for the second.
      const recheck = (await page.getByTestId("authority-prepare").count()) > 0;
      throw new Error(
        `Approval stayed unavailable after putting the version into service. Re-check offered: ${recheck}. Dialog: ${(await page.getByRole("dialog").innerText()).slice(0, 600)}`,
      );
    }
    await confirm.click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    // The larger decision stays one step: the reader is putting this version
    // into service AND permitting runs, and the request has to say both.
    if (granted?.activation?.expected_current_version_id !== activeVersionId)
      throw new Error("Approving a prepared version did not carry its activation");
    if (granted?.workflow_version_id !== draftVersionId)
      throw new Error("Approval was issued against a version nobody reviewed");
  } finally {
    await page.unroute(activatePattern, activate);
    await page.unroute(grantPattern, grant);
    await page.unroute(previewPattern, preview);
    await page.unroute(draftPattern, draft);
    await page.unroute(workflowPattern, record);
  }
}

/**
 * A prepared version that cannot be approved can still be put into service.
 *
 * The two decisions are separate, and this is the case that proves it: one step
 * refuses, so the review is not approvable, and the reader must still be able
 * to take the smaller decision. It used to be offered only on the approvable
 * side, so a child whose other steps had just been bound stayed on its old
 * version because of the one step nobody could bind — and the button that would
 * have moved it was not rendered at all. The engine never asked for that:
 * `activate-draft` checks the reviewed digest and authorizes no run.
 */
async function verifyActivationWhenNotApprovable(page, stand, workflowId, capture) {
  const activeVersionId = "00000000-0000-4000-8000-000000000401";
  const draftVersionId = "00000000-0000-4000-8000-000000000402";
  const workflowPattern = `**/v1/workflows/${workflowId}`;
  const draftPattern = `**/v1/workflows/${workflowId}/draft`;
  const previewPattern = `**/v1/workflows/${workflowId}/versions/*/authority-preview?*`;
  const grantPattern = `**/v1/workflows/${workflowId}/execution-authorities`;
  const activatePattern = `**/v1/workflows/${workflowId}/activate-draft`;
  const proposalPattern = `**/v1/workflows/${workflowId}/boundary-proposals`;
  let granted = null;
  let activated = null;
  const record = async (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: workflowId,
            name: "Monatsreport",
            slug: "monatsreport",
            lifecycle: "active",
            current_version: 8,
            current_version_id: activeVersionId,
            draft_version_id: draftVersionId,
            steps: [{ id: "fetch-route", name: "Seite lesen", kind: "request" }],
            updated_at: "2026-08-10T09:00:00.000Z",
          }),
        })
      : route.fallback();
  const draft = async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflow_id: workflowId,
        version_id: draftVersionId,
        version: 9,
        current_version_id: activeVersionId,
        digest: "4".repeat(64),
        definition: { name: "Monatsreport", steps: [] },
      }),
    });
  const preview = async (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        digest: "e".repeat(64),
        manifest: {
          schema_version: 1,
          workflow_id: workflowId,
          workflow_version_id: url.pathname.split("/").at(-2),
          execution_environment: url.searchParams.get("environment"),
          effects: [],
          // The one step nobody can bind. This is what makes the review
          // unapprovable, and what used to take the activation with it.
          issues: [{ step_id: "fetch-route", code: "dynamic_request" }],
        },
        eligible_for_repeated_runs: false,
        unavailable_steps: [],
        // The engine's own reason, which contradicts the blanket code above:
        // `dynamic_request` renders as "where this request goes is decided at
        // runtime", and this step's refusal is that a stricter profile already
        // reviews it. Without this the new sentence would ship in no
        // screenshot at all.
        request_refusals: [{ step_id: "fetch-route", reason: "stricter_profile_applies" }],
        suggested_bounds: {
          valid_from: new Date().toISOString(),
          valid_until: new Date(Date.now() + 86_400_000).toISOString(),
          max_runs: 1,
        },
        execution_shape: { requests: [], iterations: [], run_limit_is_request_limit: false },
      }),
    });
  };
  const grant = async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    granted = route.request().postDataJSON();
    return route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
  };
  const activate = async (route) => {
    activated = route.request().postDataJSON();
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflow_version_id: draftVersionId,
        activated: true,
        execution_authorized: false,
      }),
    });
  };
  // The refusal makes the dialog ask what it can work out by itself. Answering
  // "nothing" keeps this scenario about the activation.
  const proposals = async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ proposals: [], unproposable: [] }),
    });
  await page.route(workflowPattern, record);
  await page.route(draftPattern, draft);
  await page.route(previewPattern, preview);
  await page.route(grantPattern, grant);
  await page.route(activatePattern, activate);
  await page.route(proposalPattern, proposals);
  try {
    await stand.visit(page, `workflows/${workflowId}`);
    await page.getByTestId("authority-grant-open").click();
    // The named reason, not the generic notice: this review carries an issue,
    // so the dialog lists it rather than saying "adjust the workflow".
    await page.getByTestId("authority-issues").waitFor();
    // The precise reason, not the blanket one. Both sentences describe the same
    // step and they are not two halves of one explanation — one of them says
    // the target is unbounded for a step whose address is a constant.
    const issues = await page.getByTestId("authority-issues").innerText();
    if (!/strengere|stricter/.test(issues))
      throw new Error(
        `The refusal shows the blanket code instead of the engine's reason: ${issues}`,
      );
    if (/Laufzeit entscheidet|decided at runtime|zur Laufzeit und ist durch nichts/.test(issues))
      throw new Error(`The refusal still claims the target is unbounded: ${issues}`);
    const activateOnly = page.getByTestId("authority-activate-only");
    if ((await activateOnly.count()) === 0)
      throw new Error(
        "A prepared version that cannot be approved offers no way to put it into service, so the smaller decision cannot be taken at all",
      );
    await capture("activate-only-unapprovable");
    await activateOnly.click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    if (activated?.workflow_version_id !== draftVersionId)
      throw new Error("Putting a version into service used a version nobody reviewed");
    if (activated?.expected_current_version_id !== activeVersionId)
      throw new Error("Activation did not state which version it replaces");
    if (granted) throw new Error("Putting an unapprovable version into service granted a run");
  } finally {
    await page.unroute(proposalPattern, proposals);
    await page.unroute(activatePattern, activate);
    await page.unroute(grantPattern, grant);
    await page.unroute(previewPattern, preview);
    await page.unroute(draftPattern, draft);
    await page.unroute(workflowPattern, record);
  }
}

/**
 * A review asked about the wrong half of the installation corrects itself once.
 *
 * The dialog picks an environment before it can see anything: a live approval's,
 * a held schedule's, else development. A called child has neither, so it fell
 * to development, every connector-bound step answered `environment_mismatch`,
 * and the reader was told to investigate the cause in the chat. The answer was
 * in that same response — each effect names the environment its connector
 * really belongs to — and moving the dropdown made the version fully bindable.
 *
 * The fixture answers `dev` with three mismatches and `prod` with none, and
 * fails if the dialog settles on the wrong one, asks more than twice, or ends
 * up somewhere the reader cannot approve from.
 */
async function verifyEnvironmentCorrection(page, stand, workflowId, capture) {
  const versionId = "00000000-0000-4000-8000-000000000501";
  const workflowPattern = `**/v1/workflows/${workflowId}`;
  const previewPattern = `**/v1/workflows/${workflowId}/versions/*/authority-preview?*`;
  const grantPattern = `**/v1/workflows/${workflowId}/execution-authorities`;
  const historyPattern = `**/v1/workflows/${workflowId}/execution-authorities**`;
  const asked = [];
  let granted = null;
  // No approval and no held schedule — the shape of a called child, and the
  // only shape in which the dialog has to fall back. The enclosing scenario
  // serves a live production approval on this same endpoint, which answers the
  // environment question outright: without this the fixture would measure the
  // stand's own fixture instead of the correction. The first version of this
  // scenario did exactly that and passed while asking `prod` once.
  const noHistory = async (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [], next_cursor: null }),
        })
      : route.fallback();
  const record = async (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: workflowId,
            name: "Monatsreport",
            slug: "monatsreport",
            lifecycle: "active",
            current_version: 8,
            current_version_id: versionId,
            draft_version_id: null,
            steps: [{ id: "archive_raw", name: "Ablegen", kind: "request" }],
            updated_at: "2026-08-10T09:00:00.000Z",
          }),
        })
      : route.fallback();
  const preview = async (route) => {
    const url = new URL(route.request().url());
    const environment = url.searchParams.get("environment");
    asked.push(environment);
    // The steps live in production, whichever half was asked about.
    const effects = ["archive_raw", "fetch_page", "write_collection_manifest"].map((step_id) => ({
      step_id,
      environment: "prod",
      driver: "http",
      operation: "POST",
      effect: "write",
      target: "https://reports.example.test/monthly",
      rewrites_target: false,
    }));
    const mismatched = environment !== "prod";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        digest: (mismatched ? "a" : "b").repeat(64),
        manifest: {
          schema_version: 1,
          workflow_id: workflowId,
          workflow_version_id: versionId,
          execution_environment: environment,
          effects,
          issues: mismatched
            ? effects.map((effect) => ({
                step_id: effect.step_id,
                code: "environment_mismatch",
              }))
            : [],
        },
        eligible_for_repeated_runs: !mismatched,
        unavailable_steps: [],
        suggested_bounds: {
          valid_from: new Date().toISOString(),
          valid_until: new Date(Date.now() + 86_400_000).toISOString(),
          max_runs: 1,
        },
        execution_shape: { requests: [], iterations: [], run_limit_is_request_limit: false },
      }),
    });
  };
  const grant = async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    granted = route.request().postDataJSON();
    return route.fulfill({ status: 201, contentType: "application/json", body: "{}" });
  };
  await page.route(historyPattern, noHistory);
  await page.route(workflowPattern, record);
  await page.route(previewPattern, preview);
  await page.route(grantPattern, grant);
  try {
    await stand.visit(page, `workflows/${workflowId}`);
    await page.getByTestId("authority-grant-open").click();
    await page.getByTestId("authority-grant-review").waitFor();
    const chosen = (await page.getByTestId("authority-environment").innerText()).trim();
    if (!/Produktion|Production/.test(chosen))
      throw new Error(
        `The review stayed on ${chosen} while every step named production — the reader is being asked to judge the wrong half`,
      );
    // Asked twice: once as it was told to, once as the answer said. A third
    // ask would mean it is chasing its own correction.
    if (asked.length !== 2 || asked[0] !== "dev" || asked[1] !== "prod")
      throw new Error(`Environments asked about: ${asked.join(", ") || "(none)"}`);
    if ((await page.getByTestId("authority-issues").count()) > 0)
      throw new Error("The corrected review still shows the mismatch it just corrected");
    await capture("environment-corrected");
    const confirm = page.getByTestId("authority-grant-confirm");
    // Wait for the dialog to stop working, and say WHY if it does not: a
    // timeout alone cannot tell a slow runner from a review this dialog will
    // not grant from, and that difference is the whole finding.
    await page
      .waitForFunction(
        () => {
          const node = document.querySelector('[data-testid="authority-grant-confirm"]');
          return Boolean(node) && !node.disabled;
        },
        { timeout: 60_000 },
      )
      .catch(() => {});
    if (await confirm.isDisabled())
      throw new Error(
        `Approval stayed unavailable after the correction. Asked: ${asked.join(", ")}. Environment shown: ${(await page.getByTestId("authority-environment").innerText()).trim()}. Dialog: ${(await page.getByRole("dialog").innerText()).slice(0, 500)}`,
      );
    await confirm.click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    if (granted?.execution_environment !== "prod")
      throw new Error(
        `Approved for ${granted?.execution_environment} after correcting to production`,
      );
  } finally {
    await page.unroute(grantPattern, grant);
    await page.unroute(previewPattern, preview);
    await page.unroute(workflowPattern, record);
    await page.unroute(historyPattern, noHistory);
  }
}

async function verifyGrant(page, stand, workflowId, locale, baseAuthority, capture) {
  const previewPattern = `**/v1/workflows/${workflowId}/versions/*/authority-preview?*`;
  const grantPattern = `**/v1/workflows/${workflowId}/execution-authorities`;
  let currentReview;
  let previews = 0;
  let posts = 0;
  let incomplete = false;
  let unsupported = false;
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
      eligible_for_repeated_runs: !unsupported,
      unavailable_steps: unsupported ? ["publish-report"] : [],
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
      (await page.getByTestId("authority-runs").getAttribute("aria-invalid")) === "true" ||
      (await page.getByTestId("authority-hours").getAttribute("aria-invalid")) === "true"
    )
      throw new Error("Valid bounds presented as invalid");
    if (await page.getByTestId("authority-prepare").count())
      throw new Error("Successful review shows redundant refresh action");
    await page.getByTestId("authority-runs").fill("0");
    if (
      (await page.getByTestId("authority-runs").getAttribute("aria-invalid")) !== "true" ||
      (await page.getByTestId("authority-hours").getAttribute("aria-invalid")) === "true"
    )
      throw new Error("Run validation incorrectly marks the duration invalid");
    await page.getByTestId("authority-runs").fill("1");
    // This workflow has a LIVE approval for production (see the fixture at the
    // top of this file), so production is what it demonstrably runs in and
    // what the review must judge. Deriving this from whether a schedule
    // happened to be held instead sent a production workflow to development,
    // where none of its connectors exist — the dialog then filled with
    // "resolves to a connector of another environment" on nearly every step
    // and buried the one real problem. This assertion used to demand that
    // wrong answer. The counter-case — nothing saying production, so the
    // review stays in development, where a wrong guess cannot approve a
    // production effect — is pinned in apps/cockpit/src/lib/review-environment.test.ts.
    if (
      !(await page.getByTestId("authority-environment").innerText()).includes(
        locale === "de" ? "Produktion" : "Production",
      )
    )
      throw new Error("Grant ignores the environment the workflow runs in");
    // The switch to production that used to stand here is gone with the wrong
    // default: the dialog already opens in the environment this workflow runs
    // in, so selecting it again would change nothing.
    await page.getByTestId("authority-grant-review").waitFor();
    await page.getByTestId("authority-grant-review").locator("summary").last().click();
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
    // Two previews, not three: one when the dialog opens and one after the
    // explicit refresh. The third was a preview of DEVELOPMENT that nobody
    // asked for — fetched because the dialog opened in the wrong environment
    // and thrown away the moment the reviewer corrected it. A count that
    // silently grows again means the dialog is reviewing something the
    // reviewer did not choose.
    if (posts !== 2 || previews !== 2)
      throw new Error("Grant request counts do not match explicit review decisions");
    incomplete = true;
    await page.getByTestId("authority-grant-open").click();
    await page.getByTestId("authority-grant-review").waitFor();
    if (!(await page.getByTestId("authority-grant-confirm").isDisabled()))
      throw new Error("Truncated review can be granted");
    await page.getByTestId("authority-grant-cancel").click();
    if (posts !== 2) throw new Error("Incomplete or cancelled review caused a grant");
    incomplete = false;
    unsupported = true;
    await page.getByTestId("authority-grant-open").click();
    await page.getByTestId("authority-needs-adjustment").waitFor();
    if (
      (await page.getByTestId("authority-runs").count()) ||
      (await page.getByTestId("authority-hours").count()) ||
      (await page.getByTestId("authority-grant-confirm").count())
    )
      throw new Error("Unsupported workflow offers an impossible grant form");
    const adjustment = page.getByTestId("authority-adjust");
    const href = await adjustment.getAttribute("href");
    if (!href?.includes(`workflow_id=${workflowId}`) || !href.includes("prompt="))
      throw new Error("Adjustment loses the workflow context or the task");
    const dialogText = await page.getByRole("dialog").innerText();
    if (
      dialogText.includes(currentReview.manifest.workflow_version_id) ||
      dialogText.includes(baseAuthority.id)
    )
      throw new Error("Review exposes internal identifiers instead of useful names");
    await page.getByRole("dialog").evaluate(async (node) => {
      await Promise.all(
        node
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    await capture("adjustment");
    await page.getByTestId("authority-grant-cancel").click();
    if (posts !== 2) throw new Error("Unsupported review caused an execution grant");
    // What SubKit worked out for itself. Without this fixture the repair panel
    // renders in no screenshot at all, and a refusal that offers nothing looks
    // exactly like one that offers a repair.
    const proposalPattern = `**/v1/workflows/${workflowId}/boundary-proposals`;
    let applied = null;
    const proposalRoute = async (route) => {
      if (route.request().method() === "POST") {
        applied = route.request().postDataJSON();
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            draft: { version_id: "00000000-0000-4000-8000-000000000401", version: 9 },
            applied_step_ids: ["publish-report"],
          }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          proposals: [
            {
              step_id: "publish-report",
              boundary: {
                variables: { "input.site": { class: "identifier" } },
                max_body_bytes: 0,
                max_calls: 1,
              },
              evidence: {
                observations: 12,
                sample: "https://reports.example.test/monthly",
                newest_at: new Date().toISOString(),
              },
            },
          ],
          unproposable: [{ step_id: "send-mail", reason: "body_size_unknown" }],
        }),
      });
    };
    // The repair reads the workflow to learn which draft it builds on, so the
    // scenario has to serve one. Without it this tested the stand's coverage,
    // not the repair.
    const recordPattern = `**/v1/workflows/${workflowId}`;
    const recordRoute = async (route) =>
      route.request().method() === "GET"
        ? route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              id: workflowId,
              name: "Monatsreport",
              slug: "monatsreport",
              lifecycle: "active",
              current_version: 8,
              current_version_id: "00000000-0000-4000-8000-000000000301",
              draft_version_id: "00000000-0000-4000-8000-000000000302",
              steps: [],
              updated_at: "2026-08-10T09:00:00.000Z",
            }),
          })
        : route.fallback();
    await page.route(recordPattern, recordRoute);
    await page.route(proposalPattern, proposalRoute);
    await page.route(`${proposalPattern}/apply`, proposalRoute);
    // A fresh page, because the dialog asked for proposals earlier in this
    // scenario — before these routes existed — and that answer is cached.
    await stand.visit(page, `workflows/${workflowId}`);
    await page.getByTestId("authority-grant-open").click();
    await page.getByTestId("authority-needs-adjustment").waitFor();
    const repair = page.getByTestId("authority-repair");
    await repair.waitFor();
    const repairText = await repair.innerText();
    // The count and what it cannot do, both — an offer that hides its gaps is
    // how a reviewer ends up believing a workflow is fully bounded.
    if (!repairText.includes("1") || !repairText.includes("send-mail"))
      throw new Error(`Repair offer hides its scope: ${repairText}`);
    await capture("repair");
    await page.getByTestId("authority-repair-apply").click();
    // Wait for the request itself, not for a panel that was already on screen:
    // the review block renders throughout the refusal, so waiting on it
    // asserted before anything had left the page.
    for (let attempt = 0; applied === null && attempt < 100; attempt += 1) {
      await page.waitForTimeout(100);
    }
    if (applied === null) {
      const panel = (await page.getByTestId("authority-repair").count())
        ? await page.getByTestId("authority-repair").innerText()
        : "(the repair panel is gone)";
      throw new Error(`Applying the derived limits sent no request. Panel: ${panel}`);
    }
    if (applied?.expected_draft_version_id !== "00000000-0000-4000-8000-000000000302")
      throw new Error("The repair did not build on the draft the workflow actually has");
    await page.unroute(`${proposalPattern}/apply`, proposalRoute);
    await page.unroute(proposalPattern, proposalRoute);
    await page.unroute(recordPattern, recordRoute);
    // Escape, not the cancel button: after a repair the dialog is reloading
    // onto the prepared version, and every footer button is disabled while it
    // does. This scenario is about the repair, not about that button.
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    if (posts !== 2) throw new Error("The repair caused an execution grant");
  } finally {
    await page.unroute(previewPattern, preview);
    await page.unroute(grantPattern, grant);
  }
}
