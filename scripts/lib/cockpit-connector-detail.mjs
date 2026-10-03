// The connector detail page, answered by fixtures that follow the engine's
// real schemas — and by the ones that refuse.
//
// An MCP connector: a real address, `config.mcp` with one remote tool the
// operator already let run "Ohne Rückfrage", a header key named X-API-KEY,
// calls in the week with a failure, a negotiated session, and — only after
// "Verbindung testen" — the server's tool list. The page must say all of it in
// its own words, lead every count to the audit log of the SAME connector and
// the SAME window (§10.1), and send the operator's decision per tool.
//
// Then the hostile variants a sweep of happy fixtures never sees: a connector
// that was never called (a counted zero opens nothing, and the empty state
// says so without repeating "Verbindung testen"), a runtime read that fails (a
// failure with a retry, not an empty page), a reader without `stats:read` (one
// sentence, not a zero and not three tiles saying "no permission"), and a
// postgres connector (no server tools, no MCP words, and — signing in with
// nothing — no sign-in card to say so a second time).
//
// And the sign-in, on a connector that signs in at a provider: signed in,
// needing a sign-in, switched off, both at once — the state the page has to
// say truthfully after the provider sends the browser back — and a sign-in
// that was granted fewer permissions than it asked for. In every one of them
// an effect has exactly one trigger and the page has at most one filled action.

import { assertSingleTriggers } from "./cockpit-single-trigger.mjs";
import { assertNoVisibleUuids } from "./cockpit-visible-uuids.mjs";

const MCP_ID = "018f4b4a-6d33-7b3a-9c2d-1234567890c1";
const PG_ID = "018f4b4a-6d33-7b3a-9c2d-1234567890c2";
const OAUTH_ID = "018f4b4a-6d33-7b3a-9c2d-1234567890c4";
const ADDRESS = "https://mcp.tickets.example.org/v1/mcp";

const days = (count) => new Date(Date.parse("2026-08-10T09:00:00.000Z") - count * 86_400_000);
const iso = (count) => days(count).toISOString();

function mcpRecord(trusted) {
  return {
    id: MCP_ID,
    tenant_id: MCP_ID,
    slug: "tickets-mcp",
    display_name: "Ticket-Server",
    description: "Tickets suchen und anlegen.",
    driver: "mcp",
    environment: "prod",
    auth_type: "header",
    base_url: ADDRESS,
    dsn: null,
    config: {
      mcp: {
        transport: "http",
        auth: { kind: "header" },
        ...(trusted.length > 0 ? { tools_without_confirmation: trusted } : {}),
      },
    },
    operator_quirks: {},
    template_slug: null,
    template_name: null,
    template_source: null,
    template_version: null,
    template_snapshot: null,
    self_description: {
      links: [
        {
          kind: "llms_txt",
          url: "https://mcp.tickets.example.org/llms.txt",
          source: "discovery",
          discovered_at: iso(3),
        },
      ],
    },
    enabled: true,
    last_error: null,
    health_state: "ok",
    health_reason: null,
    health_error_code: null,
    needs_reauth: false,
    auth_failed_at: null,
    auth_failed_reason: null,
    created_at: iso(30),
    updated_at: iso(1),
  };
}

const PG_RECORD = {
  ...mcpRecord([]),
  id: PG_ID,
  slug: "lager-db",
  display_name: "Lagerdatenbank",
  description: null,
  driver: "postgres",
  auth_type: "none",
  // The address as the engine hands it out: the password kept, the marker in
  // its place. The page must not show the marker as if it were the value.
  base_url: "postgres://reader:***redacted***@db.example.org:5432/lager",
  config: {},
  self_description: undefined,
};

/** A connector that signs in at its provider, in the state the check sets. */
function oauthRecord(state) {
  return {
    ...mcpRecord([]),
    id: OAUTH_ID,
    slug: "example-mail",
    display_name: "Example Mail",
    description: null,
    driver: "http",
    auth_type: "oauth2",
    base_url: "https://mail.example.org/v1",
    config: { oauth: { scope: "mail.read mail.send" } },
    self_description: undefined,
    enabled: state.enabled,
    needs_reauth: state.needsReauth,
    auth_failed_at: state.needsReauth ? iso(60) : null,
    auth_failed_reason: state.needsReauth ? "credential rejected" : null,
    health_state: state.needsReauth ? "needs_reauth" : "ok",
    circuit_state: state.needsReauth ? "open" : "closed",
    circuit_failure_count: state.needsReauth ? 44 : 0,
    circuit_opened_at: state.needsReauth ? iso(60) : null,
  };
}

const RUNTIME = {
  last_success_at: iso(0.1),
  last_failure: { at: iso(1), code: "remote_error", cause_class: "driver_error" },
  recorded: true,
  mcp_session: {
    protocol_version: "2025-06-18",
    capabilities: ["prompts", "tools"],
    last_handshake_at: iso(0.05),
    consecutive_failures: 0,
    backoff_until: null,
  },
};

