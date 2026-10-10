const WORDS = {
  de: {
    target: ["Web-Dienst", "MCP-Server"],
    signIn: ["Ohne", "Mit Schlüssel", "Mit Konto"],
    secret: "Zugangsschlüssel",
    oauth: ["Rückleitung", "Anmeldedienst", "Client-ID", "Client-Secret", "Berechtigungen"],
    serviceFailed: "Anmeldedienst nicht gefunden oder hat abgelehnt.",
    publicUrl: "Anmeldung nicht möglich: Der Engine fehlt eine öffentliche Adresse.",
  },
  en: {
    target: ["Web service", "MCP server"],
    signIn: ["None", "With key", "With account"],
    secret: "Access key",
    oauth: ["Redirect address", "Sign-in service", "Client ID", "Client secret", "Scopes"],
    serviceFailed: "Sign-in service not found, or it refused.",
    publicUrl: "Sign-in can't start: the engine has no public address.",
  },
};

const JARGON = /OAuth|API-Schlüssel|API key/;
const OAUTH_FIELDS = [
  "create-connector-callback",
  "create-connector-issuer",
  "create-connector-client-id",
  "create-connector-client-secret",
  "create-connector-scopes",
];
const WEB_ID = "018f4b4a-6d33-7b3a-9c2d-1234567890d1";
const MCP_ID = "018f4b4a-6d33-7b3a-9c2d-1234567890d2";
const SECRET = "fixture-client-secret-value";

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function optionTexts(page, testId) {
  return (await page.getByTestId(testId).locator("button").allInnerTexts()).map((label) =>
    label.trim(),
  );
}

async function assertInside(page, testId) {
  await page.getByTestId(testId).waitFor({ state: "visible" });
}

async function openForm(page, stand) {
  await stand.visit(page, "connectors");
  await page.getByTestId("catalog-primary-action").click();
  const dialog = page.getByTestId("create-connector-dialog");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const manual = page.getByTestId("create-connector-manual");
  if (await manual.count()) await manual.click();
  await page.getByTestId("create-connector-target").waitFor({ state: "visible", timeout: 5_000 });
  return dialog;
}

async function oauthFieldsShown(page) {
  let shown = 0;
  for (const id of OAUTH_FIELDS) shown += await page.getByTestId(id).count();
  return shown;
}

function created(id, body) {
  const mcp = body.driver === "mcp";
  return {
    id,
    tenant_id: id,
    slug: body.slug,
    display_name: body.name,
    driver: body.driver,
    environment: body.environment,
    auth_type: body.auth_type,
    base_url: body.base_url,
    dsn: null,
    config: body.config?.oauth
      ? { oauth: { ...body.config.oauth, client_secret: "***redacted***" } }
      : {},
    operator_quirks: {},
    template_slug: null,
    template_name: null,
    template_source: null,
    template_version: null,
    template_snapshot: null,
    enabled: true,
    last_error: null,
    health_state: "ok",
    health_reason: null,
    health_error_code: null,
    circuit_state: "closed",
    circuit_opened_at: null,
    circuit_failure_count: 0,
    needs_reauth: false,
    auth_failed_at: null,
    auth_failed_reason: null,
    sign_in:
      body.auth_type === "oauth2"
        ? mcp
          ? { kind: "mcp", start: `/v1/connectors/${id}/mcp/authorize` }
          : { kind: "oauth", start: `/v1/connectors/${id}/oauth/start` }
        : null,
    created_at: "2026-08-10T09:00:00.000Z",
    updated_at: "2026-08-10T09:00:00.000Z",
  };
}

function createApi(state) {
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === "/v1/connectors" && request.method() === "POST") {
      const body = JSON.parse(request.postData() ?? "{}");
      state.posted.push(body);
      const id = body.driver === "mcp" ? MCP_ID : WEB_ID;
      state.byId[id] = body;
      return json(route, created(id, body), 201);
    }
    if (path === `/v1/connectors/${WEB_ID}/oauth/start`) {
      state.started.push(path);
      return json(
        route,
        { code: "oauth_start_failed", message: "could not begin sign-in", trace_id: null },
        502,
      );
    }
    if (path === `/v1/connectors/${MCP_ID}/mcp/authorize`) {
      state.started.push(path);
      return json(route, {
        authorization_url: `${url.origin}/cockpit/?provider=mcp-fixture`,
        state: "stand",
      });
    }
    if (
      path === `/v1/connectors/${WEB_ID}/mcp/authorize` ||
      path === `/v1/connectors/${MCP_ID}/oauth/start`
    ) {
      state.started.push(path);
      return json(route, { code: "not_found", message: "not found", trace_id: null }, 404);
    }
    const id = [WEB_ID, MCP_ID].find((each) => path === `/v1/connectors/${each}`);
    if (id && state.byId[id]) return json(route, created(id, state.byId[id]));
    if (
      path === `/v1/connectors/${WEB_ID}/credential` ||
      path === `/v1/connectors/${MCP_ID}/credential`
    )
      return json(route, null);
    return route.fallback();
  };
}

