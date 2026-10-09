const EXPIRED = { code: "unauthorized", message: "missing_or_invalid_credentials" };

export async function verifySessionExpiry(page, stand, workflowId, localeName) {
  await stand.visit(page, `workflows/${workflowId}`);
  await page.getByTestId("cockpit-shell").waitFor();
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
    await page.evaluate(() => {
      window.history.pushState(window.history.state, "", "/cockpit/connectors");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    const signIn = page.getByTestId("session-expired-sign-in");
    await signIn.waitFor({ state: "visible", timeout: 10_000 });
    const title = localeName === "de" ? "Deine Sitzung ist abgelaufen" : "Your session has expired";
    await page.getByRole("heading", { name: title, exact: true }).waitFor();
    if (landed || new URL(page.url()).pathname !== "/cockpit/connectors")
      throw new Error("an expired session navigated away before the reader chose to sign in");
    const destination = new URL(await signIn.getAttribute("href"), page.url());
    if (
      destination.origin !== new URL(page.url()).origin ||
      destination.pathname !== "/v1/identity/cockpit-login" ||
      destination.searchParams.get("return_to") !== "/cockpit/connectors"
    )
      throw new Error("the expired-session action does not preserve a same-origin return path");
    await signIn.click();
    await page.waitForURL("**/v1/identity/cockpit-login**", { timeout: 10_000 });
    if (!landed) throw new Error("the explicit sign-in action did not request the login page");
    const returnTo = landed.searchParams.get("return_to");
    if (returnTo !== "/cockpit/connectors")
      throw new Error(`signing in again returns to ${returnTo}, not to /cockpit/connectors`);
  } finally {
    await page.unroute(engine, expired);
    await page.unroute("**/v1/identity/cockpit-login**", login);
  }
}
