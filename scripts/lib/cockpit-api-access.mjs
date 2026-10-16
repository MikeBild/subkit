import { translate } from "../../apps/cockpit/src/lib/i18n.ts";
import { REVIEWER_ID, uuid } from "./cockpit-journey-fixtures.mjs";
import { closeRecordSheet } from "./cockpit-record-sheet.mjs";

const TAB_NAMES = {
  de: ["Schlüssel", "Verbundene Clients"],
  en: ["Keys", "Connected clients"],
};
const RETIRED_NAMES = {
  de: ["Kontoverbindung", "Verbundene Anwendungen"],
  en: ["Account connections", "Connected applications"],
};
const API_KEYS_ROUTE = /\/v1\/identity\/api-keys(?:\?.*)?$/;

const rows = (page, table) =>
  page.evaluate(
    (id) =>
      [...document.querySelectorAll("[data-testid]")]
        .filter((element) =>
          new RegExp(`^${id}-(mobile-)?row-\\d+$`).test(element.getAttribute("data-testid") ?? ""),
        )
        .filter(
          (element) => element instanceof HTMLElement && element.getBoundingClientRect().width > 0,
        )
        .map((element) => (element instanceof HTMLElement ? element.innerText : "")),
    table,
  );

async function toggleText(page, testId) {
  return (await page.getByTestId(`${testId}-toggle`).innerText()).trim();
}

async function openTab(page, stand, section, table) {
  await stand.visit(page, `api-access?section=${section}`);
  await page
    .locator(`[data-testid="${table}"][data-family-state="ready"]`)
    .waitFor({ state: "attached" });
}

async function assertNoCommandLine(page, where) {
  const text = await page.evaluate(() => {
    const main = document.querySelector('[data-testid="admin-api-access"]');
    return `${document.body.innerText}\n${main?.textContent ?? ""}`;
  });
  if (/\bcurl\b/.test(text)) throw new Error(`${where}: a curl command is on the page`);
  if (text.includes("/v1/oauth/token"))
    throw new Error(`${where}: the token endpoint is on the page`);
  return text;
}

