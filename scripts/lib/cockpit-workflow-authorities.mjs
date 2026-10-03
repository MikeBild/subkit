import { assertNoVisibleUuids } from "./cockpit-visible-uuids.mjs";

/** Browser interactions use fixtures; the route integration suite verifies database enforcement. */
/**
 * Suggested bounds as the engine shapes them: one `now`, a whole number of
 * hours after it (`suggestAuthorityBounds`).
 */
function wholeDaySpan() {
  const from = Date.now();
  return {
    valid_from: new Date(from).toISOString(),
    valid_until: new Date(from + 86_400_000).toISOString(),
  };
}

export async function verifyWorkflowAuthorities(page, stand, workflowId, locale, photograph) {
  // Every frame this stand takes is also read for identifiers. The approval
  // cards were headed by their own UUID and printed version ids raw, and no
  // frame of them was ever checked: the route sweep never opened this page,
  // and its check only knew one fixture value anyway.
  const capture = async (state) => {
    await assertNoVisibleUuids(page.locator("body"), `workflow authorities/${state}`);
    await photograph(state);
  };
  const id = "a41f7c2e-9b3d-4e58-8f16-2c7d0b9e4a35";
  const olderId = "d8e2b5a1-4c6f-4a93-b7d0-6e1f3c8a2b94";
  const versionId = "3f6b9d2c-8e1a-4b75-9c40-a2d5e7f1b3c8";
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
    open_ended: false,
    inherited_from: null,
    superseded_by: null,
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
          // Until now no effect in this stand carried a boundary, so the panel
          // that turns rules into sentences was never in a frame — not for one
          // class. The two here are the two that matter: a value bound to a
          // form, and one bound to the whole remaining address. A class the
          // engine accepts and this dialog cannot name renders as "do not
          // approve", which is how a repaired production workflow once became
          // unapprovable with nothing wrong with it.
          boundary: {
            method: "POST",
            origin: "https://reports.example.test",
            segments: ["", "sites", { var: "input.site" }, { var: "item.path" }],
            variables: {
              "input.site": { class: "identifier" },
              "item.path": { class: "path" },
            },
            query: { fixed: {}, variable: [] },
            max_body_bytes: 0,
            max_calls: 40,
          },
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
  // The approval dialog is reached through the strip, and the strip offers it
  // only while approving is the workflow's top state (D15). This stand's
  // workflow runs well, so a failing run does not take the strip's one action.
  const healthy = (route) =>
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
            current_version_id: "018f4b4a-6d33-7b3a-9c2d-123456789ab8",
            created_at: "2026-06-01T08:00:00.000Z",
            updated_at: "2026-08-10T09:00:00.000Z",
            webhooks_active: 0,
            effective_trigger: { kind: "request", source: "default", state: "active" },
            steps: [],
            health_state: "ok",
            health_reason: null,
          }),
        })
      : route.fallback();
  const recordPattern = `**/v1/workflows/${workflowId}`;
  await page.route(recordPattern, healthy);
  // …and no repair waits for review, which would take it as well.
  const noRepair = (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ items: [] }),
    });
  const repairPattern = `**/v1/patch-candidates?*workflow_id=${workflowId}*`;
  await page.route(repairPattern, noRepair);
  try {
    // An approval that covers nothing that runs is history, and history is
    // folded in "Freigaben": it does not compete with the one state the strip
    // says.
    const openHistory = async () => {
      await page.getByTestId("workflow-tabs-tab-freigaben").click();
      const toggle = page.getByTestId("workflow-former-grants-toggle");
      await toggle.waitFor();
      if (await page.getByTestId("workflow-former-approvals-row-0").count())
        throw new Error("Earlier approvals stand open before anyone asked for them");
      await toggle.click();
      await page.getByTestId("workflow-former-approvals-row-0").waitFor({ state: "attached" });
    };
    const openRow = async (index) => {
      let link = page.getByTestId(`workflow-former-approvals-row-link-${index}`);
      if (!(await link.isVisible().catch(() => false)))
        link = page.getByTestId(`workflow-former-approvals-mobile-row-link-${index}`);
      await link.click();
      const sheet = page.getByTestId("authority-sheet");
      await sheet.waitFor();
      return sheet;
    };
    const closeSheet = async () => {
      await page.getByTestId("authority-sheet-close").click();
      await page.getByTestId("authority-sheet").waitFor({ state: "hidden" });
    };
    await stand.visit(page, `workflows/${workflowId}`);
    const panel = page.getByTestId("workflow-automation");
    await panel.waitFor();
    // Nothing starts this workflow and nothing current covers it: a calm
    // state, with the approval one press away and no badge asking for it.
    await page.getByTestId("workflow-automation-state").waitFor();
    if ((await panel.getAttribute("data-state")) !== "manual")
      throw new Error(
        `A workflow nothing starts reads as ${await panel.getAttribute("data-state")}, not as on request`,
      );
    await openHistory();
    const row = page
      .locator(
        '[data-testid="workflow-former-approvals-row-0"], [data-testid="workflow-former-approvals-mobile-row-0"]',
      )
      .filter({ visible: true });
    await capture("history");
    // The heading says what the reader decides by — where, until when, how
    // often — and the id lives on its title, for quoting, not on the page.
    const card = await openRow(0);
    const headline = card.getByTestId("authority-headline");
    if ((await headline.locator("[title]").first().getAttribute("title")) !== id)
      throw new Error("Authority headline does not keep the exact authority on its title");
    const headlineText = await headline.innerText();
    for (const expected of locale === "de"
      ? ["Produktion", "gültig bis", "bis zu 3 Läufe"]
      : ["Production", "valid until", "up to 3 runs"])
      if (!headlineText.includes(expected))
        throw new Error(`Authority headline ${JSON.stringify(headlineText)} lacks ${expected}`);
    for (const expected of [
      "https://reports.example.test/monthly",
      "POST",
      locale === "de"
        ? "Gilt für eine Fassung, die nicht läuft."
        : "For a version that is not running.",
    ]) {
      if (!(await card.innerText()).includes(expected))
        throw new Error(`Authority boundary missing: ${expected}`);
    }
    // The exact boundary — version, window, checksum — stands in the sheet.
    // A version this page cannot number is shortened, whole on the title.
    const version = card.getByTestId("authority-version");
    await version.waitFor();
    if ((await version.locator("[title]").first().getAttribute("title")) !== versionId)
      throw new Error("Authority version does not keep the exact version on its title");
    for (const expected of [
      `${versionId.slice(0, 8)}…`,
      locale === "de" ? "Noch 2 von 3 Runs verfügbar" : "2 of 3 runs remaining",
    ]) {
      if (!(await card.innerText()).includes(expected))
        throw new Error(`Authority detail missing: ${expected}`);
    }
    await capture("history-details");
    await closeSheet();
    await page.getByTestId("authority-more").click();
    await page.getByTestId("workflow-former-approvals-row-1").waitFor({ state: "attached" });
    await page.reload();
    await openHistory();
    if (writes !== 0) throw new Error("Reading or reloading authority history caused a mutation");
    const trigger = page.getByTestId("authority-history-0-revoke").filter({ visible: true });
    await trigger.focus();
    await trigger.press("Enter");
    const dialog = page.getByTestId("authority-revoke");
    await dialog.waitFor();
    await capture("revoke");
    // The confirmation names the approval it revokes — by its version, never
    // by printing the approval's UUID.
    const revokeTitle = await page.getByTestId("authority-revoke-title").innerText();
    if (!revokeTitle.includes(`${versionId.slice(0, 8)}…`) || revokeTitle.includes(id))
      throw new Error(`Revoke confirmation names ${JSON.stringify(revokeTitle)}`);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    if (writes !== 0) throw new Error("Dismissing the review revoked an authority");
    await trigger.press("Enter");
    await page.getByTestId("authority-revoke-confirm").click();
    await dialog.waitFor({ state: "hidden" });
    const revokedBadge = () =>
      row.locator("[data-tone]", { hasText: locale === "de" ? "Widerrufen" : "Revoked" });
    await revokedBadge().first().waitFor({ state: "attached" });
    await page.reload();
    await openHistory();
    await revokedBadge().first().waitFor({ state: "attached" });
    if (writes !== 1 || (await page.getByTestId("authority-history-0-revoke").count()))
      throw new Error("Revoked authority did not persist after reload");
    // A failed read is said as one — never as the calm state it would
    // otherwise fall through to, and never over a stale approval.
    failRead = true;
    await page.reload();
    await page.locator('[data-testid="workflow-automation"][data-state="failed"]').waitFor();
    if (await page.getByTestId("workflow-former-grants-toggle").count())
      throw new Error("Failed refresh still advertises a stale authority");
    failRead = false;
    await page.getByTestId("workflow-automation-failed-retry").click();
    await openHistory();
    for (const testId of ["workflow-automation", "workflow-former-grants"]) {
      const overflow = await page
        .getByTestId(testId)
        .evaluate((node) => node.scrollWidth > node.clientWidth + 1);
      if (overflow) throw new Error(`${testId} overflows the viewport`);
    }
    await verifyGrant(page, stand, workflowId, locale, authority, capture);
    await verifyPreparedVersion(page, stand, workflowId, locale, capture);
    await verifyActivationWhenNotApprovable(page, stand, workflowId, capture);
    await verifyEnvironmentCorrection(page, stand, workflowId, capture);
    await verifyLateReviewDropped(page, stand, workflowId);
    await verifyTrialAlreadyRunning(page, stand, workflowId, locale, capture);
  } finally {
    await page.unroute(repairPattern, noRepair);
    await page.unroute(recordPattern, healthy);
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
  const activeVersionId = "71c4e8a9-2d5b-4f36-8a1e-9b0c3d7f5e62";
  const draftVersionId = "b9e3a6d1-5f2c-4e87-a0b4-3c8d1e6f9a27";
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
          // One clock reading. Two readings a millisecond apart make the span
          // 24.0000003 hours, which the engine never sends and the dialog
          // rightly refuses as not a whole number.
          ...wholeDaySpan(),
          max_runs: 1,
        },
        suggested_bounds_basis: { kind: "manual" },
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
    // A saved change outranks everything but a pause: the panel says so, with
    // both numbers, and its one action opens the review of THAT version.
    const waiting = page.getByTestId("workflow-automation-headline");
    await waiting.waitFor();
    if ((await page.getByTestId("workflow-automation").getAttribute("data-state")) !== "apply")
      throw new Error("A saved change waiting next to the running version is not the state");
    const text = await waiting.innerText();
    // Both numbers, because either one alone leaves the reader guessing which
    // version they are about to put into service.
    for (const expected of ["v9", "v8"])
      if (!text.includes(expected))
        throw new Error(`Prepared-version notice omits ${expected}: ${text}`);
    await capture("prepared");
    await page.getByTestId("workflow-automation-action").click();
    await page.getByTestId("authority-grant-review").waitFor();
    if (reviewedVersion !== draftVersionId)
      throw new Error(
        `Approval judged ${reviewedVersion} while a prepared version was waiting — the running version is the one that could not be approved`,
      );
    const badge = await page.getByTestId("authority-version-label").innerText();
    if (!badge.includes(locale === "de" ? "vorbereitet" : "prepared"))
      throw new Error("Review does not say which version it is judging");
    // A saved change that CAN be approved: the dialog says that approving it
    // puts it into service.
    await page.getByTestId("authority-scope-version").waitFor();
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

    await page.getByTestId("workflow-automation-action").click();
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
  const activeVersionId = "8b1e5d3a-7c4f-4a62-8e95-d0a3c6b2f7e1";
  const draftVersionId = "f6a9c2e7-1d8b-4b34-a7c5-5e2d9f0b4a86";
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
          // One clock reading. Two readings a millisecond apart make the span
          // 24.0000003 hours, which the engine never sends and the dialog
          // rightly refuses as not a whole number.
          ...wholeDaySpan(),
          max_runs: 1,
        },
        suggested_bounds_basis: { kind: "manual" },
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
    await page.getByTestId("workflow-automation-action").click();
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
  const versionId = "2c5f8b1e-9a4d-4e73-b6a2-8d1c4f7e3b59";
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
          // One clock reading. Two readings a millisecond apart make the span
          // 24.0000003 hours, which the engine never sends and the dialog
          // rightly refuses as not a whole number.
          ...wholeDaySpan(),
          max_runs: 1,
        },
        suggested_bounds_basis: { kind: "manual" },
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
    await page.getByTestId("workflow-automation-action").click();
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