function stats(url, total) {
  return {
    bucket: "day",
    tz: "UTC",
    from: url.searchParams.get("from"),
    to: url.searchParams.get("to"),
    groups: [],
    totals: {
      calls: {
        total,
        by_outcome:
          total === 0 ? { success: 0, denied: 0, error: 0 } : { success: 9, denied: 1, error: 2 },
        by_status_class: {},
      },
      latency_ms: {
        total: total * 85,
        avg: total ? 85 : 0,
        p50: total ? 85 : 0,
        p95: 0,
        p99: 0,
        max: 0,
      },
    },
  };
}

const INSPECT = {
  connector_id: MCP_ID,
  slug: "tickets-mcp",
  tools: [
    { name: "search_items", description: "Tickets suchen", claims: "read" },
    { name: "create_ticket", description: "Ein Ticket anlegen", claims: "write" },
  ],
  capabilities: { tools: true, resources: false, prompts: true },
  instructions: null,
  server_version: null,
};

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Answers the connector surfaces this check needs; `variant` makes one of them hostile. */
function connectorApi(state, variant) {
  return async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    if (path === `/v1/connectors/${MCP_ID}`) return json(route, mcpRecord(state.trusted));
    if (path === `/v1/connectors/${PG_ID}`) return json(route, PG_RECORD);
    if (path === `/v1/connectors/${OAUTH_ID}`) {
      state.oauth.reads += 1;
      return json(route, oauthRecord(state.oauth));
    }
    if (path === `/v1/connectors/${OAUTH_ID}/credential`)
      return json(route, {
        mode: "oauth2",
        environment: "prod",
        connection: null,
        header_names: [],
        missing_scopes: state.oauth.missing,
        updated_at: iso(state.oauth.needsReauth ? 90 : 0),
      });
    if (path === `/v1/connectors/${OAUTH_ID}/enable`) {
      // What the engine does: switch it on, answer with the connector as it
      // now stands. Nothing else about it changes.
      state.oauth.enabled = true;
      return json(route, oauthRecord(state.oauth));
    }
    if (path === `/v1/connectors/${OAUTH_ID}/oauth/start`) {
      // The provider round-trip, collapsed: the engine's callback stores the
      // credential, clears the sign-in flag and the breaker — NOT the switch —
      // and redirects the browser to this page with the flag.
      state.oauth.started += 1;
      state.oauth.needsReauth = false;
      state.oauth.missing = state.oauth.grants;
      return json(route, {
        authorization_url: `${url.origin}/cockpit/connectors/${OAUTH_ID}?signed_in=1`,
        state: "stand",
      });
    }
    if (path === `/v1/connectors/${MCP_ID}/credential`)
      return json(route, {
        mode: "header",
        environment: "prod",
        connection: null,
        header_names: ["X-API-KEY"],
        updated_at: iso(4),
      });
    if (path === `/v1/connectors/${PG_ID}/credential`) return json(route, null);
    // "Unterhaltungen dazu" for the sign-in connector: refused, or none — the
    // two answers the section used to word the same way.
    if (
      path === "/v1/conversations" &&
      url.searchParams.get("target_connector_id") === OAUTH_ID &&
      state.oauth.conversations !== "served"
    ) {
      if (state.oauth.conversations === "failed")
        return json(route, { error: { code: "internal", message: "fixture refuses" } }, 500);
      return json(route, { items: [], total: 0 });
    }
    if (path === `/v1/connectors/${OAUTH_ID}/runtime`)
      return json(route, {
        // A sign-in is not a call: it moves neither of these.
        last_success_at: iso(75),
        last_failure: { at: iso(60), code: "4xx_auth", cause_class: "auth_failed" },
        recorded: true,
        mcp_session: null,
      });
    if (path.endsWith("/runtime")) {
      if (variant === "failed")
        return json(route, { error: { code: "internal", message: "fixture refuses" } }, 500);
      if (path.includes(PG_ID))
        return json(route, {
          last_success_at: null,
          last_failure: null,
          recorded: true,
          mcp_session: null,
        });
      return json(route, RUNTIME);
    }
    if (path === "/v1/stats/connectors")
      return json(route, stats(url, variant === "zero" ? 0 : 12));
    if (path === `/v1/connectors/${MCP_ID}/mcp/inspect`) return json(route, INSPECT);
    if (path === `/v1/connectors/${MCP_ID}/mcp/tool-confirmation`) {
      const body = JSON.parse(request.postData() ?? "{}");
      state.sent.push(body);
      state.trusted = body.confirm
        ? state.trusted.filter((name) => name !== body.tool)
        : [...new Set([...state.trusted, body.tool])].sort();
      return json(route, {
        tool: body.tool,
        confirm: body.confirm,
        tools_without_confirmation: state.trusted,
      });
    }
    if (path === `/v1/connectors/${MCP_ID}/test`) return json(route, { ok: true, latency_ms: 42 });
    if (path === "/v1/workflows" && url.searchParams.get("connector"))
      return json(route, {
        items: [{ id: "018f4b4a-6d33-7b3a-9c2d-1234567890c3", name: "Tickets zusammenfassen" }],
        total: 1,
        categories: [],
      });
    return route.fallback();
  };
}