const isCreateApi = (url) => {
  const path = new URL(url).pathname;
  return (
    path === "/v1/connectors" ||
    path.startsWith(`/v1/connectors/${WEB_ID}`) ||
    path.startsWith(`/v1/connectors/${MCP_ID}`)
  );
};

async function fill(page, id, value) {
  await page.locator(`#${id}`).fill(value);
}

async function verifyForm(page, stand, words, where, capture) {
  const dialog = await openForm(page, stand);
  const target = await optionTexts(page, "create-connector-target");
  if (target.join("|") !== words.target.join("|"))
    throw new Error(`${where}: "what" offers ${JSON.stringify(target)}`);
  const signIn = await optionTexts(page, "create-connector-signin");
  if (signIn.join("|") !== words.signIn.join("|"))
    throw new Error(`${where}: "sign-in" offers ${JSON.stringify(signIn)}`);
  const visible = await dialog.innerText();
  if (JARGON.test(visible)) throw new Error(`${where}: the dialog still reads protocol words`);
  for (const testId of ["create-connector-target", "create-connector-signin"])
    await assertInside(page, testId, where);
  const secret = page.locator("#create-connector-secret");
  await secret.waitFor({ state: "visible", timeout: 5_000 });
  const label = (await page.locator('label[for="create-connector-secret"]').innerText()).trim();
  if (label !== words.secret) throw new Error(`${where}: the key field reads "${label}"`);
  if ((await oauthFieldsShown(page)) !== 0)
    throw new Error(`${where}: a new connector starts with more than its key`);
  await capture("create-connector-key");

  await page.getByTestId("create-connector-signin-account").click();
  if (await secret.count()) throw new Error(`${where}: an account sign-in asks for a key`);
  if ((await oauthFieldsShown(page)) !== OAUTH_FIELDS.length)
    throw new Error(`${where}: a web service with an account does not ask for its OAuth app`);
  const labels = [];
  for (const id of OAUTH_FIELDS)
    labels.push((await page.locator(`label[for="${id}"]`).innerText()).trim());
  if (labels.join("|") !== words.oauth.join("|"))
    throw new Error(`${where}: the OAuth app's fields read ${JSON.stringify(labels)}`);
  const bootstrap = await page.evaluate(async () =>
    (await fetch("/v1/cockpit/bootstrap", { credentials: "include" })).json(),
  );
  const callback = await page.getByTestId("create-connector-callback").inputValue();
  if (!bootstrap.oauth_callback_url || callback !== bootstrap.oauth_callback_url)
    throw new Error(`${where}: the redirect address reads "${callback}", not the engine's`);
  for (const id of OAUTH_FIELDS) await assertInside(page, id, where);
  await capture("create-connector-account");

  await page.getByTestId("create-connector-target-mcp").click();
  if ((await oauthFieldsShown(page)) !== 0)
    throw new Error(`${where}: an MCP server is asked for an OAuth app`);

  await page.getByTestId("create-connector-signin-key").click();
  await secret.waitFor({ state: "visible", timeout: 5_000 });

  await page.getByTestId("create-connector-target-web").click();
  if ((await oauthFieldsShown(page)) !== 0)
    throw new Error(`${where}: a web service with a key is asked for an OAuth app`);
  await page.getByTestId("create-connector-signin-none").click();
  if (await secret.count()) throw new Error(`${where}: no sign-in still asks for a key`);
  await page.getByTestId("create-connector-dialog-cancel").click();
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
}

async function verifyWebAccount(page, stand, words, where, state) {
  const dialog = await openForm(page, stand);
  await page.getByTestId("create-connector-signin-account").click();
  await fill(page, "create-connector-name", "Fixture Mail");
  await fill(page, "create-connector-address", "https://mail.example.org/v1");
  await fill(page, "create-connector-issuer", "https://accounts.example.org");
  await fill(page, "create-connector-client-id", "fixture-app");
  await fill(page, "create-connector-client-secret", SECRET);
  await fill(page, "create-connector-scopes", "mail.read mail.send");
  await page.getByTestId("create-connector-dialog-submit").click();
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: words.serviceFailed });
  await toast.first().waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForURL(
    (url) =>
      url.pathname.endsWith(`/connectors/${WEB_ID}`) &&
      url.searchParams.get("tab") === "connection",
    { timeout: 10_000 },
  );
  const sent = state.posted.at(-1);
  const oauth = sent?.config?.oauth ?? {};
  if (
    sent?.driver !== "http" ||
    sent?.auth_type !== "oauth2" ||
    oauth.issuer_url !== "https://accounts.example.org" ||
    oauth.client_id !== "fixture-app" ||
    oauth.client_secret !== SECRET ||
    oauth.scope !== "mail.read mail.send"
  )
    throw new Error(`${where}: the create sent ${JSON.stringify(sent)}`);
  if (state.started.at(-1) !== `/v1/connectors/${WEB_ID}/oauth/start`)
    throw new Error(`${where}: the sign-in started at ${state.started.at(-1)}`);
  if ((await page.locator("body").innerText()).includes(SECRET))
    throw new Error(`${where}: the client secret is shown again`);
}

