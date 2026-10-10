import {
  assertNoTooltipWithoutHover,
  assertTabOpensTooltip,
  assertTapTogglesHelp,
} from "./cockpit-unprompted-tooltip.mjs";

const PAGES = [
  { route: "people", marker: "admin-people", tabs: ["people", "roles", "groups", "grants"] },
  { route: "settings?tab=notifications", marker: "admin-notifications" },
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

  await stand.visit(page, "people");
  await page.getByTestId("people-list").waitFor({ state: "visible" });
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
  const permissions = page.getByTestId("people-sheet-permissions-section");
  const memberWord = locale === "de" ? "Mitglied" : "Member";
  await permissions.filter({ hasText: memberWord }).first().waitFor({ state: "visible" });
  if ((await permissions.innerText()).includes("in deinem Namen"))
    throw new Error("/people: the permissions still read the old on-behalf label");
  await capture("role-change");
  await page.getByTestId("people-sheet-close").click();
  await sheet.waitFor({ state: "hidden" });

  await stand.visit(page, "people?section=grants");
  await page.getByTestId("grants-list").waitFor({ state: "visible" });
  await page.getByTestId("grants-list-row-link-0").click();
  await page.getByTestId("grant-revoke").click();
  const revokeConfirm = page.getByTestId("grant-revoke-confirm");
  await revokeConfirm.waitFor({ state: "visible" });
  await capture("grant-revoke");
  await page.getByTestId("grant-revoke-confirm-cancel").click();
  await revokeConfirm.waitFor({ state: "hidden" });
  await page.getByTestId("grant-sheet-close").click();
  await page.getByTestId("grant-create").click();
  const grantDialog = page.getByTestId("grant-create-dialog");
  await grantDialog.waitFor({ state: "visible" });
  const fields = await grantDialog.locator('[data-slot="field-label"]').allInnerTexts();
  const asked = fields.map((field) => field.trim()).filter(Boolean);
  const expected = locale === "de" ? ["Wer", "Workflow", "Recht"] : ["Who", "Workflow", "Right"];
  if (JSON.stringify(asked) !== JSON.stringify(expected))
    throw new Error(`/people?section=grants: the grant dialog asks ${JSON.stringify(asked)}`);
  await capture("grant-create");
  await page.getByTestId("grant-create-dialog-cancel").click();
  await grantDialog.waitFor({ state: "hidden" });

  await stand.visit(page, "usage");
  const pressure = page.getByTestId("usage-pressure-critical");
  await pressure.waitFor({ state: "visible" });
  const href = await pressure.getAttribute("href");
  if (href !== "/cockpit/settings?leaf=tokens.monthly_budget")
    throw new Error(`/usage: the budget badge leads to ${href}, not the budget setting`);
  await stand.visit(page, "settings?leaf=tokens.monthly_budget");
  await page.getByTestId("settings-list").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const active = document.activeElement;
    const field = active?.closest('[data-testid^="setting-item-"]');
    return field?.getAttribute("data-setting-path") === "tokens.monthly_budget";
  });
  const drift = await page.evaluate(() => ({
    sectionCurrent:
      document
        .querySelector('[data-testid="settings-section-link-tokens"]')
        ?.getAttribute("aria-current") === "page",
    rowHighlighted:
      document.activeElement
        ?.closest('[data-testid^="setting-item-"]')
        ?.getAttribute("data-highlighted") === "true",
  }));
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
  await stand.visit(page, "settings?leaf=auth.providers");
  await page
    .locator('[data-testid^="setting-item-"][data-highlighted="true"]')
    .waitFor({ state: "visible" });
  await assertNoTooltipWithoutHover(page, "/settings?leaf=auth.providers");
  if (await page.evaluate(() => document.activeElement?.matches("[data-tooltip-trigger]")))
    throw new Error("/settings?leaf=auth.providers: the deep link lands on a (?), not the field");
  await stand.visit(page, "settings?section=server");
  await page.getByTestId("settings-section-server").waitFor({ state: "visible" });
  await assertTabOpensTooltip(page, "/settings?section=server", '[data-testid="settings-panel"]');
  await assertTapTogglesHelp(page, "/settings?section=server", '[data-testid="settings-panel"]');
  await verifySettingRows(page, settings.settingRows, "server", "/settings?section=server");
}

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
      text: main?.innerText ?? "",
      rowText: items.map((item) => item.innerText ?? "").join(" "),
      rows: items.map((item) => ({
        path: item.getAttribute("data-setting-path"),
        appliesTo: item.getAttribute("data-applies-to") === "true",
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
  if (/Gilt für|Applies to/.test(shape.rowText))
    throw new Error(`${where}: "Gilt für" stands on a row instead of behind its (?)`);
  const scoped = shown.find((row) => row.appliesTo);
  if (!scoped) return;
  await page
    .locator(`[data-setting-path="${scoped.path}"] [data-testid^="setting-help-"]`)
    .first()
    .hover();
  const tip = page.locator('[data-slot="tooltip-content"]').first();
  await tip.waitFor({ state: "visible", timeout: 5_000 });
  if (!/Gilt für|Applies to/.test(await tip.innerText()))
    throw new Error(`${where}: ${scoped.path}'s (?) does not say what it applies to`);
  await page.locator('[data-testid="admin-settings"] h1').first().hover();
  await page.mouse.move(0, 0, { steps: 8 });
  await tip.waitFor({ state: "hidden", timeout: 5_000 });
}
