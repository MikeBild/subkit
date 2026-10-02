// The run dialog of a saved workflow, answered by fixtures that follow the
// engine's real schemas — and by the answers that refuse.
//
// The defect this stands on: "Ausführen" → "Entwicklung" → "Ausführen" showed
// "Lauf: internal error". The development twin of the workflow's Mail
// connector had lost its sign-in; the engine threw, the route answered 500 and
// the dialog printed the raw message. Now:
//
// 1. The dialog reads the authority preview for the version POST really runs
//    (`current_version_id`, never the draft) in both environments. The
//    development preview names Mail as needing a new sign-in, so development
//    is offered disabled, with the reason in words, and production — the first
//    environment that can run — is the default. Production still asks first.
// 2. The preview is advisory. When it said nothing and the run is refused with
//    409 `prepared_credential_unavailable`, the dialog says the same sentence
//    from the refusal's `details` and links to that connector's sign-in.
// 3. A 500 is "could not be started", never the engine's "internal error".
// 4. Input fields are filled in by their type — a number field, a select of
//    the allowed values, a JSON area for an object — and a value that does not
//    fit its type is named and never sent as text under the right name. Every
//    field used to be a text input.

import { assertNoVisibleUuids } from "./cockpit-visible-uuids.mjs";

const WORKFLOW_ID = "6c1e7f24-3b9a-4d05-8e61-2f7a9c4d1b83";
const CURRENT_VERSION_ID = "b82d4f19-7c3e-4a60-9d15-e4a6c8f0b217";
const DRAFT_VERSION_ID = "1f5a9e3c-8b2d-4c71-a064-d3b7e9f2c518";
const DEV_MAIL_ID = "d94b2e61-5a8f-4c3d-b7e0-9f1a2c6d8e45";
const REFUSED_RUN_ID = "3e7c1a95-2d4b-4f68-a0c9-8b5e1d7f3a26";

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const RECORD = {
  id: WORKFLOW_ID,
  tenant_id: WORKFLOW_ID,
  name: "Tagesbericht versenden",
  slug: "tagesbericht",
  description: "Schickt den Tagesbericht per Mail.",
  lifecycle: "active",
  current_version: 4,
  current_version_id: CURRENT_VERSION_ID,
  // A newer draft exists. POST /v1/executions runs the CURRENT version, so the
  // pre-check must judge that one — judging the draft answers for a run that
  // is not about to happen.
  draft_version_id: DRAFT_VERSION_ID,
  health_state: "ok",
  health_reason: null,
  health_changed_at: null,
  steps: [{ id: "send", name: "Bericht senden", kind: "request" }],
  updated_at: "2026-08-10T09:00:00.000Z",
};

const MAIL_REFUSAL = {
  step_id: "send",
  connector_id: DEV_MAIL_ID,
  connector_slug: "mail",
  connector_name: "Mail",
};

/** WorkflowAuthorityPreview, as the engine shapes it. */
function preview(environment, unavailable) {
  return {
    manifest: {
      schema_version: 1,
      workflow_id: WORKFLOW_ID,
      workflow_version_id: CURRENT_VERSION_ID,
      execution_environment: environment,
      effects: [],
      issues: [],
    },
    digest: "a".repeat(64),
    eligible_for_repeated_runs: false,
    unavailable_steps: unavailable ? ["send"] : [],
    unavailable_connectors: unavailable ? [{ ...MAIL_REFUSAL, reason: "needs_reauth" }] : [],
    request_refusals: [],
    storage_refusals: [],
    execution_shape: { requests: [], iterations: [], run_limit_is_request_limit: false },
    schedules: [],
    suggested_bounds: {
      valid_from: "2026-08-10T09:00:00.000Z",
      valid_until: "2026-08-11T09:00:00.000Z",
      max_runs: 1,
    },
    suggested_bounds_basis: { kind: "manual" },
  };
}

/** One field of every control the dialog knows, in the engine's schema shape. */
const TYPED_SCHEMA = {
  type: "object",
  required: ["recipient_email", "limit"],
  properties: {
    recipient_email: { type: "string", format: "email", description: "Wer den Bericht bekommt" },
    limit: { type: "integer", default: 5 },
    mode: { type: "string", enum: ["draft", "live"] },
    options: { type: "object", properties: { deep: { type: "boolean" } } },
    dry: { type: "boolean" },
  },
};