const isConnectorApi = (url) => {
  const path = new URL(url).pathname;
  return (
    path.startsWith(`/v1/connectors/${MCP_ID}`) ||
    path.startsWith(`/v1/connectors/${PG_ID}`) ||
    path.startsWith(`/v1/connectors/${OAUTH_ID}`) ||
    path === "/v1/stats/connectors" ||
    path === "/v1/workflows" ||
    path === "/v1/conversations"
  );
};

async function text(page, testId) {
  const element = page.getByTestId(testId);
  if (!(await element.count())) return null;
  return (await element.first().innerText()).trim();
}

async function assertNoSidewaysScroll(page, where) {
  const wide = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  );
  if (wide) throw new Error(`${where}: the page scrolls sideways`);
}

async function withBootstrap(page, drop, body) {
  // The reader's own session, minus one permission.
  const original = await page.evaluate(async () =>
    (await fetch("/v1/cockpit/bootstrap", { credentials: "include" })).json(),
  );
  const narrowed = { ...original, permissions: original.permissions.filter((p) => p !== drop) };
  const matcher = (url) => new URL(url).pathname === "/v1/cockpit/bootstrap";
  const handler = (route) => json(route, narrowed);
  await page.route(matcher, handler);
  try {
    await body();
  } finally {
    await page.unroute(matcher, handler);
  }
}

/** Every effect the page can trigger, and every element that triggers it. */
const EFFECTS = {
  "test the connection": ["connector-test", "connector-runtime-test"],
  "renew the sign-in": ["connector-renew-signin", "connector-renew", "detail-action"],
  "switch the connector on": ["connector-enable"],
};

/**
 * One action once per view: an effect has at most one trigger, no two actions
 * on the page share a label, and at most one action is filled.
 */
async function assertOneTriggerPerEffect(page, where) {
  for (const [effect, ids] of Object.entries(EFFECTS)) {
    let triggers = 0;
    for (const id of ids) triggers += await page.getByTestId(id).count();
    if (triggers > 1) throw new Error(`${where}: ${triggers} triggers ${effect}`);
  }
  const found = await page.evaluate(() => {
    const main = document.querySelector('[data-testid="detail-connectors"]');
    // Actions, not rows: a list's entries are links that may share a name.
    const controls = [...(main?.querySelectorAll('[data-slot="button"]') ?? [])].filter(
      (element) => element instanceof HTMLElement && element.offsetParent !== null,
    );
    const labels = controls.map((element) => element.innerText.trim()).filter(Boolean);
    return {
      repeated: labels.filter((label, index) => labels.indexOf(label) !== index),
      filled: controls.filter((element) => element.getAttribute("data-variant") === "default")
        .length,
    };
  });
  if (found.repeated.length > 0)
    throw new Error(`${where}: a label stands twice — ${found.repeated.join(", ")}`);
  if (found.filled > 1) throw new Error(`${where}: ${found.filled} filled actions on one page`);
}

/** How often a word stands in the page's main area. */
async function occurrences(page, word) {
  const body = await page.getByTestId("detail-connectors").innerText();
  return body.split(word).length - 1;
}

/** Choose one of the page's tabs. */
async function openTab(page, tab) {
  await page.getByTestId(`connector-tabs-tab-${tab}`).click();
}

/** Open a folded section of the current tab. */
async function unfold(page, testId) {
  await page.getByTestId(`${testId}-toggle`).click();
}

/**
 * Press "Neu anmelden" and come back as the provider round-trip does: a full
 * page load of the connector's page with the flag, which the page then drops.
 *
 * The address before and after is the same, so waiting for the address proves
 * nothing — the page that was there already has it. What proves the return is
 * the load itself, then the flag being gone.
 */
async function signInAtProvider(page) {
  const loaded = page.waitForEvent("load", { timeout: 15_000 });
  await page.getByTestId("connector-renew-signin").click();
  await loaded;
  await page.waitForURL((url) => url.pathname.endsWith(OAUTH_ID) && !url.search, {
    timeout: 15_000,
  });
  await page.getByTestId("connector-strip-state").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForLoadState("networkidle");
  // Where the sign-in itself stands is said in "Verbindung".
  await openTab(page, "verbindung");
  await page.getByTestId("connector-credentials").waitFor({ state: "visible", timeout: 10_000 });
}

/**
 * The sign-in's state where it stands: the strip when it is the connector's
 * whole state ("Verbunden"), else the badge of "Anmeldung".
 */
async function signInWord(page) {
  return (await text(page, "connector-auth-state")) ?? (await text(page, "connector-strip-state"));
}

