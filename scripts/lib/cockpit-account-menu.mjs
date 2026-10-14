function require(condition, message) {
  if (!condition) throw new Error(message);
}

async function openSubmenu(page, trigger, content) {
  await page.getByTestId(trigger).click();
  await page.getByTestId(content).waitFor({ state: "visible" });
}

export async function verifyAccountMenuKeep(page) {
  const trigger = page.getByTestId("account-menu-trigger");
  const name = page.getByTestId("account-name");
  const role = page.getByTestId("account-role");
  require((await name.innerText()).trim() === "operator@example.com", "account button lost email");
  require((await role.innerText()).trim() === "Administrator", "account button lost role");

  await trigger.click();
  const menu = page.getByTestId("account-menu");
  await menu.waitFor({ state: "visible" });
  require((await page.getByTestId("account-summary").innerText()).includes(
    "Default Tenant",
  ), "account summary lost tenant");
  for (const id of [
    "account-release-notes",
    "account-profile-menu",
    "account-language-menu",
    "account-theme-menu",
    "account-sign-out",
  ])
    require((await page.getByTestId(id).count()) === 1, `account menu item ${id} missing`);

  await openSubmenu(page, "account-profile-menu", "account-profile-content");
  const profile = await page.getByTestId("account-profile-content").innerText();
  for (const value of ["operator@example.com", "Administrator", "Default Tenant", "Engine-Version"])
    require(profile.includes(value), `profile submenu missing ${value}`);

  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await trigger.click();
  await openSubmenu(page, "account-language-menu", "account-language-content");
  for (const [id, value] of [
    ["auto", "Automatisch"],
    ["en", "Englisch"],
    ["de", "Deutsch"],
  ])
    require((await page.getByTestId(`account-language-${id}`).count()) ===
      1, `language submenu missing ${value}`);

  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "hidden" });
  await trigger.click();
  await openSubmenu(page, "account-theme-menu", "account-theme-content");
  for (const value of ["system", "light", "dark"])
    require((await page.getByTestId(`account-theme-${value}`).count()) ===
      1, `appearance submenu missing ${value}`);
}
