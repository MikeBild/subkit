// The installation pages against hostile fixtures.
//
// The main sweep's fixtures carry a custom role, the engine's whole permission
// catalogue, a setting waiting for a restart, a suspended and a paused
// notification channel, a usage cap at 95 % and audit rows by a person, a
// system account and the engine. Each of those used to reach the screen as
// "Unbekannt", as `*` or `sk_cli`, or as an act that happened on one click.
// This asserts the words, the J5 journey from the red budget badge to the
// focused budget field, that a role change shows its consequence before it is
// saved, and that a confirmation stands between the click and a revoked grant.

// Personen & Rechte is one page; its sections are tabs whose content is the
// section's own list.
const PAGES = [
  { route: "people", marker: "admin-people", tabs: ["people", "roles", "groups", "grants"] },
  { route: "settings?tab=benachrichtigungen", marker: "admin-notifications" },
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

  // A custom role is named by its name, and a role change shows what it does
  // before it is saved: the person's sheet names the person and the change,
  // and "Speichern" appears only once another role is picked.
  await stand.visit(page, "people");
  await page.getByTestId("people-list").waitFor({ state: "visible" });
  // The table draws a row and, for narrow screens, a card; the row is the one shown here.
  const roleCell = page.getByTestId("people-list-row-1").getByTestId("people-role-badge-1");
  if ((await roleCell.innerText()).trim() !== "Revision")
    throw new Error("/people: a custom role is not named by its own name");
  await page.getByTestId("people-list-row-link-1").click();
  const sheet = page.getByTestId("people-sheet");
  await sheet.waitFor({ state: "visible" });
  if (await page.getByTestId("people-role-save").isVisible())
    throw new Error("/people: the person's sheet offers to save before anything changed");
  await page.getByTestId("people-role").click();
  await page.getByTestId("people-role-member").click();
  const roleChange = page.getByTestId("people-role-change");
  await roleChange.waitFor({ state: "visible" });
  if (!(await roleChange.innerText()).includes("reviewer@example.com"))
    throw new Error("/people: the role change does not name the person");
  await page.getByTestId("people-role-save").waitFor({ state: "visible" });
  await capture("role-change");
  await page.getByTestId("people-sheet-close").click();
  await sheet.waitFor({ state: "hidden" });

  // A grant is revoked only after its consequence was read.
  await stand.visit(page, "people?section=grants");
  await page.getByTestId("grants-list").waitFor({ state: "visible" });
  await page.getByTestId("grants-list-row-link-0").click();
  await page.getByTestId("grant-revoke").click();
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
  // The row names its setting by address, not by text: the key is no longer
  // written on the row (it was, inside a closed "Technische Angaben").
  await page.waitForFunction(() => {
    const active = document.activeElement;
    const field = active?.closest('[data-testid^="setting-item-"]');
    return field?.getAttribute("data-setting-path") === "tokens.monthly_budget";
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
    // The title row's leading edge: on a wide screen the sidebar toggle
    // stands before the heading, and the content aligns to the row, not to
    // the heading's text.
    const h1 = main?.querySelector("h1");
    const heading =
      h1?.parentElement?.querySelector('[data-testid="sidebar-trigger"]') ?? h1 ?? null;
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
  await verifySettingRows(
    page,
    settings.settingRows,
    "tokens",
    "/settings?leaf=tokens.monthly_budget",
  );
  await capture("settings-budget-leaf");
  // The budget's section is all tenant-scoped; the server's is all global —
  // the rows that must NOT say "Gilt für".
  await stand.visit(page, "settings?section=server");
  await page.getByTestId("settings-section-server").waitFor({ state: "visible" });
  await verifySettingRows(page, settings.settingRows, "server", "/settings?section=server");

  await verifySettingsSections(page, stand, settings, capture);
}

// A setting's row: no "Technische Angaben" disclosure — counted in the DOM,
// since a closed <details> keeps its content in the markup and out of
// innerText — no engine English anywhere in the page's text, "Gilt für" exactly
// on the rows that can differ per workspace, a copy icon for the key (the
// fixture reader may change settings), and one answer — behind the summary
// line's (?) — on how a change is stored.
async function verifySettingRows(page, rows, section, where) {
  const shape = await page.evaluate(() => {
    const main = document.querySelector('[data-testid="admin-settings"]');
    const items = [...(main?.querySelectorAll('[data-testid^="setting-item-"]') ?? [])];
    return {
      disclosures: items.reduce(
        (sum, item) =>
          sum + item.querySelectorAll('details, [data-testid^="setting-technical-"]').length,
        0,
      ),
      text: main?.textContent ?? "",
      rows: items.map((item) => ({
        path: item.getAttribute("data-setting-path"),
        appliesTo: Boolean(item.querySelector('[data-testid^="setting-applies-to-"]')),
        copy: Boolean(item.querySelector('[data-testid^="setting-copy-key-"]')),
      })),
      storage: main?.querySelectorAll('[data-testid="settings-summary-help"]').length ?? 0,
    };
  });
  if (shape.disclosures > 0)
    throw new Error(`${where}: ${shape.disclosures} rows still carry a technical disclosure`);
  if (shape.storage !== 1)
    throw new Error(`${where}: "Wie wird gespeichert?" stands ${shape.storage} times`);
  const shown = shape.rows.filter((row) => row.path?.startsWith(`${section}.`));
  if (shown.length === 0) throw new Error(`${where}: no row of the ${section} section is shown`);
  for (const row of shown) {
    const expected = rows.find((candidate) => candidate.path === row.path);
    if (!expected) throw new Error(`${where}: a row names ${row.path}, not in the fixture`);
    if (row.appliesTo !== (expected.scope === "tenant" || expected.source === "tenant"))
      throw new Error(
        `${where}: ${row.path} (${expected.scope}) ${row.appliesTo ? "says" : "does not say"} "Gilt für"`,
      );
    if (!row.copy) throw new Error(`${where}: ${row.path} has no way to copy its key`);
    if (expected.description && shape.text.includes(expected.description))
      throw new Error(`${where}: ${row.path} shows the engine's English description`);
  }
}

// The settings sections were a tab strip of twenty, twice as wide as the page
// and scrolled sideways to find one. Every section is now a link in a grouped
// list beside the form, and at each wide width every one of them stands fully
// inside the list and the viewport — none behind a horizontal scroll. A narrow
// page puts a select of the sections above the form instead. The fixture
// carries every section the engine has, so the count is the real installation's.
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
      await page.getByTestId("settings-panel").waitFor({ state: "visible" });
      if (!(await page.getByTestId("settings-section-list").isVisible())) {
        // Narrow: the sections are a select above the form, never a strip.
        if (!(await page.getByTestId("settings-section-picker").isVisible()))
          throw new Error(`${where}: neither the section list nor its select is shown`);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        if (overflow > 0)
          throw new Error(`${where}: the page is ${overflow}px wider than the viewport`);
        await capture(`settings-sections-${size.width}`);
        continue;
      }
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
          tablists: list.querySelectorAll('[role="tablist"], [role="tab"]').length,
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
    }
  } finally {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
  }
}