async function openOauth(page, stand) {
  await stand.visit(page, `connectors/${OAUTH_ID}?tab=verbindung`);
  await page.getByTestId("connector-credentials").waitFor({ state: "visible", timeout: 10_000 });
  // The sign-in state settles with the credential read; read it after that.
  await page.waitForLoadState("networkidle");
}

/**
 * The sign-in of a connector that signs in at a provider, state by state.
 *
 * The state that matters most is the one a person lands in after the provider:
 * the engine has stored the credential, cleared the sign-in flag and closed the
 * breaker — and left the connector switched off, because switching it on is a
 * separate decision. The strip must say exactly that, once, with the one act
 * that changes it.
 */
async function verifyConnectorSignIn(page, stand, oauth, de, capture) {
  const set = (next) => Object.assign(oauth, { missing: [], grants: [], ...next });
  // One action once per view, by both readings: an effect has one trigger and
  // at most one filled action (this file), and no two triggers share a name
  // or an address (the family's `assertSingleTriggers`).
  const assertOnce = async (label) => {
    await assertOneTriggerPerEffect(page, label);
    await assertSingleTriggers(page, label);
  };
  const words = de
    ? {
        connected: "Verbunden",
        expired: "Abgelaufen",
        off: "Abgeschaltet",
        signedIn: "Angemeldet",
        signedInOff: "Angemeldet, aber abgeschaltet",
        renew: "Neu anmelden",
        enable: "Einschalten",
        whatRenewDoes: "führt zum Anbieter und wieder hierher",
        misleading: "Verbindungstest liefert",
        missing: "Es fehlen: mail.send.",
        steps: "Schritte im Chat",
        kind: "Anmeldung beim Anbieter (OAuth)",
        readOnly: "Erneuern darf, wer diesen Konnektor ändern darf",
      }
    : {
        connected: "Connected",
        expired: "Expired",
        off: "Switched off",
        signedIn: "Signed in",
        signedInOff: "Signed in, but switched off",
        renew: "Sign in again",
        enable: "Switch on",
        whatRenewDoes: "takes you to the provider and back here",
        misleading: "to get the renewal link",
        missing: "Missing: mail.send.",
        steps: "steps in the chat",
        kind: "Sign-in with the provider (OAuth)",
        readOnly: "takes permission to change this connector",
      };
  const strip = page.getByTestId("connector-state");
  const noticeKind = async () => (await strip.getAttribute("data-notice")) || null;
  /** The strip's one action is this one, and stands in the strip. */
  const stripOffers = async (testId) =>
    (await strip.getByTestId(testId).count()) === 1 &&
    (await page.getByTestId(testId).count()) === 1;
  let where = "/connectors/<oauth> · signed in";

  // ── Signed in ────────────────────────────────────────────────────────────
  set({ enabled: true, needsReauth: false });
  await openOauth(page, stand);
  if ((await signInWord(page)) !== words.connected)
    throw new Error(`${where}: the sign-in reads "${await signInWord(page)}"`);
  if ((await occurrences(page, words.connected)) !== 1)
    throw new Error(`${where}: the sign-in state does not stand exactly once`);
  if (await noticeKind()) throw new Error(`${where}: a notice with nothing to say`);
  for (const id of ["connector-renew-signin", "connector-enable", "detail-action"])
    if (await page.getByTestId(id).count())
      throw new Error(`${where}: "${id}" is offered with nothing to fix`);
  // A connector has no steps and no lifecycle: no "Steuerung" row, no sentence about them.
  if (await page.locator('[data-family-slot="detail-context"]').count())
    throw new Error(`${where}: a state row with nothing in it`);
  if ((await page.getByTestId("detail-connectors").innerText()).includes(words.steps))
    throw new Error(`${where}: the page talks about a connector's steps`);
  // How it signs in is a fact of the connection, said there and not again in
  // the sign-in block.
  if ((await occurrences(page, words.kind)) !== 1)
    throw new Error(`${where}: the kind of sign-in does not stand exactly once`);
  await assertOnce(where);
  await assertNoVisibleUuids(page.locator("main").first(), where);
  await assertNoSidewaysScroll(page, where);
  await capture("connector-signin-connected");

  // "Unterhaltungen dazu" ("Verwendung"): a read that failed says so and
  // offers a retry; a connector nobody talked about has no section. Neither
  // reads as the other.
  set({ enabled: true, needsReauth: false, conversations: "failed" });
  await openOauth(page, stand);
  await openTab(page, "verwendung");
  await page.getByTestId("detail-conversations-toggle").click();
  await page
    .getByTestId("detail-conversation-retry")
    .filter({ visible: true })
    .first()
    .waitFor({ timeout: 15_000 });
  if (await page.getByTestId("detail-conversation-row-0").count())
    throw new Error(`${where}: conversations stand beside the failure`);
  await capture("connector-conversations-failed");
  set({ enabled: true, needsReauth: false, conversations: "empty" });
  await openOauth(page, stand);
  await openTab(page, "verwendung");
  await page.getByTestId("connector-usage-summary").waitFor();
  await page.waitForLoadState("networkidle");
  // While the list loads the section stands with its skeleton; once the
  // answer is empty it goes.
  await page
    .getByTestId("detail-conversations")
    .waitFor({ state: "detached", timeout: 10_000 })
    .catch(() => {});
  if (await page.getByTestId("detail-conversations").count())
    throw new Error(`${where}: an empty "Unterhaltungen dazu" section is on the page`);
  set({ conversations: "served" });

  // ── Needs a sign-in ──────────────────────────────────────────────────────
  where = "/connectors/<oauth> · needs sign-in";
  set({ enabled: true, needsReauth: true });
  await openOauth(page, stand);
  if ((await signInWord(page)) !== words.expired)
    throw new Error(`${where}: the sign-in reads "${await signInWord(page)}"`);
  if ((await occurrences(page, words.expired)) !== 1)
    throw new Error(`${where}: "${words.expired}" does not stand exactly once`);
  const sentence = (await text(page, "connector-credential-sentence")) ?? "";
  if (!sentence.includes(words.whatRenewDoes) || sentence.includes(words.misleading))
    throw new Error(`${where}: the line does not say what the button does — "${sentence}"`);
  if ((await text(page, "connector-renew-signin")) !== words.renew)
    throw new Error(`${where}: no "${words.renew}" in the strip`);
  // Renewing has one home: the strip (D6).
  if (!(await stripOffers("connector-renew-signin")))
    throw new Error(`${where}: renewing the sign-in is not the strip's one action`);
  await assertOnce(where);
  await capture("connector-signin-expired");

  // A flag typed into the address confirms nothing the connector does not bear out.
  await stand.visit(page, `connectors/${OAUTH_ID}?signed_in=1`);
  await page.getByTestId("connector-strip-state").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForLoadState("networkidle");
  if (await noticeKind()) throw new Error(`${where}: a typed flag made the page confirm a sign-in`);
  if (new URL(page.url()).searchParams.has("signed_in"))
    throw new Error(`${where}: the flag stays in the address`);

  // A reader who may not change the connector is told so, and offered nothing.
  await withBootstrap(page, "connector:write", async () => {
    await openOauth(page, stand);
    if (await page.getByTestId("connector-renew-signin").count())
      throw new Error(`${where} · read-only: a renewal the reader may not start`);
    const line = (await text(page, "connector-credential-sentence")) ?? "";
    if (!line.includes(words.readOnly))
      throw new Error(`${where} · read-only: the line reads "${line}"`);
  });

  // ── Switched off AND needing a sign-in ───────────────────────────────────
  // The lost sign-in leads; switching on is the next state, counted, and gets
  // its action once the sign-in is back (D15).
  where = "/connectors/<oauth> · switched off, needs sign-in";
  set({ enabled: false, needsReauth: true });
  await openOauth(page, stand);
  if ((await noticeKind()) !== "off") throw new Error(`${where}: nothing says it is switched off`);
  if (!(await stripOffers("connector-renew-signin")))
    throw new Error(`${where}: the lost sign-in is not the strip's action`);
  if (await page.getByTestId("connector-enable").count())
    throw new Error(`${where}: a second action stands beside the lost sign-in`);
  if (!(await strip.innerText()).includes("+1"))
    throw new Error(`${where}: switched off is not counted beside the lost sign-in`);
  if ((await occurrences(page, words.expired)) !== 1)
    throw new Error(`${where}: "${words.expired}" does not stand exactly once`);
  await assertOnce(where);
  await capture("connector-signin-off-expired");

  // ── …and back from the provider: signed in, still switched off ───────────
  where = "/connectors/<oauth> · signed in, switched off";
  const startedBefore = oauth.started;
  await signInAtProvider(page);
  if (oauth.started !== startedBefore + 1)
    throw new Error(`${where}: "${words.renew}" started ${oauth.started - startedBefore} sign-ins`);
  if ((await noticeKind()) !== "signed_in_off")
    throw new Error(`${where}: the page says "${await noticeKind()}" after the sign-in`);
  if (!(await strip.innerText()).includes(words.signedInOff))
    throw new Error(`${where}: the strip reads "${await strip.innerText()}"`);
  // The sign-in is fresh, not the one the page showed before it left.
  if ((await signInWord(page)) !== words.connected)
    throw new Error(`${where}: still reads "${await signInWord(page)}"`);
  if (await occurrences(page, words.expired))
    throw new Error(`${where}: "${words.expired}" for a connector that was just signed in`);
  if (await page.getByTestId("connector-renew-signin").count())
    throw new Error(`${where}: a renewal is offered for a sign-in that works`);
  if (!(await stripOffers("connector-enable")))
    throw new Error(`${where}: "${words.enable}" is not the strip's one action`);
  // The switch is the person's: the sign-in did not flip it.
  if (oauth.enabled) throw new Error(`${where}: signing in switched the connector on`);
  await assertOnce(where);
  await assertNoVisibleUuids(page.locator("main").first(), where);
  await assertNoSidewaysScroll(page, where);
  await capture("connector-signin-off-signed-in");

  // Switching on shows at once — from the engine's answer, without another read.
  const readsBefore = oauth.reads;
  await page.getByTestId("connector-enable").click();
  await page.getByTestId("connector-enable").waitFor({ state: "detached", timeout: 10_000 });
  if ((await noticeKind()) !== "signed_in")
    throw new Error(`${where}: after switching on the page says "${await noticeKind()}"`);
  if (await occurrences(page, words.off))
    throw new Error(`${where}: "${words.off}" for a connector that was just switched on`);
  if (oauth.reads !== readsBefore)
    throw new Error(`${where}: the new state waited for another read of the connector`);
  await capture("connector-signin-switched-on");

  // The sentence is said once: a reload has nothing to repeat.
  await openOauth(page, stand);
  if (await noticeKind()) throw new Error(`${where}: the confirmation repeats on reload`);

  // ── Switched off, nothing else ───────────────────────────────────────────
  where = "/connectors/<oauth> · switched off";
  set({ enabled: false, needsReauth: false });
  await openOauth(page, stand);
  if ((await noticeKind()) !== "off") throw new Error(`${where}: nothing says it is switched off`);
  if (!(await stripOffers("connector-enable")))
    throw new Error(`${where}: switching on is not the strip's one action`);
  await assertOnce(where);
  await capture("connector-signin-off");
  await withBootstrap(page, "connector:write", async () => {
    await openOauth(page, stand);
    if ((await noticeKind()) !== "off")
      throw new Error(`${where} · read-only: nothing says it is switched off`);
    if (await page.getByTestId("connector-enable").count())
      throw new Error(`${where} · read-only: a switch the reader may not flip`);
  });

  // ── Signed in with fewer permissions than asked for ──────────────────────
  where = "/connectors/<oauth> · partial grant";
  set({ enabled: true, needsReauth: true, grants: ["mail.send"] });
  await openOauth(page, stand);
  await signInAtProvider(page);
  if ((await noticeKind()) !== "signed_in")
    throw new Error(`${where}: the page says "${await noticeKind()}" after the sign-in`);
  const withheld = (await text(page, "connector-missing-scopes")) ?? "";
  if (!withheld.includes(words.missing))
    throw new Error(`${where}: the withheld permissions are not named — "${withheld}"`);
  // The way to get them is to sign in again — the strip's one action.
  if ((await text(page, "connector-renew-signin")) !== words.renew)
    throw new Error(`${where}: no "${words.renew}" for the withheld permissions`);
  await assertOnce(where);
  await capture("connector-signin-partial");
}

