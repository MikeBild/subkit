// "Konnektor hinzufügen" by hand asks two separate questions in short labels.
//
// The defect this stands on: the form offered "Art: [OAuth] [MCP]
// [API-Schlüssel]" — one control mixing WHAT is connected with HOW SubKit
// signs in there, in protocol words. A reader could not tell an API key from
// MCP. Now:
//
// 1. "Was verbinden?" offers [Web-Dienst] [MCP-Server]; "Anmeldung" offers
//    [Mit Konto] [Mit Schlüssel] [Ohne]. Explanations live behind (?), never
//    inline.
// 2. Only the fields the answer needs: the access key field appears for
//    "Mit Schlüssel" alone.
// 3. Both choices fit the dialog at every width the sweep runs.

const WORDS = {
  de: {
    target: ["Web-Dienst", "MCP-Server"],
    signIn: ["Mit Konto", "Mit Schlüssel", "Ohne"],
    secret: "Zugangsschlüssel",
  },
  en: {
    target: ["Web service", "MCP server"],
    signIn: ["With account", "With key", "None"],
    secret: "Access key",
  },
};

const JARGON = /OAuth|API-Schlüssel|API key/;

async function optionTexts(page, testId) {
  return (await page.getByTestId(testId).locator("button").allInnerTexts()).map((label) =>
    label.trim(),
  );
}

async function assertInside(page, testId, where) {
  const dialog = await page.getByTestId("create-connector-dialog").boundingBox();
  const control = await page.getByTestId(testId).boundingBox();
  if (!dialog || !control) throw new Error(`${where}: ${testId} is not on screen`);
  if (control.x < dialog.x - 0.5 || control.x + control.width > dialog.x + dialog.width + 0.5)
    throw new Error(`${where}: ${testId} runs past the dialog's edge`);
}

export async function verifyCreateConnector(page, stand, localeName, capture) {
  const words = WORDS[localeName] ?? WORDS.en;
  const where = `/connectors/<create by hand> (${localeName})`;
  await stand.visit(page, "connectors");
  await page.getByTestId("catalog-primary-action").click();
  const dialog = page.getByTestId("create-connector-dialog");
  await dialog.waitFor({ state: "visible", timeout: 10_000 });
  const manual = page.getByTestId("create-connector-manual");
  if (await manual.count()) await manual.click();
  await page.getByTestId("create-connector-target").waitFor({ state: "visible", timeout: 5_000 });

  const target = await optionTexts(page, "create-connector-target");
  if (target.join("|") !== words.target.join("|"))
    throw new Error(`${where}: "what" offers ${JSON.stringify(target)}`);
  const signIn = await optionTexts(page, "create-connector-signin");
  if (signIn.join("|") !== words.signIn.join("|"))
    throw new Error(`${where}: "sign-in" offers ${JSON.stringify(signIn)}`);
  const visible = await dialog.innerText();
  if (JARGON.test(visible)) throw new Error(`${where}: the dialog still reads protocol words`);
  for (const testId of ["create-connector-target", "create-connector-signin"])
    await assertInside(page, testId, where);
  if (await page.locator("#create-connector-secret").count())
    throw new Error(`${where}: an account sign-in asks for a key`);
  await capture("create-connector-account");

  await page.getByTestId("create-connector-target-mcp").click();
  await page.getByTestId("create-connector-signin-key").click();
  const secret = page.locator("#create-connector-secret");
  await secret.waitFor({ state: "visible", timeout: 5_000 });
  const label = (await page.locator('label[for="create-connector-secret"]').innerText()).trim();
  if (label !== words.secret) throw new Error(`${where}: the key field reads "${label}"`);
  await capture("create-connector-key");

  await page.getByTestId("create-connector-signin-none").click();
  if (await secret.count()) throw new Error(`${where}: no sign-in still asks for a key`);
  await page.getByTestId("create-connector-dialog-cancel").click();
  await dialog.waitFor({ state: "hidden", timeout: 5_000 });
}
