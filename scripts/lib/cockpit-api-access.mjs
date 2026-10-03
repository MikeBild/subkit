// API-Zugang against the installation production actually had.
//
// A deploy verifier registered an OAuth client on every run and never came
// back: ~500 registrations nobody holds a grant for, against four real
// applications. Listed flat, the real applications drowned, and the section
// below them sat out of reach. The sections are tabs now, each at its own
// address (`?section=clients|keys|grants`), the pattern of Personen & Rechte:
// tabs on a wide screen, a select on a phone.
//
// The fixture (verify-cockpit-visual.mjs) holds 200 dead, 31 retired or
// revoked and 3 real registrations, and 40 revoked keys among 5 live ones.
// This asserts: the tabs carry the names that say when one needs them, in
// order, and only a count someone acts on; a phone gets the select; the real
// applications lead, the dead ones are one collapsed line with their count
// and are not even mounted; the live keys lead with the revoked ones
// collapsed; no command line and no token endpoint stand on any tab; and a
// connector sign-in that comes back to the connectors list says its result.

const TAB_NAMES = {
  de: ["Apps mit Zugriff auf SubKit", "Schlüssel für Skripte", "Zugriff in deinem Namen"],
  en: ["Apps with access to SubKit", "Keys for scripts", "Access on your behalf"],
};
const RETIRED_NAMES = {
  de: ["Kontoverbindung", "Verbundene Anwendungen"],
  en: ["Account connections", "Connected applications"],
};
const GRANTS_BADGE = { de: (n) => `${n} erneuern`, en: (n) => `${n} to renew` };

const cards = (page, pattern) =>
  page.evaluate(
    (source) =>
      [...document.querySelectorAll("[data-testid]")]
        .filter((element) => new RegExp(source).test(element.getAttribute("data-testid") ?? ""))
        .map((element) => (element instanceof HTMLElement ? element.innerText : "")),
    pattern.source,
  );

async function toggleText(page, testId) {
  return (await page.getByTestId(`${testId}-toggle`).innerText()).trim();
}

