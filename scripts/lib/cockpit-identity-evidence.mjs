import { LOCALE_TAGS, translate } from "../../apps/cockpit/src/lib/i18n.ts";

const CHECKED_AT = "2026-08-09T07:23:00.000Z";
const AUTHORITY_ID = "83a5ea73-46ce-497f-92f2-e3022a58d089";
const UNKNOWN_AUTHORITY_ID = "94b6fb84-57df-508a-a3f3-f3033b3e109a";
const ACTOR_ID = "56fd4ae5-87b5-4ad9-a6ec-adbcf327786e";
const UNKNOWN_ACTOR_ID = "67ef5bf6-98c6-50e9-b4fd-d4de4c43879f";
const TRACE_ID = "78f06c07-a9d7-510f-c50e-e5ef5d54980a";
const GROUP_ID = "65bf6592-a6f3-4d54-bc65-3a5d92eca871";
const ROLE_ID = "0e099ad8-d906-4dcc-a82d-3b20ec0c6553";
const ACTOR_EMAIL = "identity-reader@example.test";
const ACCOUNT_NAME = "Identity automation";
const GROUP_NAME = "Identity reviewers";
const ROLE_NAME = "Identity operators";
const ISSUER = "https://identity.example.test";
const CURRENT_SUBJECT = "current-provider-account";
const RECORDED_SUBJECT = "recorded-reader-account";
const SECOND_SUBJECT = "recorded-second-account";
const READ_CONNECTOR_NAME = "Identity read source";
const WRITE_CONNECTOR_NAME = "Identity write destination";
const API_ROUTE = "**/v1/**";

function require(condition, message) {
  if (!condition) throw new Error(message);
}

async function contains(locator, expected, label) {
  await locator.filter({ hasText: expected }).waitFor({ state: "visible" });
  require((await locator.innerText()).includes(expected), `${label}: missing ${expected}`);
}

async function excludes(locator, values, label) {
  const text = await locator.innerText();
  for (const value of values) require(!text.includes(value), `${label}: exposed ${value}`);
}

function startAccess(hidden) {
  return {
    permission: "workflow:run",
    caller: { allowed: !hidden, source: hidden ? null : "role", reason: null },
    visibility: { rules: !hidden },
    ...(hidden
      ? {}
      : {
          rules: {
            roles: [
              { id: "ea2a8c6f-9ffd-4391-bc5a-590f0fd88763", name: "admin" },
              { id: ROLE_ID, name: ROLE_NAME },
            ],
            grants: [
              { subject_type: "user", subject_id: ACTOR_ID, expires_at: null },
              { subject_type: "system_account", subject_id: ACTOR_ID, expires_at: null },
              { subject_type: "group", subject_id: GROUP_ID, expires_at: null },
            ],
          },
        }),
    external: { authentication_required: true, credential_restrictions_apply: true },
    without_approval: "held_preview_only",
  };
}

function identity(subject) {
  return { issuer: ISSUER, subject, source: "token_endpoint" };
}

async function transformedMock(route, mockApi, transform) {
  let fulfilled = false;
  await mockApi({
    request: () => route.request(),
    fulfill: async (response) => {
      require((response.status ?? 200) === 200, "Identity fixture base response is not successful");
      require(typeof response.body === "string", "Identity fixture requires a JSON base body");
      const body = JSON.parse(response.body);
      fulfilled = true;
      await route.fulfill({ ...response, body: JSON.stringify(transform(body)) });
    },
  });
  require(fulfilled, "Identity fixture did not fulfill its base response");
}