/**
 * A review that answers late answers nobody.
 *
 * The review request that FINISHES last is not always the one that was ASKED
 * last. The dialog seeded its review from every call that completed, so an
 * older answer landing after a newer one replaced the review the reader was
 * looking at — and, when it named another version or environment, left a
 * complete-looking review whose confirm button stayed disabled for good. Nor
 * could the reader close the dialog while a review was loading.
 *
 * Hostile on purpose: the FIRST preview is held back until after the dialog
 * was closed and reopened and the second one has been answered. Each answer
 * carries its own digest, so an approval issued from the stale review is
 * caught by what it sends, not only by whether the button is enabled.
 */
async function verifyLateReviewDropped(page, stand, workflowId) {
  const versionId = "e4b7a0d3-6c2f-4f98-8b51-3a9e6d2c1f74";
  const workflowPattern = `**/v1/workflows/${workflowId}`;
  const previewPattern = `**/v1/workflows/${workflowId}/versions/*/authority-preview?*`;
  const grantPattern = `**/v1/workflows/${workflowId}/execution-authorities`;
  const historyPattern = `**/v1/workflows/${workflowId}/execution-authorities**`;
  let previews = 0;
  let granted = null;
  let lateAnswered;
  const late = new Promise((resolve) => {
    lateAnswered = resolve;
  });
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
            steps: [],
            updated_at: "2026-08-10T09:00:00.000Z",
          }),
        })
      : route.fallback();
  const preview = async (route) => {
    previews += 1;
    const call = previews;
    const url = new URL(route.request().url());
    const body = JSON.stringify({
      digest: String(call).repeat(64),
      manifest: {
        schema_version: 1,
        workflow_id: workflowId,
        workflow_version_id: url.pathname.split("/").at(-2),
        execution_environment: url.searchParams.get("environment"),
        effects: [],
        issues: [],
      },
      eligible_for_repeated_runs: true,
      unavailable_steps: [],
      suggested_bounds: { ...wholeDaySpan(), max_runs: 1 },
      suggested_bounds_basis: { kind: "manual" },
      execution_shape: { requests: [], iterations: [], run_limit_is_request_limit: false },
    });
    if (call !== 1) return route.fulfill({ status: 200, contentType: "application/json", body });
    // Held until the second answer is already on screen.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    try {
      await route.fulfill({ status: 200, contentType: "application/json", body });
    } catch {
      // The page may already have dropped the request; the answer is stale either way.
    } finally {
      lateAnswered();
    }
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
    await page.getByTestId("workflow-automation-action").click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    // Closing while the review is still loading: nothing has been submitted,
    // so nothing may hold the reader in the dialog.
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {
      throw new Error("The dialog could not be closed while its review was still loading");
    });
    if (previews !== 1) throw new Error(`Expected one held review, saw ${previews}`);
    await page.getByTestId("workflow-automation-action").click();
    await page.getByTestId("authority-grant-review").waitFor();
    // Now let the stale answer arrive, and give the page a moment to act on it.
    await late;
    await page.waitForTimeout(300);
    const confirm = page.getByTestId("authority-grant-confirm");
    await page
      .waitForFunction(
        () => {
          const node = document.querySelector('[data-testid="authority-grant-confirm"]');
          return Boolean(node) && !node.disabled;
        },
        { timeout: 30_000 },
      )
      .catch(() => {});
    if (await confirm.isDisabled())
      throw new Error(
        `Approval stayed unavailable after a late review answer. Dialog: ${(await dialog.innerText()).slice(0, 500)}`,
      );
    await confirm.click();
    await dialog.waitFor({ state: "hidden" });
    if (granted?.expected_manifest_digest !== "2".repeat(64))
      throw new Error(
        `Approval was issued from a review nobody was looking at: digest ${granted?.expected_manifest_digest?.slice(0, 1)}… instead of the latest`,
      );
  } finally {
    await page.unroute(grantPattern, grant);
    await page.unroute(previewPattern, preview);
    await page.unroute(workflowPattern, record);
    await page.unroute(historyPattern, noHistory);
  }
}

