// API-Zugang against the installation production actually had.
//
// A deploy verifier registered an OAuth client on every run and never came
// back: ~500 registrations nobody holds a grant for, against four real
// applications. Listed flat, the real applications drowned. The sections are
// tabs (`?section=keys|clients`, keys first), each list a table. What SubKit
// holds on another system's side lives on that connector's page.
//
// The fixture (verify-cockpit-visual.mjs) holds 200 dead, 31 retired or
// revoked and 3 real registrations, and 40 revoked keys among 5 live ones.
// This asserts: the tabs carry their names in order and only a count someone
// acts on; the real applications lead, the dead ones are one collapsed line
// with their count and are not even mounted; the live keys lead with the
// revoked ones collapsed; no command line and no token endpoint stand on any
// tab; and a connector sign-in that comes back to the connectors list says
// its result.

const TAB_NAMES = {
  de: ["Schlüssel", "Apps"],
  en: ["Keys", "Apps"],
};
const RETIRED_NAMES = {
  de: ["Kontoverbindung", "Verbundene Anwendungen"],
  en: ["Account connections", "Connected applications"],
};

/** The rows of one table that are on screen: the desktop rows or the phone cards. */
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

/** Opens one tab by its address and waits for its table to settle. */
async function openTab(page, stand, section, table) {
  await stand.visit(page, `api-access?section=${section}`);
  await page
    .locator(`[data-testid="${table}"][data-family-state="ready"]`)
    .waitFor({ state: "attached" });
}

/** No command line and no token endpoint, whatever the tab — rendered or merely mounted. */
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

  // ── The tabs ─────────────────────────────────────────────────────────────
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
  // Only a count someone acts on. The fixture's keys are all fine.
  if (shape.counts.clients !== null || shape.counts.keys !== null)
    throw new Error(`${where}: a tab counts what needs nobody — ${JSON.stringify(shape.counts)}`);

  // ── Apps ─────────────────────────────────────────────────────────────────
  let text = await assertNoCommandLine(page, `${where} · clients`);
  for (const retired of RETIRED_NAMES[locale])
    if (text.includes(retired)) throw new Error(`${where}: the retired name "${retired}" stands`);
  // The real applications lead, and only they are listed.
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

  // The dead ones: one line with their count, rows not mounted.
  const ungranted = await toggleText(page, "connected-clients-ungranted");
  if (!ungranted.includes(`(${fixture.deadClients})`))
    throw new Error(`${where}: the collapsed registrations do not say how many — "${ungranted}"`);
  if ((await page.locator('[data-testid="connected-clients-ungranted-list"]').count()) > 0)
    throw new Error(
      `${where}: registrations without a grant are rendered before they are asked for`,
    );
  const disabled = await toggleText(page, "connected-clients-disabled");
  if (!disabled.includes(`(${fixture.disabledClients})`))
    throw new Error(`${where}: retired and revoked registrations are not counted — "${disabled}"`);
  if ((await page.locator('[data-testid="connected-clients-disabled-list"]').count()) > 0)
    throw new Error(`${where}: retired registrations are listed by default`);

  // Opening the group shows exactly what its count promised.
  await page.getByTestId("connected-clients-ungranted-toggle").click();
  const opened = await rows(page, "connected-clients-ungranted-list");
  if (opened.length !== fixture.deadClients)
    throw new Error(
      `${where}: the opened group shows ${opened.length}, its count said ${fixture.deadClients}`,
    );
  await page.getByTestId("connected-clients-ungranted-toggle").click();

  // ── Keys ─────────────────────────────────────────────────────────────────
  await openTab(page, stand, "keys", "api-keys");
  text = await assertNoCommandLine(page, `${where} · keys`);
  for (const retired of RETIRED_NAMES[locale])
    if (text.includes(retired)) throw new Error(`${where}: the retired name "${retired}" stands`);
  // Keys: live first, revoked collapsed with their count.
  const keys = await rows(page, "api-keys");
  if (keys.length !== fixture.activeKeys)
    throw new Error(
      `${where}: ${keys.length} keys listed openly, expected ${fixture.activeKeys} live ones`,
    );
  if (keys.some((row) => /widerrufen|revoked/i.test(row)))
    throw new Error(`${where}: a revoked key stands among the live ones`);
  const revoked = await toggleText(page, "api-keys-revoked");
  if (!revoked.includes(`(${fixture.revokedKeys})`))
    throw new Error(`${where}: the revoked keys do not say how many — "${revoked}"`);
  if ((await page.locator('[data-testid="api-keys-revoked-list"]').count()) > 0)
    throw new Error(`${where}: revoked keys are rendered before they are asked for`);
  const keysTotal = await page.getByTestId("api-access-total-keys").innerText();
  if (!keysTotal.includes(String(fixture.activeKeys)))
    throw new Error(`${where}: the keys' total says "${keysTotal}"`);

  // No task list on this page: the tasks it used to repeat live on Übersicht.
  const taskLists = await page
    .locator('[data-testid="api-access-attention"], [data-testid="attention-list"]')
    .count();
  if (taskLists > 0) throw new Error(`${where}: a second task list stands above the sections`);

  // A sign-in comes back to the connectors list with its result in the query;
  // the list says it once, with the name it carried.
  await stand.visit(page, "connectors?failed=denied&name=Postfach");
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Postfach" });
  try {
    await toast.first().waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    throw new Error(`/connectors?failed=… (${locale}): the callback sentence lost its name`);
  }
  if (new URL(page.url()).searchParams.has("failed"))
    throw new Error(`/connectors?failed=… (${locale}): the callback's words stay in the address`);
}