/** `variant`: "blocked" (the preview names Mail), "refused" (it does not, the
 *  run is refused with 409), "crashed" (the run answers 500), "typed" (the
 *  workflow declares typed inputs; the run is refused as in "refused"). */
function runDialogApi(state) {
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === `/v1/workflows/${WORKFLOW_ID}`) return json(route, RECORD);
    if (path === `/v1/workflows/${WORKFLOW_ID}/input-schema`)
      return json(route, {
        source: "declared",
        schema: state.variant === "typed" ? TYPED_SCHEMA : null,
      });
    if (path === `/v1/workflows/${WORKFLOW_ID}/draft`)
      return json(route, { version_id: DRAFT_VERSION_ID, version: 5 });
    if (path === `/v1/workflows/${WORKFLOW_ID}/execution-authorities`)
      return json(route, { items: [], next_cursor: null });
    const previewMatch = path.match(
      new RegExp(`^/v1/workflows/${WORKFLOW_ID}/versions/([^/]+)/authority-preview$`),
    );
    if (previewMatch) {
      const environment = url.searchParams.get("environment");
      state.previewed.push(`${previewMatch[1]}:${environment}`);
      return json(
        route,
        preview(environment, state.variant === "blocked" && environment === "dev"),
      );
    }
    if (path === "/v1/executions" && request.method() === "POST") {
      state.runs.push({
        environment: request.headers()["x-subkit-environment"],
        body: request.postDataJSON(),
      });
      if (state.variant === "crashed")
        return json(route, { code: "internal_error", message: "internal error" }, 500);
      // The version was stored in an earlier format: refused by name, with the
      // steps that no longer validate.
      if (state.variant === "legacy")
        return json(
          route,
          {
            code: "workflow_version_legacy",
            message:
              'this workflow version is stored in an earlier definition format and cannot run — step "send", steps.0.language: invalid. Save the workflow again in the current format.',
            details: {
              issues: [{ path: "steps.0.language", step_id: "send", message: "invalid" }],
            },
          },
          409,
        );
      return json(
        route,
        {
          code: "prepared_credential_unavailable",
          message: 'Connector "mail" in dev must be reconnected before this workflow can run.',
          details: {
            ...MAIL_REFUSAL,
            environment: "dev",
            reason: "needs_reauth",
            execution_id: REFUSED_RUN_ID,
          },
        },
        409,
      );
    }
    return route.fallback();
  };
}

const isRunDialogApi = (url) => {
  const { pathname } = new URL(url);
  return pathname.startsWith(`/v1/workflows/${WORKFLOW_ID}`) || pathname === "/v1/executions";
};

async function text(page, testId) {
  const element = page.getByTestId(testId);
  if (!(await element.count())) return null;
  return (await element.first().innerText()).trim();
}

async function assertNoEngineWords(page, where) {
  const body = await page.locator("body").innerText();
  for (const raw of ["internal error", "internal_error", "must be reconnected before"])
    if (body.includes(raw)) throw new Error(`${where}: the dialog prints the engine's "${raw}"`);
}

async function openDialog(page, stand) {
  await stand.visit(page, `workflows/${WORKFLOW_ID}`);
  await page.getByTestId("workflow-run-open").click();
  await page.getByTestId("workflow-run-dialog").waitFor({ state: "visible", timeout: 10_000 });
}