/**
 * A trial run that was already going when this dialog asked for one.
 *
 * Opening this approval STARTS a held run. Nothing said so, and the wait showed
 * a bare "loading" for minutes — which is why three runs once started at once
 * against one workflow. The engine now refuses the second with a reason, and
 * the reason must arrive as information: a second tab and a repair reload both
 * take this path routinely, so rendering it red turns correct behaviour into an
 * alarm. No frame carried this state before, because the stand never served the
 * preparation route at all.
 */
async function verifyTrialAlreadyRunning(page, stand, workflowId, locale, capture) {
  const versionId = "e4b7a0d3-6c2f-4f98-8b51-3a9e6d2c1f74";
  const previewPattern = `**/v1/workflows/${workflowId}/versions/*/authority-preview?*`;
  const preparePattern = `**/v1/workflows/${workflowId}/versions/*/prepare-authority`;
  const historyPattern = `**/v1/workflows/${workflowId}/execution-authorities**`;
  let prepareCalls = 0;
  const noHistory = async (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ items: [], next_cursor: null }),
        })
      : route.fallback();
  const preview = async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        digest: "c".repeat(64),
        manifest: {
          schema_version: 1,
          workflow_id: workflowId,
          workflow_version_id: versionId,
          execution_environment: "prod",
          effects: [],
          issues: [],
        },
        // Unapprovable and asking for a trial run — the only shape in which
        // this dialog reaches the preparation route at all.
        eligible_for_repeated_runs: false,
        preparation_required: true,
        unavailable_steps: [],
        suggested_bounds: {
          // One clock reading. Two readings a millisecond apart make the span
          // 24.0000003 hours, which the engine never sends and the dialog
          // rightly refuses as not a whole number.
          ...wholeDaySpan(),
          max_runs: 1,
        },
        suggested_bounds_basis: { kind: "manual" },
        execution_shape: { requests: [], iterations: [], run_limit_is_request_limit: false },
      }),
    });
  const prepare = async (route) => {
    prepareCalls += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ prepared: false, reason: "preparation_in_flight" }),
    });
  };
  await page.route(historyPattern, noHistory);
  await page.route(previewPattern, preview);
  await page.route(preparePattern, prepare);
  try {
    await stand.visit(page, `workflows/${workflowId}`);
    await page.getByTestId("workflow-automation-action").click();
    const notice = page.getByTestId("authority-trial-elsewhere");
    await notice.waitFor({ timeout: 30_000 });
    await capture("trial-already-running");
    if (prepareCalls !== 1)
      throw new Error(`The dialog asked for ${prepareCalls} trial runs, not one`);
    // The words, not just the box: the failure this guards against is the
    // engine's correct "one run, not three" arriving as a failure notice.
    const text = await notice.innerText();
    const expected = locale === "de" ? "läuft bereits ein Probelauf" : "already in progress";
    if (!text.includes(expected))
      throw new Error(`The running trial is not named: ${text.slice(0, 200)}`);
    if ((await page.locator('[data-testid="authority-trial-elsewhere"].destructive').count()) > 0)
      throw new Error("Correct behaviour is rendered as a failure");
    const failure = page.getByText(
      locale === "de" ? "konnte nicht geladen werden" : "could not be loaded",
      { exact: false },
    );
    if ((await failure.count()) > 0)
      throw new Error("A trial run already in progress is reported as a load failure");
  } finally {
    await page.unroute(preparePattern, prepare);
    await page.unroute(previewPattern, preview);
    await page.unroute(historyPattern, noHistory);
    // Leave the page as it was found. Unrouting alone is not enough: this
    // scenario opened a dialog that filled the client's query cache for THIS
    // workflow id with a review of its own, and every later scenario reads that
    // same id. The first pass went green and the third came back with a review
    // it never asked for — a stand that leaks into the next scenario measures
    // the leak, not the product. Proven by running the sweep without this
    // scenario: 788 frames, green.
    await page.keyboard.press("Escape").catch(() => {});
    // A real page of the product, not `about:blank`: that has no origin, so the
    // app's own localStorage read throws there and the sweep collects the
    // console error in every locale. A full navigation is what resets the
    // client cache — a same-origin one.
    await stand.visit(page, "workflows");
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
      suggested_bounds_basis: { kind: "manual" },
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
    await page.getByTestId("workflow-automation-action").click();
    await page.getByTestId("authority-grant-review").waitFor();
    // The dialog starts at "until revoked"; the limits below are a choice.
    if (await page.getByTestId("authority-runs").count())
      throw new Error("The grant dialog does not start at 'until revoked'");
    await page.getByTestId("authority-limit-limited").click();
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
    // Until the fixture carried a boundary, the panel that turns rules into
    // sentences was in no frame at all — not for one class. Both are asserted
    // as prose, because the failure mode is not a missing panel: it is the
    // dialog falling back to "limited by a rule this dialog cannot describe",
    // which passes a screenshot count and blocks the approval. That is exactly
    // how a repaired production workflow once became unapprovable with nothing
    // wrong with it.
    // The operations list must lead with WHAT HAPPENS, not with the authored
    // step id. A reader being asked to approve was met with `publish-report`,
    // an identifier that answers a different question than the one they are
    // being asked. Both parts are still on screen; the order is the point, so
    // the order is what this asserts.
    const operations = await page.getByTestId("authority-grant-review").innerText();
    const effectWord = locale === "de" ? "Schreiben" : "Write";
    const effectAt = operations.indexOf(effectWord);
    const stepAt = operations.indexOf("publish-report");
    if (effectAt < 0 || stepAt < 0)
      throw new Error(`Operations list lost a part: effect=${effectAt} step=${stepAt}`);
    if (stepAt < effectAt)
      throw new Error("The step id leads the operations list again; the effect must");
    const boundaryPanel = await page.getByTestId("authority-request-boundary").innerText();
    for (const sentence of [
      locale === "de" ? "jede Seite unter dieser einen Adresse" : "any page on this one address",
      locale === "de" ? "jede Kennung aus Buchstaben" : "any identifier made of letters",
    ]) {
      if (!boundaryPanel.includes(sentence))
        throw new Error(`Grant cannot describe a rule it was given: ${sentence}`);
    }
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
    await page.getByTestId("workflow-automation-action").click();
    await page.getByTestId("authority-grant-review").waitFor();
    if (!(await page.getByTestId("authority-grant-confirm").isDisabled()))
      throw new Error("Truncated review can be granted");
    await page.getByTestId("authority-grant-cancel").click();
    if (posts !== 2) throw new Error("Incomplete or cancelled review caused a grant");
    incomplete = false;
    unsupported = true;
    await page.getByTestId("workflow-automation-action").click();
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
            draft: { version_id: "8b1e5d3a-7c4f-4a62-8e95-d0a3c6b2f7e1", version: 9 },
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
              current_version_id: "5e8a1c7d-3b9f-4d26-b5e0-7a4c2f1d8b63",
              draft_version_id: "c2d7f4b8-6a1e-4c59-9d83-1f5b8e3a7c40",
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
    await page.getByTestId("workflow-automation-action").click();
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
    if (applied?.expected_draft_version_id !== "c2d7f4b8-6a1e-4c59-9d83-1f5b8e3a7c40")
      throw new Error("The repair did not build on the draft the workflow actually has");
    await page.unroute(`${proposalPattern}/apply`, proposalRoute);
    await page.unroute(proposalPattern, proposalRoute);
    await page.unroute(recordPattern, recordRoute);
    // Escape while the dialog may still be reloading onto the prepared
    // version: a review that is only loading must not hold the reader in the
    // dialog (it used to, and this press was silently dropped).
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    if (posts !== 2) throw new Error("The repair caused an execution grant");
  } finally {
    await page.unroute(previewPattern, preview);
    await page.unroute(grantPattern, grant);
  }
}