export async function verifyApiAccess(page, stand, locale, fixture) {
  const where = `/api-access (${locale})`;

  await openTab(page, stand, "clients", "connected-clients");
  const shape = await page.evaluate(() => {
    const tabs = [...document.querySelectorAll('[data-testid^="api-access-tab-"][role="tab"]')];
    return {
      tabs: tabs.map((tab) => tab.firstChild?.textContent?.trim() ?? ""),
      counts: Object.fromEntries(
        tabs.map((tab) => [
          tab.getAttribute("data-testid")?.replace("api-access-tab-", ""),
          tab.querySelector("span")?.textContent?.trim() ?? null,
        ]),
      ),
      tabListVisible:
        (document.querySelector('[data-testid="api-access-tabs-list"]')?.getBoundingClientRect()
          .width ?? 0) > 0,
    };
  });
  if (shape.tabs.join("|") !== TAB_NAMES[locale].join("|"))
    throw new Error(`${where}: the tabs are "${shape.tabs.join(", ")}"`);
  if (!shape.tabListVisible) throw new Error(`${where}: the tab bar is not on screen`);
  if (shape.counts.clients !== null || shape.counts.keys !== "1")
    throw new Error(
      `${where}: the tabs should show one action-needed key only — ${JSON.stringify(shape.counts)}`,
    );

  const appTable = page.getByTestId("connected-clients-desktop");
  const appHeaders = (await appTable.locator("thead th").allInnerTexts())
    .map((header) => header.trim())
    .filter(Boolean);
  const expectedAppHeaders = [
    "Name",
    locale === "de" ? "Verbunden von" : "Connected by",
    locale === "de" ? "Zuletzt aktiv" : "Last active",
  ];
  if (
    appHeaders.slice(0, expectedAppHeaders.length).join("|") !== expectedAppHeaders.join("|") ||
    appHeaders.some((header) => ["Status", "Freigegeben von", "Erstellt"].includes(header))
  )
    throw new Error(`${where}: app columns are "${appHeaders.join(" | ")}"`);

  let text = await assertNoCommandLine(page, `${where} · clients`);
  for (const retired of RETIRED_NAMES[locale])
    if (text.includes(retired)) throw new Error(`${where}: the retired name "${retired}" stands`);
  const clients = await rows(page, "connected-clients");
  if (clients.length !== fixture.realClients.length)
    throw new Error(
      `${where}: ${clients.length} applications listed openly, expected the ${fixture.realClients.length} with a valid grant`,
    );
  for (const name of fixture.realClients)
    if (!clients.some((row) => row.includes(name)))
      throw new Error(`${where}: the real application "${name}" is not among the first rows`);
  const clientsTotal = await page.getByTestId("api-access-total-clients").innerText();
  if (!clientsTotal.includes(String(fixture.realClients.length)))
    throw new Error(`${where}: the apps' total says "${clientsTotal}"`);

  const connectedClientName = fixture.realClients.at(-1);
  const connectedClientLink = page
    .locator(
      '[data-testid^="connected-clients-row-link-"], [data-testid^="connected-clients-mobile-row-link-"]',
    )
    .filter({ hasText: connectedClientName })
    .filter({ visible: true })
    .first();
  await connectedClientLink.click();
  const connectedClientSheet = page.getByTestId("connected-client-sheet");
  await connectedClientSheet.waitFor({ state: "visible" });
  if ((await connectedClientSheet.getAttribute("data-presentation")) !== "docked")
    throw new Error(`${where}: the connected-client record sheet is not docked`);
  const connectedClientFacts = connectedClientSheet.getByTestId("connected-client-sheet-facts");
  await connectedClientFacts.waitFor({ state: "visible" });
  if ((await connectedClientFacts.getAttribute("data-shape")) !== "box")
    throw new Error(`${where}: connected-client history is not presented as a FactList`);
  const historyFacts = connectedClientFacts.locator(":scope > div");
  if ((await historyFacts.count()) !== 2)
    throw new Error(
      `${where}: connected-client history does not separate the known grant and legacy entry`,
    );
  const recordedAt = "2026-08-04T08:30:00.000Z";
  const recordedDate = await page.evaluate(
    ({ locale, value }) =>
      new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value)),
    { locale, value: recordedAt },
  );
  const connectedClientRow = appTable
    .locator('tbody tr[data-family-collection-row="true"]')
    .filter({ hasText: connectedClientName });
  if ((await connectedClientRow.count()) !== 1)
    throw new Error(`${where}: expected exactly one visible row for "${connectedClientName}"`);
  const connectedByCell = await connectedClientRow.locator(":scope > td").nth(1).innerText();
  if (!connectedByCell.includes("Evidence Approver 3"))
    throw new Error(`${where}: the "${expectedAppHeaders[1]}" cell omits its recorded person`);
  if (connectedByCell.includes("operator@example.com"))
    throw new Error(`${where}: the "${expectedAppHeaders[1]}" cell substitutes approved_by`);
  const unknownLabel =
    locale === "de"
      ? "Historische Verbindung · Person unbekannt"
      : "Historical connection · person unknown";
  if (!connectedByCell.includes(unknownLabel))
    throw new Error(`${where}: the "${expectedAppHeaders[1]}" cell hides unknown legacy history`);
  if (!(await connectedClientRow.locator(":scope > td").nth(2).innerText()).includes(recordedDate))
    throw new Error(`${where}: the "${expectedAppHeaders[2]}" cell is not "${recordedDate}"`);
  const knownHistory = (await historyFacts.nth(0).innerText()).replace(/\s+/g, " ");
  for (const expected of [
    locale === "de" ? "Verbunden von" : "Connected by",
    "Evidence Approver 3",
    locale === "de" ? "Verbunden am" : "Connected on",
    recordedDate,
  ])
    if (!knownHistory.includes(expected))
      throw new Error(`${where}: recorded connection history omits "${expected}"`);
  if (knownHistory.includes("operator@example.com"))
    throw new Error(`${where}: legacy approved_by is presented as the connected person`);
  const unknownHistory = (await historyFacts.nth(1).innerText()).replace(/\s+/g, " ");
  if (!unknownHistory.includes(unknownLabel))
    throw new Error(`${where}: legacy history does not stay explicitly unattributed`);
  if (unknownHistory.includes("Verbunden am") || unknownHistory.includes("Connected on"))
    throw new Error(`${where}: unknown legacy history claims a connection date`);
  await closeRecordSheet(connectedClientSheet);

  const ungranted = await toggleText(page, "connected-clients-ungranted");
  if (!new RegExp(`(^|\\s)${fixture.deadClients}(\\s|$)`).test(ungranted))
    throw new Error(`${where}: the collapsed registrations do not say how many — "${ungranted}"`);
  if ((await page.locator('[data-testid="connected-clients-ungranted-list"]').count()) > 0)
    throw new Error(
      `${where}: registrations without a grant are rendered before they are asked for`,
    );
  const disabled = await toggleText(page, "connected-clients-disabled");
  if (!new RegExp(`(^|\\s)${fixture.disabledClients}(\\s|$)`).test(disabled))
    throw new Error(`${where}: retired and revoked registrations are not counted — "${disabled}"`);
  if ((await page.locator('[data-testid="connected-clients-disabled-list"]').count()) > 0)
    throw new Error(`${where}: retired registrations are listed by default`);

  await page.getByTestId("connected-clients-ungranted-toggle").click();
  const opened = await rows(page, "connected-clients-ungranted-list");
  if (opened.length !== fixture.deadClients)
    throw new Error(
      `${where}: the opened group shows ${opened.length}, its count said ${fixture.deadClients}`,
    );
  await page.getByTestId("connected-clients-ungranted-toggle").click();

  const ownerId = uuid;
  const creatorId = REVIEWER_ID;
  await openTab(page, stand, "keys", "api-keys");
  text = await assertNoCommandLine(page, `${where} · keys`);
  for (const retired of RETIRED_NAMES[locale])
    if (text.includes(retired)) throw new Error(`${where}: the retired name "${retired}" stands`);
  const keys = await rows(page, "api-keys");
  if (keys.length !== fixture.activeKeys)
    throw new Error(
      `${where}: ${keys.length} keys listed openly, expected ${fixture.activeKeys} live ones`,
    );
  if (keys.some((row) => /widerrufen|revoked/i.test(row)))
    throw new Error(`${where}: a revoked key stands among the live ones`);
  const revoked = await toggleText(page, "api-keys-revoked");
  if (!new RegExp(`(^|\\s)${fixture.revokedKeys}(\\s|$)`).test(revoked))
    throw new Error(`${where}: the revoked keys do not say how many — "${revoked}"`);
  if ((await page.locator('[data-testid="api-keys-revoked-list"]').count()) > 0)
    throw new Error(`${where}: revoked keys are rendered before they are asked for`);
  const keysTotal = await page.getByTestId("api-access-total-keys").innerText();
  if (!keysTotal.includes(String(fixture.activeKeys)))
    throw new Error(`${where}: the keys' total says "${keysTotal}"`);

  const scopeLabels =
    locale === "de"
      ? { read: "Lesen", run: "Ausführen", manage: "Verwalten" }
      : { read: "Read", run: "Run", manage: "Manage" };
  const expectedReadScopes = [
    "conversation:read",
    "workflow:read",
    "schedule:read",
    "execution:read",
    "connector:read",
    "connection:read",
    "knowledge:read",
    "skill:read",
    "file:read",
    "notification:read",
    "audit:read",
    "stats:read",
    "stats:read:all",
    "identity:read",
    "rbac:read",
    "api_key:read",
    "mcp_oauth_client:read",
    "settings:read",
    "self_healing:read",
  ];
  const forbiddenReadScopes = [
    "workflow:run",
    "workflow:write",
    "workflow:delete",
    "connector:write",
    "connector:test",
    "api_key:revoke",
    "*",
  ];
  let createdKeyRequest = null;
  const createKeyRoute = async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    createdKeyRequest = route.request().postDataJSON();
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        plaintext_key: "wf_live_v11_3_fixture_secret",
        name: "V11-3 Read Scope",
      }),
    });
  };
  await page.route(API_KEYS_ROUTE, createKeyRoute);
  try {
    await page.getByTestId("api-key-create").click();
    const createDialog = page.getByTestId("api-key-create-dialog");
    await createDialog.waitFor({ state: "visible" });
    const scopeGroup = createDialog.getByTestId("api-key-create-scopes");
    for (const label of Object.values(scopeLabels))
      if (!(await scopeGroup.getByRole("radio", { name: label, exact: true }).isVisible()))
        throw new Error(`${where}: the scope preset "${label}" is not visible`);
    if (
      (await scopeGroup
        .getByRole("radio", { name: scopeLabels.run, exact: true })
        .getAttribute("aria-checked")) !== "true"
    )
      throw new Error(`${where}: the default scope preset is not "${scopeLabels.run}"`);

    const scopeSummary = createDialog.getByTestId("api-key-preset-permissions");
    const defaultScopes = await scopeSummary.innerText();
    const runScopeLabel =
      locale === "de" ? "Workflows · Ausführen · schreibt" : "Workflows · Run · writes";
    if (!defaultScopes.includes(runScopeLabel))
      throw new Error(`${where}: the default preset omits its workflow-run scope`);
    const intakeWriteScopeLabel =
      locale === "de"
        ? "Gesammelte Einträge · Bearbeiten · schreibt"
        : "Collected items · Edit · writes";
    if (defaultScopes.includes(intakeWriteScopeLabel))
      throw new Error(`${where}: the default preset includes ungranted intake-write scope`);

    await scopeGroup.getByRole("radio", { name: scopeLabels.read, exact: true }).click();
    if (
      (await scopeGroup
        .getByRole("radio", { name: scopeLabels.read, exact: true })
        .getAttribute("aria-checked")) !== "true"
    )
      throw new Error(`${where}: the read scope preset was not selected`);
    const readSummary = await scopeSummary.innerText();
    const expectedVisibleReadScopes =
      locale === "de"
        ? ["Workflows · Anzeigen · liest", "Konnektoren · Anzeigen · liest"]
        : ["Workflows · View · reads", "Connectors · View · reads"];
    for (const expected of expectedVisibleReadScopes)
      if (!readSummary.includes(expected))
        throw new Error(`${where}: the read preset summary omits "${expected}"`);
    if (readSummary.includes(runScopeLabel))
      throw new Error(`${where}: the read preset still displays the workflow-run scope`);

    await createDialog.getByTestId("api-key-create-name").fill("  V11-3 Read Scope  ");
    await createDialog.getByTestId("api-key-create-dialog-submit").click();
    const issuedDialog = page.getByTestId("secret-dialog");
    await issuedDialog.waitFor({ state: "visible" });
    const issuedName = "V11-3 Read Scope";
    const expectedTitle = translate(locale, "apiKeys.createdNamed", { name: issuedName });
    if (
      (await issuedDialog.getByTestId("secret-dialog-title").innerText()).trim() !== expectedTitle
    )
      throw new Error(`${where}: the one-time key dialog title is not "${expectedTitle}"`);
    if (!createdKeyRequest) throw new Error(`${where}: key creation did not submit its request`);
    const expectedRequest = {
      owner_kind: "user",
      owner_id: "018f4b4a-6d33-7b3a-9c2d-123456789abc",
      name: "V11-3 Read Scope",
      scopes: expectedReadScopes,
    };
    if (JSON.stringify(createdKeyRequest) !== JSON.stringify(expectedRequest))
      throw new Error(
        `${where}: key creation payload differs from the selected read preset — ${JSON.stringify(createdKeyRequest)}`,
      );
    if (forbiddenReadScopes.some((scope) => createdKeyRequest.scopes.includes(scope)))
      throw new Error(`${where}: the read preset includes a forbidden write/manage scope`);
    await issuedDialog.getByTestId("secret-dialog-submit").click();
    await issuedDialog.waitFor({ state: "hidden" });
  } finally {
    await page.unroute(API_KEYS_ROUTE, createKeyRoute);
    for (const testId of ["secret-dialog", "api-key-create-dialog"]) {
      const dialog = page.getByTestId(testId);
      if (await dialog.isVisible()) {
        await dialog.getByTestId(`${testId}-cancel`).click();
        await dialog.waitFor({ state: "hidden" });
      }
    }
  }

  await page
    .locator('[data-testid="api-keys-row-link-0"], [data-testid="api-keys-mobile-row-link-0"]')
    .filter({ visible: true })
    .first()
    .click();
  const sheet = page.getByTestId("api-key-sheet");
  await sheet.waitFor({ state: "visible" });
  if (!(await sheet.getByTestId("api-key-sheet-prefix").count()))
    throw new Error(`${where}: a key's sheet does not say how the key starts`);
  if (!(await sheet.getByTestId("api-key-sheet-menu").count()))
    throw new Error(`${where}: a live key's sheet offers no way to rotate or revoke it`);
  const keyFacts = sheet.getByTestId("api-key-sheet-facts");
  const ownerFact = keyFacts
    .getByText(translate(locale, "apiKeys.owner"), { exact: true })
    .locator("xpath=..");
  const creatorFact = keyFacts
    .getByText(translate(locale, "apiKeys.creator"), { exact: true })
    .locator("xpath=..");
  const ownerName = (await ownerFact.locator("dd").innerText()).trim();
  const creatorName = (await creatorFact.locator("dd").innerText()).trim();
  if (ownerName !== "operator@example.com")
    throw new Error(`${where}: API-key owner is "${ownerName}" instead of its fixture identity`);
  if (creatorName !== "reviewer@example.com")
    throw new Error(
      `${where}: API-key creator is "${creatorName}" instead of its fixture identity`,
    );
  if (ownerName === creatorName)
    throw new Error(`${where}: API-key owner and creator identities are not distinct`);
  const keyFactsText = await keyFacts.innerText();
  if (keyFactsText.includes(ownerId) || keyFactsText.includes(creatorId))
    throw new Error(`${where}: API-key facts expose a raw owner or creator identifier`);
  await closeRecordSheet(sheet);

  let rotationRequest = null;
  const rotationRoute = async (route) => {
    rotationRequest = {
      method: route.request().method(),
      pathname: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    };
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        old: {
          id: "018f4b4a-6d33-7b3a-9c2d-123456789abc",
          name: "Cockpit verification",
          prefix: "wf_live_demo",
          rotating_out_at: "2026-10-12T00:00:00.000Z",
        },
        new: {
          plaintext_key: "wf_live_v11_5_rotated_fixture_secret",
          name: "Cockpit verification",
        },
      }),
    });
  };
  await page.route("**/v1/identity/api-keys/*/rotate", rotationRoute);
  try {
    const keyRowLink = page
      .locator('[data-testid^="api-keys-row-link-"], [data-testid^="api-keys-mobile-row-link-"]')
      .filter({ hasText: "Cockpit verification" })
      .filter({ visible: true })
      .first();
    await keyRowLink.click();
    await page.getByTestId("api-key-sheet-menu").click();
    await page.getByTestId("api-key-sheet-rotate").click();
    const rotateDialog = page.getByTestId("api-key-rotate-dialog");
    await rotateDialog.waitFor({ state: "visible" });
    const expectedConsequence = translate(locale, "apiKeys.rotateConsequenceHours", { hours: 24 });
    const actualConsequence = (
      await rotateDialog.getByTestId("api-key-rotate-dialog-consequence").innerText()
    ).trim();
    if (actualConsequence !== expectedConsequence)
      throw new Error(`${where}: the 24-hour rotation consequence is "${actualConsequence}"`);
    await rotateDialog.getByTestId("api-key-rotate-dialog-confirm").click();
    const rotatedDialog = page.getByTestId("secret-dialog");
    await rotatedDialog.waitFor({ state: "visible" });
    const expectedRotationRequest = {
      method: "POST",
      pathname: "/v1/identity/api-keys/018f4b4a-6d33-7b3a-9c2d-123456789abc/rotate",
      body: { overlap_minutes: 1440 },
    };
    if (JSON.stringify(rotationRequest) !== JSON.stringify(expectedRotationRequest))
      throw new Error(
        `${where}: rotation request differs from the confirmed 24-hour rotation — ${JSON.stringify(rotationRequest)}`,
      );
    await rotatedDialog.getByTestId("secret-dialog-submit").click();
    await rotatedDialog.waitFor({ state: "hidden" });
  } finally {
    await page.unroute("**/v1/identity/api-keys/*/rotate", rotationRoute);
    for (const testId of ["secret-dialog", "api-key-rotate-dialog"]) {
      const dialog = page.getByTestId(testId);
      if (await dialog.isVisible()) {
        await dialog.getByTestId(`${testId}-cancel`).click();
        await dialog.waitFor({ state: "hidden" });
      }
    }
  }

  const taskLists = await page
    .locator('[data-testid="api-access-attention"], [data-testid="attention-list"]')
    .count();
  if (taskLists > 0) throw new Error(`${where}: a second task list stands above the sections`);
}