/** Opens one tab by its address and waits for its list. */
async function openTab(page, stand, section, ready) {
  await stand.visit(page, `api-access?section=${section}`);
  await page.getByTestId(ready).first().waitFor({ state: "visible" });
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
  const phone = (page.viewportSize()?.width ?? 1280) < 640;

  // ── The tabs ─────────────────────────────────────────────────────────────
  await openTab(page, stand, "clients", "connected-clients-list");
  const shape = await page.evaluate(() => {
    const visible = (element) =>
      element instanceof HTMLElement && element.getBoundingClientRect().width > 0;
    const list = document.querySelector('[data-testid="api-access-tab-list"]');
    const select = document.querySelector('[data-testid="api-access-mobile-section"]');
    return {
      index: document.querySelectorAll('[data-testid="api-access-index"]').length,
      tabs: [...document.querySelectorAll('[data-testid^="api-access-tab-"][role="tab"]')].map(
        (tab) => tab.querySelector("[data-tab-label]")?.textContent?.trim() ?? "",
      ),
      badges: Object.fromEntries(
        ["clients", "keys", "grants"].map((section) => [
          section,
          document
            .querySelector(`[data-testid="api-access-tab-badge-${section}"]`)
            ?.textContent?.trim() ?? null,
        ]),
      ),
      tabListVisible: visible(list),
      selectVisible: visible(select),
    };
  });
  if (shape.index > 0) throw new Error(`${where}: an index of anchors stands instead of tabs`);
  if (shape.tabs.join("|") !== TAB_NAMES[locale].join("|"))
    throw new Error(`${where}: the tabs are "${shape.tabs.join(", ")}"`);
  // Phone: the select, not a tab strip squeezed into 390px; wide: the tabs.
  if (phone && (!shape.selectVisible || shape.tabListVisible))
    throw new Error(`${where}: a phone shows the tab strip instead of the section select`);
  if (!phone && (shape.selectVisible || !shape.tabListVisible))
    throw new Error(`${where}: a wide screen shows the select instead of the tabs`);
  // Only a count someone acts on. The fixture's keys are all fine; its
  // grants hold one expiring, one expired and one unreadable.
  if (shape.badges.clients !== null || shape.badges.keys !== null)
    throw new Error(`${where}: a tab counts what needs nobody — ${JSON.stringify(shape.badges)}`);
  if (shape.badges.grants !== GRANTS_BADGE[locale](fixture.grantsToRenew))
    throw new Error(`${where}: the grants tab says "${shape.badges.grants}"`);

  // ── Apps with access to SubKit ───────────────────────────────────────────
  let text = await assertNoCommandLine(page, `${where} · clients`);
  for (const retired of RETIRED_NAMES[locale])
    if (text.includes(retired)) throw new Error(`${where}: the retired name "${retired}" stands`);
  // The real applications lead, and only they are listed.
  const clients = await cards(page, /^connected-client-\d+$/);
  if (clients.length !== fixture.realClients.length)
    throw new Error(
      `${where}: ${clients.length} applications listed openly, expected the ${fixture.realClients.length} with a valid grant`,
    );
  for (const name of fixture.realClients)
    if (!clients.some((row) => row.includes(name)))
      throw new Error(`${where}: the real application "${name}" is not among the first rows`);
  // The total stands inside the section, not on the tab.
  const clientsTotal = await page.getByTestId("api-access-total-clients").innerText();
  if (!clientsTotal.includes(String(fixture.realClients.length)))
    throw new Error(`${where}: the apps' total says "${clientsTotal}"`);

  // The dead ones: one line with their count, rows not mounted.
  const ungranted = await toggleText(page, "connected-clients-ungranted");
  if (!ungranted.includes(`(${fixture.deadClients})`))
    throw new Error(`${where}: the collapsed registrations do not say how many — "${ungranted}"`);
  if ((await cards(page, /^connected-client-u\d+$/)).length > 0)
    throw new Error(
      `${where}: registrations without a grant are rendered before they are asked for`,
    );
  const disabled = await toggleText(page, "connected-clients-disabled");
  if (!disabled.includes(`(${fixture.disabledClients})`))
    throw new Error(`${where}: retired and revoked registrations are not counted — "${disabled}"`);
  if ((await cards(page, /^connected-client-d\d+$/)).length > 0)
    throw new Error(`${where}: retired registrations are listed by default`);

  // Opening the group shows exactly what its count promised.
  await page.getByTestId("connected-clients-ungranted-toggle").click();
  const opened = await cards(page, /^connected-client-u\d+$/);
  if (opened.length !== fixture.deadClients)
    throw new Error(
      `${where}: the opened group shows ${opened.length}, its count said ${fixture.deadClients}`,
    );
  await page.getByTestId("connected-clients-ungranted-toggle").click();

  // ── Keys for scripts ─────────────────────────────────────────────────────
  await openTab(page, stand, "keys", "api-keys-list");
  text = await assertNoCommandLine(page, `${where} · keys`);
  for (const retired of RETIRED_NAMES[locale])
    if (text.includes(retired)) throw new Error(`${where}: the retired name "${retired}" stands`);
  // Keys: live first, revoked collapsed with their count.
  const keys = await cards(page, /^api-key-item-\d+$/);
  if (keys.length !== fixture.activeKeys)
    throw new Error(
      `${where}: ${keys.length} keys listed openly, expected ${fixture.activeKeys} live ones`,
    );
  if (keys.some((row) => /widerrufen|revoked/i.test(row)))
    throw new Error(`${where}: a revoked key stands among the live ones`);
  const revoked = await toggleText(page, "api-keys-revoked");
  if (!revoked.includes(`(${fixture.revokedKeys})`))
    throw new Error(`${where}: the revoked keys do not say how many — "${revoked}"`);
  if ((await cards(page, /^api-key-item-r\d+$/)).length > 0)
    throw new Error(`${where}: revoked keys are rendered before they are asked for`);
  const keysTotal = await page.getByTestId("api-access-total-keys").innerText();
  if (!keysTotal.includes(String(fixture.activeKeys)))
    throw new Error(`${where}: the keys' total says "${keysTotal}"`);
  // The developer's way to a short-lived token: one link to the guide.
  const guide = await page.getByTestId("api-access-token-exchange-link").getAttribute("href");
  if (guide !== "/llms/developers/token-exchange.md")
    throw new Error(`${where}: the developer link leads to "${guide}"`);

  // No task list on this page: the tasks it used to repeat live on Übersicht.
  const taskLists = await page
    .locator('[data-testid="api-access-attention"], [data-testid="attention-list"]')
    .count();
  if (taskLists > 0) throw new Error(`${where}: a second task list stands above the sections`);

  // ── Access on your behalf ────────────────────────────────────────────────
  await openTab(page, stand, "grants", "connections-list");
  text = await assertNoCommandLine(page, `${where} · grants`);
  for (const retired of RETIRED_NAMES[locale])
    if (text.includes(retired)) throw new Error(`${where}: the retired name "${retired}" stands`);

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
