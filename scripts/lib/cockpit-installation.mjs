// The installation pages against hostile fixtures.
//
// The main sweep's fixtures carry a custom role, the engine's whole permission
// catalogue, a setting waiting for a restart, a suspended and a paused
// notification channel, a usage cap at 95 % and audit rows by a person, a
// system account and the engine. Each of those used to reach the screen as
// "Unbekannt", as `*` or `sk_cli`, or as an act that happened on one click.
// This asserts the words, the J5 journey from the red budget badge to the
// focused budget field, and that a confirmation stands between the click and
// a role change or a revoked grant.

const PAGES = [
  { route: "people", marker: "admin-people" },
  { route: "access", marker: "admin-access", tabs: ["roles", "groups", "grants", "permissions"] },
  { route: "notifications", marker: "admin-notifications" },
  { route: "settings", marker: "admin-settings" },
  { route: "usage", marker: "resource-usage" },
  { route: "audit", marker: "resource-audit" },
];

const UNKNOWN = { de: "Unbekannt", en: "Unknown" };

async function mainText(page, marker) {
  return page.getByTestId(marker).innerText();
}

function assertNoRawValues(text, where, locale) {
  if (text.includes(UNKNOWN[locale])) throw new Error(`${where}: shows "${UNKNOWN[locale]}"`);
  if (/\bsk_cli\b/.test(text)) throw new Error(`${where}: shows the raw platform "sk_cli"`);
  if (/(^|\s)\*(\s|$)/m.test(text)) throw new Error(`${where}: shows a raw "*" pattern`);
}

export async function verifyInstallationPages(page, stand, locale, capture) {
  for (const { route, marker, tabs } of PAGES) {
    await stand.visit(page, route);
    await page.getByTestId(marker).waitFor({ state: "visible" });
    await page.waitForLoadState("networkidle");
    assertNoRawValues(await mainText(page, marker), `/${route}`, locale);
    for (const tab of tabs ?? []) {
      await page.getByTestId(`access-tab-${tab}`).click();
      await page.getByTestId(`${tab}-list`).waitFor({ state: "visible" });
      assertNoRawValues(await mainText(page, marker), `/${route} · ${tab}`, locale);
    }
  }

  // A custom role is named by its name, and a role change asks first.
  await stand.visit(page, "people");
  await page.getByTestId("people-list").waitFor({ state: "visible" });
  if ((await page.getByTestId("people-role-badge-1").innerText()).trim() !== "Revision")
    throw new Error("/people: a custom role is not named by its own name");
  await page.getByTestId("people-role-1").click();
  await page.getByTestId("people-role-1-member").click();
  const roleConfirm = page.getByTestId("people-role-confirm");
  await roleConfirm.waitFor({ state: "visible" });
  if (!(await roleConfirm.innerText()).includes("reviewer@example.com"))
    throw new Error("/people: the role-change confirmation does not name the person");
  await capture("role-change");
  await page.getByTestId("people-role-confirm-cancel").click();
  await roleConfirm.waitFor({ state: "hidden" });

  // A grant is revoked only after its consequence was read.
  await stand.visit(page, "access");
  await page.getByTestId("access-tab-grants").click();
  await page.getByTestId("grants-list").waitFor({ state: "visible" });
  await page.getByTestId("grant-revoke-0").click();
  const revokeConfirm = page.getByTestId("grant-revoke-confirm");
  await revokeConfirm.waitFor({ state: "visible" });
  await capture("grant-revoke");
  await page.getByTestId("grant-revoke-confirm-cancel").click();
  await revokeConfirm.waitFor({ state: "hidden" });

  // J5: the red budget badge on /usage opens the settings page at the budget
  // field, with the cursor in it.
  await stand.visit(page, "usage");
  const pressure = page.getByTestId("usage-pressure-critical");
  await pressure.waitFor({ state: "visible" });
  await pressure.click();
  await page.waitForURL(/\/settings\?leaf=tokens\.monthly_budget/);
  await page.getByTestId("settings-list").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const active = document.activeElement;
    const field = active?.closest('[data-testid^="setting-item-"]');
    return Boolean(field?.textContent?.includes("tokens.monthly_budget"));
  });
  if (!(await page.getByTestId("settings-pending-restart").isVisible()))
    throw new Error("/settings: a pending restart does not say which settings wait for it");
  await capture("settings-budget-leaf");
}
