export async function verifyPeopleDeactivationCopy(page, stand, mockApi) {
  await page.route("**/v1/identity/users**", async (route) => {
    if (route.request().method() === "GET") return mockApi(route);
    return route.fallback();
  });
  await stand.visit(page, "people");
  await page.getByTestId("people-list-row-link-1").filter({ visible: true }).click();
  const deactivate = page.getByTestId("people-deactivate");
  if ((await deactivate.count()) === 0) await page.getByTestId("people-sheet-menu").click();
  await deactivate.click();
  const dialog = page.getByTestId("people-deactivate-confirm");
  const consequence = await dialog.getByTestId("people-deactivate-confirm-consequence").innerText();
  for (const phrase of [
    "Die Person kann sich nicht mehr anmelden",
    "Workflows und Zeitpläne bleiben aktiv",
    "Geplante Läufe starten weiterhin automatisch",
    "wenn Freigaben und Konnektoren sie erlauben",
  ]) {
    if (!consequence.includes(phrase))
      throw new Error(`deactivation consequence misses: ${phrase}`);
  }
  await dialog.getByTestId("people-deactivate-confirm-cancel").click();
}