async function verifyMcpAccount(page, stand, where, state) {
  await openForm(page, stand);
  await page.getByTestId("create-connector-target-mcp").click();
  await page.getByTestId("create-connector-signin-account").click();
  await fill(page, "create-connector-name", "Fixture Tickets");
  await fill(page, "create-connector-address", "https://mcp.tickets.example.org/mcp");
  const left = page.waitForURL((url) => url.searchParams.get("provider") === "mcp-fixture", {
    timeout: 15_000,
  });
  await page.getByTestId("create-connector-dialog-submit").click();
  await left;
  if (state.posted.at(-1)?.config) throw new Error(`${where}: an MCP server was sent an OAuth app`);
  if (state.started.at(-1) !== `/v1/connectors/${MCP_ID}/mcp/authorize`)
    throw new Error(`${where}: the MCP sign-in started at ${state.started.at(-1)}`);
}

async function verifyMcpPageSignIn(page, stand, where, state) {
  await stand.visit(page, `connectors/${MCP_ID}?tab=connection`);
  const signIn = page.getByTestId("connector-renew-signin");
  await signIn.waitFor({ state: "visible", timeout: 10_000 });
  const left = page.waitForURL((url) => url.searchParams.get("provider") === "mcp-fixture", {
    timeout: 15_000,
  });
  const before = state.started.length;
  await signIn.click();
  await left;
  const started = state.started.slice(before);
  if (started.join("|") !== `/v1/connectors/${MCP_ID}/mcp/authorize`)
    throw new Error(`${where}: the page's sign-in posted ${JSON.stringify(started)}`);
}

async function verifyNoPublicAddress(page, stand, words, where, state) {
  const original = await page.evaluate(async () =>
    (await fetch("/v1/cockpit/bootstrap", { credentials: "include" })).json(),
  );
  const matcher = (url) => new URL(url).pathname === "/v1/cockpit/bootstrap";
  const handler = (route) => json(route, { ...original, oauth_callback_url: null });
  await page.route(matcher, handler);
  try {
    const dialog = await openForm(page, stand);
    await page.getByTestId("create-connector-signin-account").click();
    if (await page.getByTestId("create-connector-callback").count())
      throw new Error(`${where}: a redirect address is shown that the engine does not have`);
    await fill(page, "create-connector-name", "Nowhere");
    await fill(page, "create-connector-address", "https://nowhere.example.org");
    await fill(page, "create-connector-issuer", "https://accounts.example.org");
    await fill(page, "create-connector-client-id", "app");
    const before = state.posted.length;
    await page.getByTestId("create-connector-dialog-submit").click();
    const error = page.getByTestId("create-connector-dialog-error");
    await error.waitFor({ state: "visible", timeout: 5_000 });
    if ((await error.innerText()).trim() !== words.publicUrl)
      throw new Error(`${where}: the error line reads "${await error.innerText()}"`);
    if (state.posted.length !== before)
      throw new Error(`${where}: a connector was made that no one can sign in`);
    await page.getByTestId("create-connector-dialog-cancel").click();
    await dialog.waitFor({ state: "hidden", timeout: 5_000 });
  } finally {
    await page.unroute(matcher, handler);
  }
}

export async function verifyCreateConnector(page, stand, localeName, capture) {
  const words = WORDS[localeName] ?? WORDS.en;
  const where = `/connectors/<create by hand> (${localeName})`;
  const state = { posted: [], started: [], byId: {} };
  const api = createApi(state);
  await page.route(isCreateApi, api);
  try {
    await verifyForm(page, stand, words, where, capture);
    await verifyWebAccount(page, stand, words, `${where} · web service with account`, state);
    await verifyMcpAccount(page, stand, `${where} · MCP server with account`, state);
    await verifyMcpPageSignIn(page, stand, `/connectors/<mcp with account> (${localeName})`, state);
    await verifyNoPublicAddress(page, stand, words, `${where} · no public address`, state);
  } finally {
    await page.unroute(isCreateApi, api);
  }
}
