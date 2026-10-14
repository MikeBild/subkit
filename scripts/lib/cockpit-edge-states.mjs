import { translate } from "../../apps/cockpit/src/lib/i18n.ts";

const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const bootstrapPath = (url) => new URL(url).pathname === "/v1/cockpit/bootstrap";

async function withBootstrap(page, answer, body) {
  await page.route(bootstrapPath, answer);
  try {
    await body();
  } finally {
    await page.unroute(bootstrapPath, answer);
  }
}

async function visibleActions(scope) {
  return scope.locator('a[href], [data-slot="button"]').filter({ visible: true }).count();
}

async function expectSingleWayOn(page, where, testId) {
  const state = page.getByTestId(testId);
  await state.waitFor({ state: "visible", timeout: 10_000 });
  const actions = await visibleActions(state);
  if (actions !== 1) throw new Error(`${where}: ${actions} actions instead of exactly one way on`);
  return state;
}

export async function verifyEdgeStates(page, stand, capture) {
  await stand.visit(page, "diese-seite-gibt-es-nicht");
  await expectSingleWayOn(page, "/<unknown route>", "not-found");
  if (!(await page.getByTestId("page-content").isVisible()))
    throw new Error("/<unknown route>: the not-found page drops the shell");
  await capture("not-found");

  const granted = await page.evaluate(async () =>
    (await fetch("/v1/cockpit/bootstrap", { credentials: "include" })).json(),
  );
  const narrowed = {
    ...granted,
    permissions: granted.permissions.filter((permission) => !permission.startsWith("audit:")),
  };
  await withBootstrap(
    page,
    (route) => json(route, narrowed),
    async () => {
      await stand.visit(page, "audit");
      const forbidden = page.getByTestId("resource-permission-alert");
      await forbidden.waitFor({ state: "visible", timeout: 10_000 });
      if ((await page.locator("h1").filter({ visible: true }).count()) !== 1)
        throw new Error("/audit forbidden: the page carries more or less than one title");
      if ((await visibleActions(forbidden)) !== 0)
        throw new Error("/audit forbidden: the forbidden state offers an action no one can take");
      const title = (await forbidden.locator('[data-slot="failure-title"]').innerText()).trim();
      if (!title) throw new Error("/audit forbidden: the forbidden state has no title");
      const language = await page.locator("html").getAttribute("lang");
      const locale = language?.startsWith("de") ? "de" : "en";
      const description = (
        await forbidden.locator('[data-slot="failure-description"]').innerText()
      ).trim();
      if (description !== translate(locale, "resource.permission.description"))
        throw new Error(
          "/audit forbidden: the state must show the localized administrator contact guidance",
        );
      await capture("forbidden-audit");
    },
  );

  await withBootstrap(
    page,
    (route) =>
      json(route, { error: { code: "internal", message: "fixture refuses the session" } }, 500),
    async () => {
      await stand.visit(page, "");
      await expectSingleWayOn(page, "/ bootstrap failure", "fatal-error");
      if (!(await page.getByTestId("session-retry").isVisible()))
        throw new Error("/ bootstrap failure: the one way on is not the retry");
      await capture("bootstrap-failed");
    },
  );
}
