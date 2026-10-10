const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

const binding = (placeholder, template, template_name) => ({
  placeholder,
  template,
  template_name,
  connector_id: null,
  connector_name: null,
  candidates: [],
});

const solution = (recipe_slug, title, connectors) => ({
  template_slug: null,
  recipe_slug,
  title,
  description: title,
  category: "solutions",
  tags: [],
  difficulty: "easy",
  connectors,
  workflow: { trigger: { kind: "schedule" }, steps: [] },
});

const SOLUTIONS = {
  vertical: "solutions",
  recipes: [
    solution("invoice-attachments-to-drive", "File invoice attachments", [
      binding("51000000-0000-4000-8000-000000000001", "google-gmail", "Google Gmail"),
      binding("51000000-0000-4000-8000-000000000002", "google-drive", "Google Drive"),
    ]),
    solution("webhook-to-slack", "Post important events to Slack", [
      binding("54000000-0000-4000-8000-000000000001", "slack", "Slack"),
    ]),
  ],
};

const template = (slug, name, auth_type, recipes) => ({
  version: 1,
  slug,
  name,
  driver: "http",
  base_url: `https://api.${slug}.example`,
  auth_type,
  default_skill: null,
  ingestion_source: null,
  ingestion_url: null,
  icon: "plug",
  description: name,
  category: "communication",
  tags: [],
  aliases: [],
  setup_instructions: "",
  auth_options: [],
  url_pattern: null,
  keywords: [],
  example_paths: [],
  recipes: Array.from({ length: recipes }, (_, index) => ({ slug: `${slug}-${index}` })),
});

const TEMPLATES = {
  items: [
    template("airtable", "Airtable", "bearer", 8),
    template("slack", "Slack", "oauth2", 3),
    template("plain", "Plain HTTP", "none", 0),
  ],
};

const isPath = (path) => (url) => new URL(url).pathname === path;
const solutionsPath = isPath("/v1/recipe-packs/solutions");
const templatesPath = isPath("/v1/connector-templates");

async function assertPickRows(page, where, listId) {
  await page.getByTestId(`${listId}-row-0`).waitFor({ state: "visible", timeout: 10_000 });
  const list = page.getByTestId(listId);
  if (await list.locator("[data-family-collection-mobile-card]").count())
    throw new Error(`${where}: the pick list turned into cards`);
  if (await list.locator('[data-family-slot="list-toolbar"]').count())
    throw new Error(`${where}: the pick list draws an empty toolbar strip`);
}

async function openTemplates(page, stand, catalog, kind) {
  await stand.visit(page, catalog);
  await page.getByTestId("catalog-primary-action").click();
  await page.getByTestId(`create-${kind}-template`).click();
}

export async function verifyTemplateLists(page, stand, capture) {
  const answerSolutions = (route) => json(route, SOLUTIONS);
  const answerTemplates = (route) => json(route, TEMPLATES);
  await page.route(solutionsPath, answerSolutions);
  await page.route(templatesPath, answerTemplates);
  try {
    await openTemplates(page, stand, "workflows", "workflow");
    await assertPickRows(page, "/workflows → from template", "create-solution");
    await capture("workflow-templates");
    await page.keyboard.press("Escape");

    await openTemplates(page, stand, "connectors", "connector");
    await assertPickRows(page, "/connectors → from template", "create-template");
    await capture("connector-templates");
    await page.keyboard.press("Escape");
  } finally {
    await page.unroute(solutionsPath, answerSolutions);
    await page.unroute(templatesPath, answerTemplates);
  }
}