export async function verifyRunDialog(page, stand, localeName, capture) {
  const de = localeName === "de";
  const state = { variant: "blocked", previewed: [], runs: [] };
  const handler = runDialogApi(state);
  await page.route(isRunDialogApi, handler);
  const where = `/workflows/<run dialog> (${localeName})`;
  try {
    // ── Development is blocked, with the reason, before anything runs ────────
    await openDialog(page, stand);
    const blocked = page.getByTestId("workflow-run-blocked-dev");
    await blocked.waitFor({ state: "visible", timeout: 10_000 });
    for (const version of state.previewed.map((entry) => entry.split(":")[0]))
      if (version !== CURRENT_VERSION_ID)
        throw new Error(`${where}: the pre-check judged version ${version}, not the one POST runs`);
    if (!state.previewed.some((entry) => entry.endsWith(":dev")))
      throw new Error(`${where}: development was never checked`);
    if (!state.previewed.some((entry) => entry.endsWith(":prod")))
      throw new Error(`${where}: production was never checked`);
    const sentence = (await blocked.innerText()).trim();
    const expected = de
      ? "Entwicklung: Mail muss neu verbunden werden"
      : "Development: Mail must be reconnected";
    if (!sentence.includes(expected))
      throw new Error(`${where}: the blocked line reads "${sentence}", not "${expected}"`);
    const reconnect = await page
      .getByTestId("workflow-run-blocked-dev-remedy")
      .getAttribute("href");
    if (reconnect !== `/cockpit/connectors/${DEV_MAIL_ID}#connector-credentials`)
      throw new Error(`${where}: the blocked line leads to ${reconnect}, not Mail's sign-in`);
    const chosen = await text(page, "workflow-run-environment");
    if (!chosen?.includes(de ? "Produktion" : "Production"))
      throw new Error(`${where}: the default is "${chosen}", not the first environment that runs`);
    await page.getByTestId("workflow-run-environment").click();
    const devItem = page.getByTestId("workflow-run-environment-dev");
    await devItem.waitFor({ state: "visible", timeout: 5_000 });
    if ((await devItem.getAttribute("data-disabled")) === null)
      throw new Error(`${where}: development can still be chosen`);
    if (!(await devItem.innerText()).includes(expected))
      throw new Error(`${where}: the disabled option does not say why`);
    await page.keyboard.press("Escape");
    // Production still asks before it runs.
    const submit = (await text(page, "workflow-run-submit")) ?? "";
    if (submit !== (de ? "Weiter" : "Continue"))
      throw new Error(`${where}: production runs without its confirmation ("${submit}")`);
    await assertNoEngineWords(page, where);
    await assertNoVisibleUuids(page.getByTestId("workflow-run-dialog"), where);
    await capture("run-dialog-blocked");

    // ── The pre-check said nothing; the run is refused with 409 ─────────────
    state.variant = "refused";
    state.previewed = [];
    await openDialog(page, stand);
    await page.getByTestId("workflow-run-submit").waitFor({ state: "visible" });
    for (let attempt = 0; attempt < 40 && state.previewed.length < 2; attempt += 1)
      await page.waitForTimeout(50);
    const chosenRefused = await text(page, "workflow-run-environment");
    if (!chosenRefused?.includes(de ? "Entwicklung" : "Development"))
      throw new Error(`${where} · refused: the default is "${chosenRefused}", not development`);
    await page.getByTestId("workflow-run-submit").click();
    const error = page.getByTestId("workflow-run-error");
    await error.waitFor({ state: "visible", timeout: 10_000 });
    if (state.runs.at(-1)?.environment !== "dev")
      throw new Error(`${where} · refused: the run went to ${state.runs.at(-1)?.environment}`);
    const said = (await error.innerText()).trim();
    if (!said.includes(expected))
      throw new Error(`${where} · refused: the dialog says "${said}", not "${expected}"`);
    const remedy = await page.getByTestId("workflow-run-error-remedy").getAttribute("href");
    if (remedy !== `/cockpit/connectors/${DEV_MAIL_ID}#connector-credentials`)
      throw new Error(`${where} · refused: the refusal leads to ${remedy}, not Mail's sign-in`);
    if (await page.getByTestId("workflow-run-outcome").count())
      throw new Error(`${where} · refused: an outcome line stands beside the refusal`);
    await assertNoEngineWords(page, `${where} · refused`);
    await capture("run-dialog-refused");

    // ── The engine fails: a sentence, never its words ─────────────────────────
    state.variant = "crashed";
    await openDialog(page, stand);
    for (let attempt = 0; attempt < 40 && state.previewed.length < 4; attempt += 1)
      await page.waitForTimeout(50);
    await page.getByTestId("workflow-run-submit").click();
    await page.getByTestId("workflow-run-error").waitFor({ state: "visible", timeout: 10_000 });
    const crashed = (await text(page, "workflow-run-error")) ?? "";
    const failed = de ? "Der Lauf konnte nicht gestartet werden." : "The run could not be started.";
    if (!crashed.includes(failed))
      throw new Error(`${where} · crashed: the dialog says "${crashed}"`);
    await assertNoEngineWords(page, `${where} · crashed`);

    // ── A version in an earlier format: refused by its reason ────────────────
    state.variant = "legacy";
    await openDialog(page, stand);
    await page.getByTestId("workflow-run-submit").waitFor({ state: "visible" });
    await page.getByTestId("workflow-run-submit").click();
    await page.getByTestId("workflow-run-error").waitFor({ state: "visible", timeout: 10_000 });
    const legacySaid = (await text(page, "workflow-run-error")) ?? "";
    if (
      !legacySaid.includes(de ? "älteren Format" : "earlier format") ||
      !legacySaid.includes("send")
    )
      throw new Error(`${where} · legacy: the dialog says "${legacySaid}"`);
    if (legacySaid.includes(failed))
      throw new Error(`${where} · legacy: a refusal with a reason reads as a fault`);
    for (const raw of ["definition format", "steps.0.language"])
      if (legacySaid.includes(raw))
        throw new Error(`${where} · legacy: the dialog prints the engine's "${raw}"`);
    await capture("run-dialog-legacy");

    // ── Fields are filled in by their type ───────────────────────────────────
    state.variant = "typed";
    state.previewed = [];
    await openDialog(page, stand);
    await page.getByTestId("workflow-run-inputs").waitFor({ state: "visible", timeout: 10_000 });
    for (let attempt = 0; attempt < 40 && state.previewed.length < 2; attempt += 1)
      await page.waitForTimeout(50);
    const typed = `${where} · typed`;
    const limit = page.getByTestId("workflow-run-input-1");
    if ((await limit.getAttribute("type")) !== "number")
      throw new Error(`${typed}: a whole number is filled in through a text field`);
    // The schema's default is what a run would use, so it is what stands there.
    if ((await limit.inputValue()) !== "5")
      throw new Error(`${typed}: the default is not shown: "${await limit.inputValue()}"`);
    const options = page.getByTestId("workflow-run-input-3");
    if ((await options.evaluate((node) => node.tagName)) !== "TEXTAREA")
      throw new Error(`${typed}: an object is filled in through a one-line field`);
    // Required and missing: named, and nothing runs.
    if (!(await text(page, "workflow-run-missing"))?.includes("recipient_email"))
      throw new Error(`${typed}: the missing required field is not named`);
    await page.getByTestId("workflow-run-input-0").fill("ops@example.org");
    // A value that does not fit its type: named, and nothing runs.
    await options.fill("{broken");
    if (!(await text(page, "workflow-run-invalid"))?.includes("options"))
      throw new Error(`${typed}: a value that is not JSON is not named`);
    if (!(await page.getByTestId("workflow-run-submit").isDisabled()))
      throw new Error(`${typed}: a run can start with an input of the wrong type`);
    await capture("run-dialog-typed");
    await options.fill('{"deep":true}');
    await page.getByTestId("workflow-run-input-2").click();
    await page.getByTestId("workflow-run-input-2-option-1").click();
    await page.getByTestId("workflow-run-input-4").click();
    await page.getByTestId("workflow-run-input-4-option-0").click();
    const before = state.runs.length;
    await page.getByTestId("workflow-run-submit").click();
    await page.getByTestId("workflow-run-error").waitFor({ state: "visible", timeout: 10_000 });
    const sent = state.runs.at(-1)?.body?.input;
    const wanted = {
      recipient_email: "ops@example.org",
      limit: 5,
      mode: "live",
      options: { deep: true },
      dry: true,
    };
    if (state.runs.length !== before + 1 || JSON.stringify(sent) !== JSON.stringify(wanted))
      throw new Error(`${typed}: the run was sent ${JSON.stringify(sent)}`);
  } finally {
    await page.unroute(isRunDialogApi, handler);
  }
}
