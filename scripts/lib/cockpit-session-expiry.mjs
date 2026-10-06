const EXPIRED = { code: "unauthorized", message: "missing_or_invalid_credentials" };

export async function verifySessionExpiry(page, stand, workflowId, localeName) {
  await stand.visit(page, `workflows/${workflowId}`);
  await page.getByTestId("cockpit-navigation").waitFor();
  let landed = null;
  const login = (route) => {
    landed = new URL(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>sign in</title><p>sign in</p>",
    });
  };
  const expired = (route) => route.fulfill({ status: 401, json: EXPIRED });
  const engine = /\/v1\/(?!identity\/cockpit-login)/;
  await page.route("**/v1/identity/cockpit-login**", login);
  await page.route(engine, expired);
  try {
    await page
      .locator('[data-testid="cockpit-navigation"] a[href$="/cockpit/connectors"]')
      .first()
      .click();
    await page.waitForURL("**/v1/identity/cockpit-login**", { timeout: 10_000 }).catch(() => {});
    if (!landed) {
      const failure = localeName === "de" ? "konnte nicht geladen werden" : "could not be loaded";
      const shown = await page.getByText(failure).count();
      throw new Error(
        `an expired session leaves the reader on ${page.url()}${shown > 0 ? " with a load error" : ""} instead of signing in again`,
      );
    }
    const returnTo = landed.searchParams.get("return_to");
    if (returnTo !== "/cockpit/connectors")
      throw new Error(`signing in again returns to ${returnTo}, not to /cockpit/connectors`);
  } finally {
    await page.unroute(engine, expired);
    await page.unroute("**/v1/identity/cockpit-login**", login);
  }
}