export async function verifyConnectorDetail(page, stand, localeName, capture) {
  const de = localeName === "de";
  const state = {
    trusted: ["search_items"],
    sent: [],
    oauth: {
      enabled: true,
      needsReauth: false,
      missing: [],
      grants: [],
      started: 0,
      reads: 0,
      conversations: "served",
    },
  };
  let variant = null;
  const handler = (route) => connectorApi(state, variant)(route);
  await page.route(isConnectorApi, handler);
  const where = `/connectors/<mcp> (${localeName})`;
  /** "Verbindung", with its runtime unfolded. */
  const openConnection = async (id) => {
    await stand.visit(page, `connectors/${id}?tab=verbindung`);
    await page.getByTestId("connector-connection-facts").waitFor({ timeout: 10_000 });
    await unfold(page, "connector-runtime-section");
    await page.getByTestId("connector-runtime").waitFor({ state: "visible", timeout: 10_000 });
  };
  try {
    // ── The MCP connector, answered in full ──────────────────────────────────
    await openConnection(MCP_ID);
    await page.getByTestId("connector-figure-calls-link").waitFor({ timeout: 10_000 });

    const order = await page.evaluate(() =>
      [
        "connector-connection-facts",
        "connector-credentials",
        "connector-runtime-section",
        "connector-technical",
      ].map((id) => {
        const element = document.querySelector(`[data-testid="${id}"]`);
        return element ? element.getBoundingClientRect().top + window.scrollY : null;
      }),
    );
    if (order.some((top) => top === null))
      throw new Error(`${where}: a section is missing — ${JSON.stringify(order)}`);
    for (let i = 1; i < order.length; i += 1)
      if (order[i] < order[i - 1])
        throw new Error(`${where}: the sections are not in reading order`);

    // An address without a secret is copied as it stands.
    const copy = page.getByTestId("connector-copy-address");
    if (!(await copy.count())) throw new Error(`${where}: a plain address cannot be copied`);
    const address = await copy.inputValue();
    if (!address.includes(ADDRESS)) throw new Error(`${where}: the address is not shown whole`);
    const facts = {
      kind: de ? "MCP-Server" : "MCP server",
      transport: "Streamable HTTP",
      "sign-in": de ? "Schlüssel im Header X-API-KEY" : "Key in the header X-API-KEY",
      environment: de ? "Produktion" : "Production",
    };
    for (const [fact, expected] of Object.entries(facts)) {
      const shown = await page.getByTestId(`connector-fact-${fact}`).textContent();
      if (!shown?.includes(expected))
        throw new Error(`${where}: "${fact}" reads "${shown}" instead of "${expected}"`);
    }

    // Each count opens the audit log of this connector over the same window.
    const calls = await page.getByTestId("connector-figure-calls-link").getAttribute("href");
    const failed = await page.getByTestId("connector-figure-success-link").getAttribute("href");
    const callsQuery = new URL(calls ?? "", "http://x").searchParams;
    const failedQuery = new URL(failed ?? "", "http://x").searchParams;
    if (
      callsQuery.get("resource_type") !== "mcp_external_tool" ||
      callsQuery.get("resource_id") !== MCP_ID ||
      callsQuery.get("action") !== "mcp_external_tool.invoked" ||
      !callsQuery.get("ts_from") ||
      !callsQuery.get("ts_to")
    )
      throw new Error(`${where}: the call count does not open its own calls — ${calls}`);
    if (
      failedQuery.get("result") !== "error" ||
      failedQuery.get("ts_from") !== callsQuery.get("ts_from") ||
      failedQuery.get("ts_to") !== callsQuery.get("ts_to")
    )
      throw new Error(`${where}: the success rate does not open the failures of its window`);

    const failure = await page.getByTestId("connector-last-failure").textContent();
    const cause = de ? "Fehler im Fremdsystem" : "Error in the external system";
    if (!failure?.includes(cause))
      throw new Error(`${where}: the last failure is not worded as its cause — "${failure}"`);

    // The sign-in block: one way, the fitting one — no connection picker for a
    // header key, and the replacement keeps the header's name.
    if (await page.getByTestId("connector-connection-select").count())
      throw new Error(`${where}: "Verbindung wählen" is offered for a header key`);
    await page.getByTestId("connector-key-toggle").click();
    const header = await page.getByTestId("connector-key-header").inputValue();
    if (header !== "X-API-KEY")
      throw new Error(`${where}: the key form does not keep the header name — "${header}"`);
    await assertNoVisibleUuids(page.locator("main").first(), where);
    await assertNoSidewaysScroll(page, where);
    await assertSingleTriggers(page, where);
    await capture("connector-mcp");

    // ── "Werkzeuge": the session, and one decision per tool ─────────────────
    await openTab(page, "werkzeuge");
    const session = (await text(page, "connector-mcp-session")) ?? "";
    if (!session.includes(RUNTIME.mcp_session.protocol_version))
      throw new Error(`${where}: the negotiated session is not said — "${session}"`);
    if (await page.getByTestId("connector-mcp-note").count())
      throw new Error(`${where}: a permanent note explains the "Ohne Rückfrage" choice`);
    // Before reading the server: the stored trust shows, the rest does not.
    const stored = (await text(page, "connector-mcp-tool-row-0")) ?? "";
    if (!stored.includes("search_items") || !stored.includes(de ? "Ohne Rückfrage" : "without asking"))
      throw new Error(`${where}: the stored "Ohne Rückfrage" tool does not show as such`);
    await page.getByTestId("connector-mcp-reload").click();
    await page
      .getByTestId("connector-mcp-tool-row-1")
      .waitFor({ state: "attached", timeout: 10_000 });
    let second = page.getByTestId("connector-mcp-tool-row-1");
    if (!(await second.isVisible())) second = page.getByTestId("connector-mcp-tool-mobile-row-1");
    const secondText = await second.innerText();
    if (
      !secondText.includes("create_ticket") ||
      !secondText.includes(de ? "meldet: schreibt" : "reports: writes")
    )
      throw new Error(
        `${where}: the tool list does not show what the server claims — "${secondText}"`,
      );
    let secondLink = page.getByTestId("connector-mcp-tool-row-link-1");
    if (!(await secondLink.isVisible()))
      secondLink = page.getByTestId("connector-mcp-tool-mobile-row-link-1");
    await secondLink.click();
    await page.getByTestId("connector-mcp-tool-1-trusted").click();
    for (let attempt = 0; attempt < 40 && state.sent.length === 0; attempt += 1)
      await page.waitForTimeout(50);
    if (state.sent.at(-1)?.tool !== "create_ticket" || state.sent.at(-1)?.confirm !== false)
      throw new Error(`${where}: "Ohne Rückfrage" sent ${JSON.stringify(state.sent.at(-1))}`);
    await page.getByTestId("connector-mcp-tool-1-close").click();
    await page.getByTestId("connector-mcp-tool-1-sheet").waitFor({ state: "hidden" });
    await assertNoSidewaysScroll(page, where);
    await assertSingleTriggers(page, `${where} · tools`);
    await capture("connector-mcp-tools");

    // ── A connector nobody called ─────────────────────────────────────────────
    variant = "zero";
    await openConnection(MCP_ID);
    await page.getByTestId("connector-runtime-unused").waitFor({ timeout: 10_000 });
    if (await page.getByTestId("connector-figure-calls-link").count())
      throw new Error(`${where} · zero: a counted zero opens a list`);
    // The empty state says so. Testing the connection is the page's own action
    // beside the title, and stands there only.
    if (await page.getByTestId("connector-runtime-unused").locator("a, button").count())
      throw new Error(`${where} · zero: the empty state repeats "Verbindung testen"`);
    if (!(await page.getByTestId("connector-menu").isVisible()))
      throw new Error(`${where} · zero: the connection cannot be tested from the page`);
    // A week without a call is one sentence, not four figures of placeholders.
    if (await page.getByTestId("connector-figure-calls").count())
      throw new Error(`${where} · zero: placeholder figures stand beside the sentence`);
    await page.waitForLoadState("networkidle");
    await assertSingleTriggers(page, `${where} · zero`);
    await capture("connector-zero");

    // ── A runtime read that fails ─────────────────────────────────────────────
    variant = "failed";
    await stand.visit(page, `connectors/${MCP_ID}?tab=verbindung`);
    await unfold(page, "connector-runtime-section");
    await page.getByTestId("connector-runtime-failed").waitFor({ timeout: 10_000 });
    if (!(await page.getByTestId("connector-runtime-failed-retry").isVisible()))
      throw new Error(`${where} · failed: the failure offers no retry`);
    if (await page.getByTestId("connector-figure-calls").count())
      throw new Error(`${where} · failed: figures stand beside the failure`);
    await capture("connector-failed");

    // ── A reader without stats:read ───────────────────────────────────────────
    variant = null;
    await withBootstrap(page, "stats:read", async () => {
      await openConnection(MCP_ID);
      await page.getByTestId("connector-runtime-not-permitted").waitFor({ timeout: 10_000 });
      // One sentence for what the reader may not see — no figure, no zero, no link.
      for (const id of [
        "connector-figure-calls",
        "connector-figure-success",
        "connector-figure-median",
        "connector-figure-calls-link",
      ])
        if (await page.getByTestId(id).count())
          throw new Error(`${where} · no permission: "${id}" stands for a figure it may not read`);
      // What it may read is still said: the newest successful call.
      if (!(await page.getByTestId("connector-last-success").count()))
        throw new Error(`${where} · no permission: the last successful call is gone too`);
      await capture("connector-no-permission");
    });

    // ── A postgres connector ──────────────────────────────────────────────────
    await openConnection(PG_ID);
    if (await page.getByTestId("connector-tabs-tab-werkzeuge").count())
      throw new Error("/connectors/<postgres>: server tools on a database connector");
    const kind = await page.getByTestId("connector-fact-kind").textContent();
    if (!kind?.includes(de ? "PostgreSQL-Datenbank" : "PostgreSQL database"))
      throw new Error(`/connectors/<postgres>: the kind reads "${kind}"`);
    const dsn = (await page.getByTestId("connector-fact-address").textContent()) ?? "";
    if (!dsn.includes("reader:•••@db.example.org:5432/lager") || dsn.includes("redacted"))
      throw new Error(`/connectors/<postgres>: a kept secret reads as a literal: "${dsn}"`);
    if (!(await page.getByTestId("connector-fact-address-help").count()))
      throw new Error("/connectors/<postgres>: nothing says the secret is kept");
    if (await page.getByTestId("connector-copy-address").count())
      throw new Error(
        "/connectors/<postgres>: an address with a kept secret is offered for copying",
      );
    // It signs in with nothing: the connection says so, once. No sign-in
    // block, no second and third wording of the same absence.
    if (await page.getByTestId("connector-credentials").count())
      throw new Error("/connectors/<postgres>: a sign-in block for a connector that needs none");
    const pgBody = await page.getByTestId("detail-connectors").innerText();
    for (const repeat of de
      ? ["Ohne Zugangsdaten", "Noch keine Zugangsdaten"]
      : ["No credentials needed", "No credentials stored"])
      if (pgBody.includes(repeat))
        throw new Error(`/connectors/<postgres>: "${repeat}" repeats that it needs no sign-in`);
    if (pgBody.split(de ? "Ohne Anmeldung" : "No sign-in").length - 1 !== 1)
      throw new Error("/connectors/<postgres>: that it needs no sign-in does not stand once");
    // Nothing failed: no "last failure" placeholder.
    if (await page.getByTestId("connector-last-failure").count())
      throw new Error('/connectors/<postgres>: "last failure" with no failure');
    await assertNoSidewaysScroll(page, "/connectors/<postgres>");
    await assertSingleTriggers(page, `${where} · postgres`);
    await capture("connector-postgres");

    await verifyConnectorSignIn(page, stand, state.oauth, de, capture);
  } finally {
    await page.unroute(isConnectorApi, handler);
  }
}
