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

export async function verifyInstallationPages(page, stand, locale, capture, settings) {
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
  // Opening the leaf once moved the whole page sideways: the settings column
  // was as wide as a tab strip holding every section side by side, the page's
  // scroll region clipped it, and scrolling to the field shifted the region
  // left. There is no strip any more; the page scrolls vertically only, the
  // leaf's section is the open one and its row is marked.
  const drift = await page.evaluate(() => {
    const main = document.querySelector('[data-testid="admin-settings"]');
    const region = main?.querySelector('[data-family-slot="scroll-region"]');
    const content = main?.querySelector('[data-family-slot="content"]');
    const heading = main?.querySelector("h1");
    const link = main?.querySelector('[data-testid="settings-section-link-tokens"]');
    const row = document.activeElement?.closest('[data-testid^="setting-item-"]');
    if (!region || !content || !heading || !link || !row) return { missing: true };
    return {
      missing: false,
      documentScrollLeft: document.documentElement.scrollLeft,
      regionScrollLeft: region.scrollLeft,
      regionOverflow: region.scrollWidth - region.clientWidth,
      contentLeft: Math.round(content.getBoundingClientRect().left),
      headingLeft: Math.round(heading.getBoundingClientRect().left),
      sectionCurrent: link.getAttribute("aria-current") === "page",
      rowHighlighted: row.getAttribute("data-highlighted") === "true",
    };
  });
  if (drift.missing) throw new Error("/settings: the leaf deep link's page parts are missing");
  if (drift.documentScrollLeft !== 0 || drift.regionScrollLeft !== 0)
    throw new Error(
      `/settings?leaf=: the page is scrolled sideways (document ${drift.documentScrollLeft}px, region ${drift.regionScrollLeft}px)`,
    );
  if (drift.regionOverflow > 0)
    throw new Error(`/settings?leaf=: the page is ${drift.regionOverflow}px wider than its frame`);
  if (Math.abs(drift.contentLeft - drift.headingLeft) > 1)
    throw new Error(
      `/settings?leaf=: the content starts at ${drift.contentLeft}px, its heading at ${drift.headingLeft}px`,
    );
  if (!drift.sectionCurrent)
    throw new Error("/settings?leaf=: the setting's section is not the open one in the list");
  if (!drift.rowHighlighted)
    throw new Error("/settings?leaf=: the linked setting's row is not marked");
  if (!(await page.getByTestId("settings-pending-restart").isVisible()))
    throw new Error("/settings: a pending restart does not say which settings wait for it");
  await capture("settings-budget-leaf");

  await verifySettingsSections(page, stand, settings, capture);
}

// The settings sections were a tab strip of twenty, twice as wide as the page
// and scrolled sideways to find one. Every section is now a link in a grouped
// list, and at each of these widths every one of them stands fully inside the
// list and the viewport — none behind a horizontal scroll. The fixture carries
// every section the engine has, so the count is the real installation's.
const SETTINGS_WIDTHS = [
  { width: 1280, height: 800 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
];

async function verifySettingsSections(page, stand, { settingsSections, viewport }, capture) {
  try {
    for (const size of SETTINGS_WIDTHS) {
      const where = `/settings at ${size.width}px`;
      await page.setViewportSize(size);
      await stand.visit(page, "settings");
      await page.getByTestId("settings-section-list").waitFor({ state: "visible" });
      const shape = await page.evaluate(() => {
        const main = document.querySelector('[data-testid="admin-settings"]');
        const list = main?.querySelector('[data-testid="settings-section-list"]');
        const region = main?.querySelector('[data-family-slot="scroll-region"]');
        if (!main || !list || !region) return { missing: true };
        const box = list.getBoundingClientRect();
        const links = [...list.querySelectorAll('a[data-testid^="settings-section-link-"]')];
        const inside = links.filter((link) => {
          const rect = link.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.left >= box.left - 1 &&
            rect.right <= box.right + 1 &&
            rect.left >= -1 &&
            rect.right <= window.innerWidth + 1
          );
        });
        return {
          missing: false,
          tablists: main.querySelectorAll('[role="tablist"], [role="tab"]').length,
          listOverflow: list.scrollWidth - list.clientWidth,
          documentOverflow:
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
          regionOverflow: region.scrollWidth - region.clientWidth,
          links: links.length,
          inside: inside.length,
        };
      });
      if (shape.missing) throw new Error(`${where}: the section list is missing`);
      if (shape.tablists > 0)
        throw new Error(`${where}: the sections are tabs (${shape.tablists} tab roles)`);
      if (shape.listOverflow > 0)
        throw new Error(`${where}: the section list scrolls sideways by ${shape.listOverflow}px`);
      if (shape.documentOverflow > 0 || shape.regionOverflow > 0)
        throw new Error(
          `${where}: the page is wider than the viewport (document ${shape.documentOverflow}px, region ${shape.regionOverflow}px)`,
        );
      if (shape.inside !== settingsSections)
        throw new Error(
          `${where}: ${shape.inside} of ${settingsSections} sections stand fully inside the list (${shape.links} links)`,
        );
      await capture(`settings-sections-${size.width}`);
      // Narrow: the list is the start view, a section opens in its place and
      // "Alle Bereiche" leads back to the whole list.
      if (size.width < 720) {
        await page.getByTestId("settings-section-link-tokens").click();
        await page.getByTestId("settings-section-tokens").waitFor({ state: "visible" });
        if (await page.getByTestId("settings-section-list").isVisible())
          throw new Error(`${where}: an opened section shares the screen with the list`);
        await page.getByTestId("settings-back").click();
        await page.getByTestId("settings-section-list").waitFor({ state: "visible" });
      }
    }
  } finally {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
  }
}
