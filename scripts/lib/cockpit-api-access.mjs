// Zugangsdaten against the installation production actually had.
//
// A deploy verifier registered an OAuth client on every run and never came
// back: ~500 registrations nobody holds a grant for, against four real
// applications. Listed flat, the real applications drowned, and
// Kontoverbindungen — where the OAuth callback and the old `/connections`
// address land — sat below the wall, out of reach. The deep link scrolled on
// mount, while the lists were skeletons, and what loaded above the heading
// pushed it out of view again.
//
// The fixture (verify-cockpit-visual.mjs) holds 200 dead, 31 retired or
// revoked and 3 real registrations, and 40 revoked keys among 5 live ones.
// This asserts: the real applications lead, the dead ones are one collapsed
// line with their count and are not even mounted, the live keys lead with
// the revoked ones collapsed, the sections stand in the order a reader acts
// on them, and the redirect from `/connections` ends with Kontoverbindungen
// in view once every list has arrived.

const cards = (page, pattern) =>
  page.evaluate(
    (source) =>
      [...document.querySelectorAll("[data-testid]")]
        .filter((element) => new RegExp(source).test(element.getAttribute("data-testid") ?? ""))
        .map((element) => (element instanceof HTMLElement ? element.innerText : "")),
    pattern.source,
  );

/** Runs in the page: the Kontoverbindungen heading lies inside the scroll region's frame. */
function grantsHeadingInView() {
  const heading = document.getElementById("api-access-grants-title");
  const region = heading?.closest('[data-family-slot="scroll-region"]');
  if (!heading || !region) return false;
  const box = heading.getBoundingClientRect();
  const frame = region.getBoundingClientRect();
  return box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1;
}

async function toggleText(page, testId) {
  return (await page.getByTestId(`${testId}-toggle`).innerText()).trim();
}

export async function verifyApiAccess(page, stand, locale, fixture) {
  const where = `/api-access (${locale})`;
  await stand.visit(page, "api-access");
  await page.getByTestId("connected-clients-list").waitFor({ state: "visible" });
  await page.getByTestId("api-keys-list").waitFor({ state: "visible" });

  // The real applications lead, and only they are listed.
  const clients = await cards(page, /^connected-client-\d+$/);
  if (clients.length !== fixture.realClients.length)
    throw new Error(
      `${where}: ${clients.length} applications listed openly, expected the ${fixture.realClients.length} with a valid grant`,
    );
  for (const name of fixture.realClients)
    if (!clients.some((text) => text.includes(name)))
      throw new Error(`${where}: the real application "${name}" is not among the first rows`);

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

  // Keys: live first, revoked collapsed with their count.
  const keys = await cards(page, /^api-key-item-\d+$/);
  if (keys.length !== fixture.activeKeys)
    throw new Error(
      `${where}: ${keys.length} keys listed openly, expected ${fixture.activeKeys} live ones`,
    );
  if (keys.some((text) => /widerrufen|revoked/i.test(text)))
    throw new Error(`${where}: a revoked key stands among the live ones`);
  const revoked = await toggleText(page, "api-keys-revoked");
  if (!revoked.includes(`(${fixture.revokedKeys})`))
    throw new Error(`${where}: the revoked keys do not say how many — "${revoked}"`);
  if ((await cards(page, /^api-key-item-r\d+$/)).length > 0)
    throw new Error(`${where}: revoked keys are rendered before they are asked for`);

  // The index counts what a click on it shows, not the collapsed rows.
  const index = await page.getByTestId("api-access-index").innerText();
  for (const [section, count] of [
    ["clients", fixture.realClients.length],
    ["keys", fixture.activeKeys],
  ]) {
    const text = await page.getByTestId(`api-access-index-${section}`).innerText();
    if (!new RegExp(`(^|\\D)${count}(\\D|$)`).test(text))
      throw new Error(`${where}: the index says "${text}" for ${section}, expected ${count}`);
  }
  if (!index) throw new Error(`${where}: no section index`);

  // Order: attention list, Kontoverbindungen, keys, applications.
  const order = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="api-access-section-"]')].map((element) =>
      element.getAttribute("data-testid"),
    ),
  );
  const expected = ["grants", "keys", "clients"].map((section) => `api-access-section-${section}`);
  if (JSON.stringify(order) !== JSON.stringify(expected))
    throw new Error(`${where}: sections stand as ${order.join(", ")}`);

  // The old address lands on Kontoverbindungen, and it is in view once every
  // list has arrived — not scrolled to while they were skeletons.
  await stand.visit(page, "connections?failed=denied&name=Postfach");
  await page.getByTestId("connected-clients-list").waitFor({ state: "visible" });
  await page.getByTestId("api-keys-list").waitFor({ state: "visible" });
  await page.waitForFunction(grantsHeadingInView, null, { timeout: 5_000 });
  // Still there a moment later: nothing that arrives afterwards pushes it out.
  await page.waitForTimeout(500);
  if (!(await page.evaluate(grantsHeadingInView)))
    throw new Error(
      `/connections → /api-access (${locale}): Kontoverbindungen left the view after loading`,
    );
}
