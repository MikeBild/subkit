import { mockApi } from "./cockpit-journey-fixtures.mjs";

const personas = [
  {
    name: "collection administrator",
    permissions: [
      "api_key:read",
      "api_key:write",
      "workflow:read",
      "workflow:run",
      "intake:read",
      "intake:write",
    ],
    expectedScopes: [
      "api_key:read",
      "workflow:read",
      "workflow:run",
      "intake:read",
      "intake:write",
    ],
  },
  {
    name: "restricted execution operator",
    permissions: ["api_key:read", "api_key:write", "workflow:read", "workflow:run"],
    expectedScopes: ["api_key:read", "workflow:read", "workflow:run"],
    warning: "intake:read, intake:write",
  },
  {
    name: "read-only operator",
    permissions: ["api_key:read", "workflow:read", "intake:read"],
    expectedScopes: null,
  },
];

export async function verifyApiKeyIntakePersonas(browser, stand) {
  for (const persona of personas) {
    const context = await browser.newContext({ locale: "de-DE" });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      let issuedScopes = null;
      await page.route("**/v1/**", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        if (url.pathname === "/v1/identity/api-keys" && request.method() === "POST") {
          const body = request.postDataJSON();
          issuedScopes = body.scopes;
          await route.fulfill({
            status: 201,
            contentType: "application/json",
            body: JSON.stringify({
              id: "018f4b4a-6d33-7b3a-9c2d-0000000000f1",
              owner_kind: "user",
              owner_id: "018f4b4a-6d33-7b3a-9c2d-123456789abc",
              name: body.name,
              scopes: body.scopes,
              created_at: "2026-08-10T09:00:00.000Z",
              plaintext_key: "sk_test_persona_key",
            }),
          });
          return;
        }
        await mockApi(route, { permissions: persona.permissions });
      });
      await stand.visit(page, "api-access?section=keys");
      const create = page.getByTestId("api-key-create");
      if (!persona.expectedScopes) {
        if ((await create.count()) !== 0)
          throw new Error(`${persona.name}: read-only persona can create API keys`);
        continue;
      }
      await create.click();
      const dialog = page.getByTestId("api-key-create-dialog");
      await dialog.waitFor({ state: "visible" });
      const selectedPreset = dialog.locator(
        '[data-testid="api-key-create-scopes"] button[data-state="on"]',
      );
      if (!(await selectedPreset.innerText()).includes("Ausführen"))
        throw new Error(`${persona.name}: execution preset is not the default`);
      if (persona.warning) {
        const warning = page.getByTestId("api-key-intake-permission-missing");
        if (!(await warning.isVisible()) || !(await warning.innerText()).includes(persona.warning))
          throw new Error(`${persona.name}: missing intake permissions are not explained`);
      } else if ((await page.getByTestId("api-key-intake-permission-missing").count()) !== 0) {
        throw new Error(`${persona.name}: complete intake permissions are reported missing`);
      }
      await page.getByTestId("api-key-create-name").fill(`clipper-${persona.name}`);
      await dialog.getByRole("button", { name: "Erstellen" }).click();
      await page.getByTestId("secret-dialog").waitFor({ state: "visible" });
      if (JSON.stringify(issuedScopes) !== JSON.stringify(persona.expectedScopes))
        throw new Error(
          `${persona.name}: issued scopes were ${JSON.stringify(issuedScopes)}, expected ${JSON.stringify(persona.expectedScopes)}`,
        );
      if (issuedScopes.includes("intake:write") !== persona.permissions.includes("intake:write"))
        throw new Error(`${persona.name}: the key gained intake:write beyond the issuer's rights`);
    } finally {
      await context.close();
    }
  }
}
