export async function verifyReleaseNotes(page, stand, locale) {
  const de = locale === "de";
  await stand.visit(page, "");
  await page.getByTestId("account-menu-trigger").click();
  await page.getByTestId("account-release-notes").click();
  const dialog = page.getByTestId("release-notes");
  await dialog.waitFor();
  const title = page.getByRole("heading", { name: de ? "Änderungen" : "Changes" });
  await title.waitFor();
  const firstSection = dialog.locator("section").first();
  await firstSection.waitFor();
  const heading = (await firstSection.getByRole("heading").innerText()).trim();
  const unpublished = de ? "Noch nicht veröffentlicht" : "Not published yet";
  if (heading !== unpublished && !/^v\d+\.\d+\.\d+$/.test(heading))
    throw new Error(`release notes start with an invalid entry: ${JSON.stringify(heading)}`);
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
}