export async function verifyIdentityEvidence(page, stand, locale, capture, fixture) {
  const { mockApi, workflowId, workflowVersionId, connectorId, secondConnectorId, executionId } =
    fixture;
  require(connectorId !== secondConnectorId, "Identity fixture needs two distinct connectors");
  const state = { hidden: false, hideWorkflowLink: false, unknown: false, phase: "admission" };
  const requests = [];
  const authorityRequests = [];
  const handler = async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() !== "GET") return route.fallback();
    if (path === "/v1/cockpit/bootstrap") {
      return transformedMock(route, mockApi, (body) => ({
        ...body,
        principal: { ...body.principal, role_name: state.hidden ? "member" : "admin" },
        permissions: state.hidden
          ? body.permissions.filter(
              (permission) =>
                !["identity:read", "rbac:read", "workflow:run"].includes(permission) &&
                (!state.hideWorkflowLink || permission !== "workflow:read"),
            )
          : body.permissions,
      }));
    }
    if (path === "/v1/identity/users") {
      requests.push(path);
      return transformedMock(route, mockApi, (body) => ({
        ...body,
        items: [{ ...body.items[0], id: ACTOR_ID, email: ACTOR_EMAIL, role: "member" }],
      }));
    }
    if (path === "/v1/identity/system-accounts") {
      requests.push(path);
      return transformedMock(route, mockApi, (body) => ({
        ...body,
        items: [{ ...body.items[0], id: ACTOR_ID, name: ACCOUNT_NAME }],
      }));
    }
    if (path === "/v1/rbac/groups") {
      requests.push(path);
      return transformedMock(route, mockApi, (body) => ({
        ...body,
        items: [{ ...body.items[0], id: GROUP_ID, name: GROUP_NAME }],
      }));
    }
    if (path === "/v1/connectors") {
      return transformedMock(route, mockApi, (body) => ({
        ...body,
        items: [
          { ...body.items[0], id: connectorId, name: READ_CONNECTOR_NAME },
          { ...body.items[0], id: secondConnectorId, name: WRITE_CONNECTOR_NAME },
        ],
      }));
    }
    if (path === `/v1/workflows/${workflowId}/invocation`) {
      return transformedMock(route, mockApi, (body) => ({
        ...body,
        start_access: startAccess(state.hidden),
      }));
    }
    if (path === `/v1/connectors/${connectorId}/credential`) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          mode: "oauth2",
          environment: "prod",
          connection: null,
          header_names: [],
          missing_scopes: [],
          updated_at: CHECKED_AT,
          speaks_as: state.unknown ? null : identity(CURRENT_SUBJECT),
        }),
      });
    }
    if (path === `/v1/executions/${executionId}`) {
      return transformedMock(route, mockApi, (body) => ({
        ...body,
        workflow_id: workflowId,
        workflow_version_id: workflowVersionId,
        trace_id: TRACE_ID,
        execution_authority_id: state.unknown ? UNKNOWN_AUTHORITY_ID : AUTHORITY_ID,
        execution_environment: "prod",
        permission_basis: state.unknown ? null : "role",
        permission_phase: state.unknown ? null : state.phase,
        permission_checked_at: state.unknown ? null : CHECKED_AT,
      }));
    }
    const authorityMatch = path.match(/^\/v1\/workflows\/([^/]+)\/execution-authorities\/([^/]+)$/);
    if (authorityMatch?.[1] === workflowId) {
      authorityRequests.push(`${request.method()} ${path}`);
      const authorityId = decodeURIComponent(authorityMatch[2]);
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          id: authorityId,
          workflow_id: workflowId,
          workflow_version_id: workflowVersionId,
          effect_manifest_digest: "7".repeat(64),
          effect_manifest: { schema_version: 1, effects: [] },
          execution_environment: "prod",
          target_constraints: { targets: [] },
          valid_from: CHECKED_AT,
          valid_until: null,
          max_runs: null,
          reserved_runs: 1,
          remaining_runs: null,
          open_ended: true,
          created_by: state.unknown ? UNKNOWN_ACTOR_ID : ACTOR_ID,
          created_at: CHECKED_AT,
          revoked_at: null,
          revoked_by: null,
          inherited_from: null,
          superseded_by: null,
          active_version: true,
          ready_for_new_run: true,
          state: "approved",
        }),
      });
    }
    if (path === `/v1/executions/${executionId}/steps`) {
      return transformedMock(route, mockApi, (body) => {
        require(body.items.length >= 2, "Identity fixture requires two recorded steps");
        return {
          ...body,
          items: body.items.map((step, index) =>
            index === 0
              ? {
                  ...step,
                  request_meta: {
                    ...step.request_meta,
                    connector: { connector_id: connectorId, driver: "http" },
                    extras: { effect_kind: "read" },
                  },
                  credential_snapshots: state.unknown
                    ? []
                    : [
                        {
                          connector_id: connectorId,
                          environment: "prod",
                          credential_id: "018f4b4a-6d33-7b3a-9c2d-123456789a31",
                          credential_generation: 3,
                          connection_id: null,
                          access_token_version: null,
                          identity: identity(RECORDED_SUBJECT),
                        },
                        {
                          connector_id: secondConnectorId,
                          environment: "prod",
                          credential_id: "018f4b4a-6d33-7b3a-9c2d-123456789a32",
                          credential_generation: 5,
                          connection_id: null,
                          access_token_version: null,
                          identity: identity(SECOND_SUBJECT),
                        },
                      ],
                }
              : index === 1
                ? {
                    ...step,
                    step_key: "write_summary",
                    request_meta: {
                      connector: { connector_id: secondConnectorId, driver: "http" },
                      extras: { effect_kind: "write" },
                    },
                    credential_snapshots: [],
                  }
                : { ...step, credential_snapshots: [] },
          ),
        };
      });
    }
    return route.fallback();
  };
  const permissionValue = (facts) =>
    facts
      .locator(":scope > div")
      .filter({ has: page.getByText(translate(locale, "runs.permission.label"), { exact: true }) })
      .locator("dd");
  const authorizedByValue = (facts) =>
    facts
      .locator(":scope > div")
      .filter({
        has: page.getByText(translate(locale, "runs.permission.authorizedBy"), { exact: true }),
      })
      .locator("dd");
  const openRun = async () => {
    await stand.visit(page, `?run=${executionId}`);
    await page.getByTestId("run-detail").waitFor({ state: "visible" });
    await page.getByTestId("run-detail-why-toggle").click();
    await page.getByTestId("run-detail-why-facts").waitFor({ state: "visible" });
    await page.getByTestId("run-detail-technical-toggle").click();
    await page.getByTestId("run-detail-facts").waitFor({ state: "visible" });
  };
  const stepRow = (index) =>
    page.getByTestId(
      (page.viewportSize()?.width ?? 0) >= 1024
        ? `run-detail-step-list-row-${index}`
        : `run-detail-step-list-mobile-row-${index}`,
    );
  const openStep = async (index) => {
    const row = stepRow(index);
    await ((page.viewportSize()?.width ?? 0) >= 1024 ? row.locator("td").nth(1) : row).click();
    await page.getByTestId("run-step-identities").waitFor({ state: "visible" });
  };
  const closeStep = async () => {
    await page.getByTestId("run-step-close").click();
    await page.getByTestId("run-step-sheet").waitFor({ state: "hidden" });
  };
  await page.route(API_ROUTE, handler);
  try {
    await stand.visit(page, `workflows/${workflowId}?tab=use`);
    const access = page.getByTestId("workflow-start-access");
    await access.waitFor({ state: "visible" });
    const accessToggle = access.getByTestId("workflow-start-access-toggle");
    const startAccessLabel = locale === "de" ? "Wer darf starten" : "Who may start";
    require(translate(locale, "invocation.startAccess") ===
      startAccessLabel, `Start access translation must be "${startAccessLabel}"`);
    const accessibleAccessToggle = access.getByRole("button", {
      name: startAccessLabel,
      exact: true,
    });
    require((await accessibleAccessToggle.count()) === 1 &&
      (await accessibleAccessToggle.getAttribute("data-testid")) ===
        "workflow-start-access-toggle", `Start access disclosure must have the exact accessible label "${startAccessLabel}"`);
    require((await accessToggle.getAttribute("aria-expanded")) ===
      "false", "Start access must begin collapsed");
    await accessToggle.click();
    for (const text of [ROLE_NAME, ACTOR_EMAIL, ACCOUNT_NAME, GROUP_NAME])
      await contains(access, text, "visible start access");
    for (const key of [
      "invocation.startAllowed",
      "invocation.startExternal",
      "invocation.startPreview",
    ])
      await contains(access, translate(locale, key), "start access contract");
    await capture("identity-start-access-visible");

    await stand.visit(page, `connectors/${connectorId}?tab=connection`);
    const speaksAs = page.getByTestId("connector-speaks-as");
    await contains(speaksAs, CURRENT_SUBJECT, "current connector identity");
    await contains(speaksAs, ISSUER, "current connector issuer");
    await excludes(
      speaksAs,
      [ACTOR_EMAIL, ACCOUNT_NAME, GROUP_NAME, ROLE_NAME, ACTOR_ID],
      "current connector identity",
    );
    await capture("identity-connector-known");
    state.unknown = true;
    await stand.visit(page, `connectors/${connectorId}?tab=connection`);
    await contains(
      speaksAs,
      translate(locale, "runs.caller.unknown"),
      "unknown connector identity",
    );
    await excludes(
      speaksAs,
      [
        CURRENT_SUBJECT,
        RECORDED_SUBJECT,
        SECOND_SUBJECT,
        ACTOR_EMAIL,
        ACCOUNT_NAME,
        GROUP_NAME,
        ROLE_NAME,
        ACTOR_ID,
      ],
      "unknown connector identity",
    );
    await capture("identity-connector-unknown");
    state.unknown = false;

    for (const phase of ["admission", "start"]) {
      state.phase = phase;
      await openRun();
      const why = page.getByTestId("run-detail-why-facts");
      const when = await page.evaluate(
        ({ tag, value }) =>
          new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }).format(
            new Date(value),
          ),
        { tag: LOCALE_TAGS[locale], value: CHECKED_AT },
      );
      await contains(
        permissionValue(why),
        translate(locale, "runs.permission.role"),
        "recorded permission basis",
      );
      await contains(
        permissionValue(why),
        translate(locale, `runs.permission.${phase}`, { when }),
        "recorded check phase and time",
      );
      await contains(why, translate(locale, "authority.production"), "recorded environment");
      const runFacts = page.getByTestId("run-detail-facts");
      const assertRunFact = async (label, expected) => {
        const row = runFacts
          .locator(":scope > div")
          .filter({ has: page.getByText(label, { exact: true }) });
        require((await row.count()) === 1, `Run detail must show exactly one ${label} fact`);
        require((await row.locator("dd").innerText()).trim() ===
          expected, `Run detail ${label} value did not match the recorded value`);
      };
      await assertRunFact(translate(locale, "runs.detail.runId"), executionId);
      await assertRunFact(translate(locale, "authority.version"), workflowVersionId);
      await assertRunFact(translate(locale, "audit.detail.trace"), TRACE_ID);
      await contains(
        authorizedByValue(why),
        ACTOR_EMAIL,
        "execution authority grantor from the recorded authority",
      );
      require(authorityRequests.includes(
        `GET /v1/workflows/${workflowId}/execution-authorities/${AUTHORITY_ID}`,
      ), "The referenced execution authority was not fetched with its workflow-scoped GET");
      const link = why.locator(`a[title="${AUTHORITY_ID}"]`);
      await link.waitFor({ state: "visible" });
      const href = await link.getAttribute("href");
      const destination = new URL(href, page.url());
      require(destination.pathname === `/cockpit/workflows/${workflowId}` &&
        destination.hash ===
          "#workflow-automation", "Recorded approval link has wrong destination");
      await capture(`identity-permission-${phase}`);
    }
    const readStep = stepRow(0);
    const writeStep = stepRow(1);
    await readStep
      .getByText(`${translate(locale, "sideEffects.read")} · ${READ_CONNECTOR_NAME}`, {
        exact: true,
      })
      .waitFor({ state: "visible" });
    await writeStep
      .getByText(`${translate(locale, "sideEffects.write")} · ${WRITE_CONNECTOR_NAME}`, {
        exact: true,
      })
      .waitFor({ state: "visible" });
    const inline = stepRow(0).getByTestId("run-step-identities-inline-0");
    const identityToggle = inline.getByRole("button", {
      name: translate(locale, "connectorDetail.connection.speaksAs"),
      exact: true,
    });
    const inlineIdentities = [RECORDED_SUBJECT, SECOND_SUBJECT].map((subject) =>
      inline.getByText(`${subject} · ${ISSUER}`, { exact: true }),
    );
    require((await identityToggle.getAttribute("aria-expanded")) ===
      "false", "Row identity disclosure must begin collapsed");
    for (const fact of inlineIdentities) await fact.waitFor({ state: "hidden" });
    await identityToggle.click();
    require((await identityToggle.getAttribute("aria-expanded")) ===
      "true", "Row identity disclosure must expand");
    for (const fact of inlineIdentities) await fact.waitFor({ state: "visible" });
    require((await page.getByTestId("run-step-sheet").count()) ===
      0, "Inline identity disclosure must not open a separate step sheet");
    await identityToggle.click();
    require((await identityToggle.getAttribute("aria-expanded")) ===
      "false", "Row identity disclosure must collapse");
    for (const fact of inlineIdentities) await fact.waitFor({ state: "hidden" });
    await openStep(0);
    const identities = page.getByTestId("run-step-identities");
    for (const subject of [RECORDED_SUBJECT, SECOND_SUBJECT])
      await contains(identities, `${subject} · ${ISSUER}`, "historical credential identity");
    await excludes(
      identities,
      [CURRENT_SUBJECT],
      "historical identity cannot use current credential",
    );
    const recordedFacts = identities.locator("dl[data-slot='fact-list']");
    require((await recordedFacts.count()) ===
      2, "Expected separate facts for both dispatched credentials");
    for (const [index, generation] of [3, 5].entries()) {
      const value = recordedFacts
        .nth(index)
        .locator(":scope > div")
        .filter({
          has: page.getByText(translate(locale, "runs.step.credentialGeneration"), { exact: true }),
        })
        .locator("dd");
      require((await value.innerText()).trim() ===
        String(generation), "Recorded credential generation changed");
    }
    await capture("identity-step-multiple-recorded");
    await closeStep();
    await openStep(1);
    await contains(
      identities,
      translate(locale, "runs.caller.unknown"),
      "unrecorded step identity",
    );
    await excludes(
      identities,
      [RECORDED_SUBJECT, SECOND_SUBJECT, CURRENT_SUBJECT],
      "step cannot inherit another identity",
    );
    await capture("identity-step-unknown");
    await closeStep();

    state.unknown = true;
    await openRun();
    const unknown = page.getByTestId("run-detail-why-facts");
    await contains(
      permissionValue(unknown),
      translate(locale, "runs.caller.unknown"),
      "historical permission unknown",
    );
    await excludes(
      unknown,
      [translate(locale, "runs.permission.role")],
      "current access is not historical evidence",
    );
    await contains(
      authorizedByValue(unknown),
      translate(locale, "runs.permission.authorizedByUnknown"),
      "unresolved execution authority grantor",
    );
    require(authorityRequests.includes(
      `GET /v1/workflows/${workflowId}/execution-authorities/${UNKNOWN_AUTHORITY_ID}`,
    ), "The unknown authority fixture did not request its exact workflow-scoped resource");
    await capture("identity-permission-unknown");

    state.hidden = true;
    state.unknown = false;
    requests.length = 0;
    await stand.visit(page, `workflows/${workflowId}?tab=use`);
    await accessToggle.click();
    await contains(access, translate(locale, "invocation.startRulesHidden"), "hidden start rules");
    await contains(access, translate(locale, "invocation.startDenied"), "denied current caller");
    await excludes(
      access,
      [ROLE_NAME, ACTOR_EMAIL, ACCOUNT_NAME, GROUP_NAME, ACTOR_ID],
      "hidden start rules",
    );
    await capture("identity-start-access-hidden");
    require(requests.length === 0, "Hidden start rules requested restricted actor directories");
    state.hideWorkflowLink = true;
    const authorityRequestsBeforeHiddenRun = authorityRequests.length;
    await openRun();
    const hidden = page.getByTestId("run-detail-why-facts");
    await contains(
      permissionValue(hidden),
      translate(locale, "runs.permission.role"),
      "stored evidence survives current directory restrictions",
    );
    require((await hidden.locator(`a[title="${AUTHORITY_ID}"]`).count()) ===
      0, "Approval link exposed without workflow read permission");
    require(authorityRequests.length ===
      authorityRequestsBeforeHiddenRun, "Execution authority details were requested without workflow read permission");
    await capture("identity-approval-link-hidden");
  } finally {
    await page.unroute(API_ROUTE, handler);
  }
}
