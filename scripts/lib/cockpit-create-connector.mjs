// "Konnektor hinzufügen" by hand asks two separate questions in short labels,
// and every answer leads somewhere a sign-in can actually start.
//
// The defects this stands on:
//
//   - The form offered "Art: [OAuth] [MCP] [API-Schlüssel]" — one control
//     mixing WHAT is connected with HOW SubKit signs in there, in protocol
//     words. A reader could not tell an API key from MCP.
//   - "Web-Dienst" + "Mit Konto" asked for no OAuth app, so the sign-in could
//     not start and the reader was dropped on a tab with nothing that worked.
//   - Signing in was chosen by driver in the browser; an MCP server was sent
//     to the web-service route, which cannot sign it in.
//
// Now:
//
// 1. "Was verbinden?" offers [Web-Dienst] [MCP-Server]; "Anmeldung" offers
//    [Mit Konto] [Mit Schlüssel] [Ohne]. Explanations live behind (?), never
//    inline.
// 2. Only the fields the answer needs: the access key for "Mit Schlüssel";
//    for a web service "Mit Konto" the redirect address to allow (the
//    engine's own, copyable) and the OAuth app — sign-in service, client ID,
//    client secret, scopes. An MCP server asks for none of them.
// 3. Both choices fit the dialog at every width the sweep runs.
// 4. Once created, the sign-in starts on the route the connector itself
//    states (`sign_in.start`). The fixture answers only that route — the other
//    one is a 404 — so a client that picks by driver fails here.
// 5. A sign-in that cannot start says why in one line; with no public engine
//    address the form refuses before making a connector no one can sign in.

const WORDS = {
  de: {
    target: ["Web-Dienst", "MCP-Server"],
    signIn: ["Mit Konto", "Mit Schlüssel", "Ohne"],
    secret: "Zugangsschlüssel",
    oauth: ["Rückleitung", "Anmeldedienst", "Client-ID", "Client-Secret", "Berechtigungen"],
    serviceFailed: "Anmeldedienst antwortet nicht. Adresse prüfen.",
    publicUrl: "Anmeldung nicht möglich: Der Engine fehlt eine öffentliche Adresse.",
  },
  en: {
    target: ["Web service", "MCP server"],
    signIn: ["With account", "With key", "None"],
    secret: "Access key",
    oauth: ["Redirect address", "Sign-in service", "Client ID", "Client secret", "Scopes"],
    serviceFailed: "The sign-in service didn't answer. Check its address.",
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

async function assertInside(page, testId, where) {
  const dialog = await page.getByTestId("create-connector-dialog").boundingBox();
  const control = await page.getByTestId(testId).boundingBox();
  if (!dialog || !control) throw new Error(`${where}: ${testId} is not on screen`);
  if (control.x < dialog.x - 0.5 || control.x + control.width > dialog.x + dialog.width + 0.5)
    throw new Error(`${where}: ${testId} runs past the dialog's edge`);
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

/** The connector as the engine answers a create: with the sign-in it states. */
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
    // What the engine hands back: the client secret masked, never the value.
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

/**
 * The engine's side of a create and its sign-in. The web service's sign-in
 * service fails its discovery (a named 502); the MCP server signs in on its
 * own route only. Each wrong route is a 404, as an engine would answer it.
 */
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
    // Made a moment ago: no credential stored yet.
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
  if (await page.locator("#create-connector-secret").count())
    throw new Error(`${where}: an account sign-in asks for a key`);

  // A web service with an account: the OAuth app it signs in through, and the
  // engine's own redirect address to allow there.
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

  // An MCP server finds its own sign-in service: nothing of the OAuth app.
  await page.getByTestId("create-connector-target-mcp").click();
  if ((await oauthFieldsShown(page)) !== 0)
    throw new Error(`${where}: an MCP server is asked for an OAuth app`);

  await page.getByTestId("create-connector-signin-key").click();
  const secret = page.locator("#create-connector-secret");
  await secret.waitFor({ state: "visible", timeout: 5_000 });
  const label = (await page.locator('label[for="create-connector-secret"]').innerText()).trim();
  if (label !== words.secret) throw new Error(`${where}: the key field reads "${label}"`);
  await capture("create-connector-key");

  await page.getByTestId("create-connector-target-web").click();
  if ((await oauthFieldsShown(page)) !== 0)
    throw new Error(`${where}: a web service with a key is asked for an OAuth app`);
  await page.getByTestId("create-connector-signin-none").click();
  if (await secret.count()) throw new Error(`${where}: no sign-in still asks for a key`);
  await page.getByTestId("create-connector-dialog-cancel").click();
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
}

/** A web service with an account: its OAuth app is sent, and a failed start says why. */
async function verifyWebAccount(page, stand, words, where, state) {
  const dialog = await openForm(page, stand);
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
      url.searchParams.get("tab") === "verbindung",
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

/** An MCP server with an account signs in on the route it states — never the web one. */
async function verifyMcpAccount(page, stand, where, state) {
  await openForm(page, stand);
  await page.getByTestId("create-connector-target-mcp").click();
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

/**
 * The MCP server's own page: "Anmelden" there starts the same route the
 * connector states. It used to post every connector to the web-service route,
 * which the fixture — like the engine — answers with a 404.
 */
async function verifyMcpPageSignIn(page, stand, where, state) {
  await stand.visit(page, `connectors/${MCP_ID}?tab=verbindung`);
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

/** No public engine address: the form says so and makes nothing. */
async function verifyNoPublicAddress(page, stand, words, where, state) {
  // The reader's own session, as the stand answers it, minus the address.
  const original = await page.evaluate(async () =>
    (await fetch("/v1/cockpit/bootstrap", { credentials: "include" })).json(),
  );
  const matcher = (url) => new URL(url).pathname === "/v1/cockpit/bootstrap";
  const handler = (route) => json(route, { ...original, oauth_callback_url: null });
  await page.route(matcher, handler);
  try {
    // A fresh load, so the session read carries the missing address.
    const dialog = await openForm(page, stand);
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
