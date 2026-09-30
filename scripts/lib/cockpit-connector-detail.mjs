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
// leads to "Verbindung testen"), a runtime read that fails (a failure with a
// retry, not an empty page), a reader without `stats:read` ("Keine
// Berechtigung", not a zero), and a postgres connector (no server tools, no
// MCP words).

import { assertNoVisibleUuids } from "./cockpit-visible-uuids.mjs";

const MCP_ID = "018f4b4a-6d33-7b3a-9c2d-1234567890c1";
const PG_ID = "018f4b4a-6d33-7b3a-9c2d-1234567890c2";
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
  base_url: null,
  config: {},
  self_description: undefined,
};

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
    if (path === `/v1/connectors/${MCP_ID}/credential`)
      return json(route, {
        mode: "header",
        environment: "prod",
        connection: null,
        header_names: ["X-API-KEY"],
        updated_at: iso(4),
      });
    if (path === `/v1/connectors/${PG_ID}/credential`) return json(route, null);
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
    path === "/v1/stats/connectors" ||
    path === "/v1/workflows"
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

export async function verifyConnectorDetail(page, stand, localeName, capture) {
  const de = localeName === "de";
  const state = { trusted: ["search_items"], sent: [] };
  let variant = null;
  const handler = (route) => connectorApi(state, variant)(route);
  await page.route(isConnectorApi, handler);
  const where = `/connectors/<mcp> (${localeName})`;
  try {
    // ── The MCP connector, answered in full ──────────────────────────────────
    await stand.visit(page, `connectors/${MCP_ID}`);
    await page.getByTestId("connector-runtime").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("connector-figure-calls-link").waitFor({ timeout: 10_000 });

    const order = await page.evaluate(() =>
      [
        "connector-connection-facts",
        "connector-runtime",
        "connector-mcp-tools",
        "connector-credentials",
        "connector-workflows",
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

    const address = await text(page, "connector-fact-address");
    if (!address?.includes(ADDRESS)) throw new Error(`${where}: the address is not shown whole`);
    const facts = {
      kind: de ? "MCP-Server" : "MCP server",
      transport: "Streamable HTTP",
      "sign-in": de ? "Schlüssel im Header X-API-KEY" : "Key in the header X-API-KEY",
      environment: de ? "Produktion" : "Production",
    };
    for (const [fact, expected] of Object.entries(facts)) {
      const shown = await text(page, `connector-fact-${fact}`);
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

    const failure = await text(page, "connector-last-failure");
    const cause = de ? "Fehler im Fremdsystem" : "Error in the external system";
    if (!failure?.includes(cause))
      throw new Error(`${where}: the last failure is not worded as its cause — "${failure}"`);

    // Before "Verbindung testen": the stored trust shows, the list does not.
    if (!(await page.getByTestId("connector-mcp-load-hint").isVisible()))
      throw new Error(`${where}: nothing says the tool list comes from "Verbindung testen"`);
    const stored = page.getByTestId("connector-mcp-tool-0-trust");
    if ((await stored.getAttribute("data-state")) !== "checked")
      throw new Error(`${where}: the stored "Ohne Rückfrage" tool does not show as such`);
    await capture("connector-mcp");

    await page.getByTestId("connector-test").click();
    await page.getByTestId("connector-mcp-tool-1").waitFor({ state: "visible", timeout: 10_000 });
    const second = await text(page, "connector-mcp-tool-1");
    if (
      !second?.includes("create_ticket") ||
      !second.includes(de ? "meldet: schreibt" : "reports: writes")
    )
      throw new Error(`${where}: the tool list does not show what the server claims — "${second}"`);
    await page.getByTestId("connector-mcp-tool-1-trust").click();
    for (let attempt = 0; attempt < 40 && state.sent.length === 0; attempt += 1)
      await page.waitForTimeout(50);
    if (state.sent.at(-1)?.tool !== "create_ticket" || state.sent.at(-1)?.confirm !== false)
      throw new Error(`${where}: "Ohne Rückfrage" sent ${JSON.stringify(state.sent.at(-1))}`);

    // The sign-in card: one way, the fitting one — no connection picker for a
    // header key, and the replacement keeps the header's name.
    if (await page.getByTestId("connector-connection-select").count())
      throw new Error(`${where}: "Verbindung wählen" is offered for a header key`);
    await page.getByTestId("connector-key-toggle").click();
    const header = await page.getByTestId("connector-key-header").inputValue();
    if (header !== "X-API-KEY")
      throw new Error(`${where}: the key form does not keep the header name — "${header}"`);

    // A section taller than the screen keeps its height; the page scrolls. The
    // column once squeezed the sign-in card to a sliver that hid its form.
    const clipped = await page.evaluate(() =>
      [
        "connector-connection-facts",
        "connector-runtime",
        "connector-mcp-tools",
        "connector-credentials",
        "connector-workflows",
      ].filter((id) => {
        const element = document.querySelector(`[data-testid="${id}"]`);
        return element instanceof HTMLElement && element.scrollHeight > element.clientHeight + 1;
      }),
    );
    if (clipped.length > 0)
      throw new Error(`${where}: sections are cut off — ${clipped.join(", ")}`);
    await assertNoVisibleUuids(page.locator("main").first(), where);
    await assertNoSidewaysScroll(page, where);
    await capture("connector-mcp-tools");

    // ── A connector nobody called ─────────────────────────────────────────────
    variant = "zero";
    await stand.visit(page, `connectors/${MCP_ID}`);
    await page.getByTestId("connector-runtime-unused").waitFor({ timeout: 10_000 });
    if (await page.getByTestId("connector-figure-calls-link").count())
      throw new Error(`${where} · zero: a counted zero opens a list`);
    if (!(await page.getByTestId("connector-runtime-test").isVisible()))
      throw new Error(`${where} · zero: the empty state does not lead to "Verbindung testen"`);
    await capture("connector-zero");

    // ── A runtime read that fails ─────────────────────────────────────────────
    variant = "failed";
    await stand.visit(page, `connectors/${MCP_ID}`);
    await page.getByTestId("connector-runtime-failed").waitFor({ timeout: 10_000 });
    if (!(await page.getByTestId("connector-runtime-failed-retry").isVisible()))
      throw new Error(`${where} · failed: the failure offers no retry`);
    if (await page.getByTestId("connector-figure-calls").count())
      throw new Error(`${where} · failed: figures stand beside the failure`);
    await capture("connector-failed");

    // ── A reader without stats:read ───────────────────────────────────────────
    variant = null;
    await withBootstrap(page, "stats:read", async () => {
      await stand.visit(page, `connectors/${MCP_ID}`);
      await page.getByTestId("connector-figure-calls").waitFor({ timeout: 10_000 });
      const shown = await text(page, "connector-figure-calls");
      if (!shown?.includes(de ? "Keine Berechtigung" : "No permission"))
        throw new Error(`${where} · no permission: the call figure reads "${shown}"`);
      if (await page.getByTestId("connector-figure-calls-link").count())
        throw new Error(`${where} · no permission: a figure it may not read is a link`);
      await capture("connector-no-permission");
    });

    // ── A postgres connector ──────────────────────────────────────────────────
    await stand.visit(page, `connectors/${PG_ID}`);
    await page.getByTestId("connector-runtime").waitFor({ timeout: 10_000 });
    if (await page.getByTestId("connector-mcp-tools").count())
      throw new Error("/connectors/<postgres>: server tools on a database connector");
    const kind = await text(page, "connector-fact-kind");
    if (!kind?.includes(de ? "PostgreSQL-Datenbank" : "PostgreSQL database"))
      throw new Error(`/connectors/<postgres>: the kind reads "${kind}"`);
    await assertNoSidewaysScroll(page, "/connectors/<postgres>");
    await capture("connector-postgres");
  } finally {
    await page.unroute(isConnectorApi, handler);
  }
}
