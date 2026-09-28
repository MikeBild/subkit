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

// Personen & Rechte is one page; its sections are tabs whose content is the
// section's own list.
const PAGES = [
  { route: "people", marker: "admin-people", tabs: ["people", "roles", "groups", "grants"] },
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
    assertNoRawValues(await mainText(page, marker), `/${route}`, locale);
    for (const tab of tabs ?? []) {
      await page.getByTestId(`people-tab-${tab}`).click();
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
  await stand.visit(page, "people?section=grants");
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
  const href = await pressure.getAttribute("href");
  if (href !== "/cockpit/settings?leaf=tokens.monthly_budget")
    throw new Error(`/usage: the budget badge leads to ${href}, not the budget setting`);
  // Visited through the stand, so the frame below is of a page that named itself.
  await stand.visit(page, "settings?leaf=tokens.monthly_budget");
  await page.getByTestId("settings-list").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const active = document.activeElement;
    const field = active?.closest('[data-testid^="setting-item-"]');
    return Boolean(field?.textContent?.includes("tokens.monthly_budget"));
  });
  // Opening the leaf moved the whole page sideways: the settings column was as
  // wide as the tab strip's every tab side by side, the page's scroll region
  // clipped it, and scrolling to the field shifted the region left — the
  // first tab and the first status icon cut off with no way back. The page
  // scrolls vertically only; the strip scrolls inside itself.
  const drift = await page.evaluate(() => {
    const main = document.querySelector('[data-testid="admin-settings"]');
    const region = main?.querySelector('[data-family-slot="scroll-region"]');
    const content = main?.querySelector('[data-family-slot="content"]');
    const heading = main?.querySelector("h1");
    const strip = main?.querySelector('[data-testid="settings-categories"]');
    const tab = strip?.querySelector('[role="tab"][data-state="active"]');
    if (!region || !content || !heading || !strip || !tab) return { missing: true };
    const stripBox = strip.getBoundingClientRect();
    const tabBox = tab.getBoundingClientRect();
    return {
      missing: false,
      documentScrollLeft: document.documentElement.scrollLeft,
      regionScrollLeft: region.scrollLeft,
      regionOverflow: region.scrollWidth - region.clientWidth,
      contentLeft: Math.round(content.getBoundingClientRect().left),
      headingLeft: Math.round(heading.getBoundingClientRect().left),
      tabInStrip: tabBox.left >= stripBox.left - 1 && tabBox.right <= stripBox.right + 1,
    };
  });
  if (drift.missing) throw new Error("/settings: the leaf deep link's page parts are missing");
  if (drift.documentScrollLeft !== 0 || drift.regionScrollLeft !== 0)
    throw new Error(
      `/settings?leaf=: the page is scrolled sideways (document ${drift.documentScrollLeft}px, region ${drift.regionScrollLeft}px)`,
    );
  if (drift.regionOverflow > 0)
    throw new Error(
      `/settings?leaf=: the page is ${drift.regionOverflow}px wider than its frame — something only the tab strip may be is not contained`,
    );
  if (Math.abs(drift.contentLeft - drift.headingLeft) > 1)
    throw new Error(
      `/settings?leaf=: the content starts at ${drift.contentLeft}px, its heading at ${drift.headingLeft}px`,
    );
  if (!drift.tabInStrip)
    throw new Error("/settings?leaf=: the setting's tab is outside the visible part of its strip");
  if (!(await page.getByTestId("settings-pending-restart").isVisible()))
    throw new Error("/settings: a pending restart does not say which settings wait for it");
  await capture("settings-budget-leaf");
}
