import { translate } from "../../apps/cockpit/src/lib/i18n.ts";

function require(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verifySkillEditorEvidence(page, stand, locale, capture) {
  const t = (key) => translate(locale, key);
  const id = "018f4b4a-6d33-7b3a-9c2d-00000000b731";
  const endpoint = `/v1/skills/${id}`;
  const original = {
    id,
    tenant_id: "018f4b4a-6d33-7b3a-9c2d-00000000b732",
    scope: "global",
    connector_id: null,
    workflow_id: null,
    slug: "evidence-scope-skill",
    title: "Evidence scope skill",
    description: null,
    description_source: "human",
    category: "other",
    category_source: "human",
    body: "# Evidence scope skill\n\nKeep source and destination explicit.",
    examples: [],
    best_practices: [],
    pitfalls: [],
    doc_refs: [],
    gates_tools: [],
    activates_when: [],
    input_schema: null,
    output_schema: null,
    output_transform: null,
    side_effects: "read",
    idempotency: "none",
    maturity: "stable",
    tags: [],
    applies_to: "chat",
    status: "active",
    source: "manual",
    version: 7,
    created_at: "2025-07-11T12:00:00.000Z",
    updated_at: "2025-07-11T12:00:00.000Z",
  };
  let saved = { ...original };
  const writes = [];
  const reads = [];
  const handler = async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname !== endpoint) return route.fallback();
    if (request.method() === "GET") {
      reads.push(saved.version);
      return route.fulfill({ json: saved });
    }
    if (request.method() === "PATCH") {
      const body = request.postDataJSON();
      require(Object.keys(body).sort().join("|") ===
        "applies_to|body|expected_version|title", "Skill editor must send only its editable values and version guard");
      require(body.title === original.title &&
        body.body === original.body &&
        body.applies_to === "authoring" &&
        body.expected_version ===
          7, "Workflow drafts save must preserve content and send applies_to=authoring with the loaded version");
      require(writes.length === 0, "Only one skill editor PATCH is allowed");
      writes.push(body);
      saved = {
        ...saved,
        applies_to: body.applies_to,
        version: 8,
        updated_at: "2025-07-12T12:00:00.000Z",
      };
      return route.fulfill({ json: saved });
    }
    return route.fallback();
  };
  await page.route("**/v1/**", handler);
  try {
    await stand.visit(page, `skills/${id}?mode=edit`);
    const editor = page.getByTestId("skill-editor");
    await editor.waitFor({ state: "visible" });
    await page.getByTestId("skill-applies-to-chat").waitFor({ state: "visible" });
    const appliesLabel = editor.getByText(t("skills.editor.appliesTo"), { exact: true }).first();
    require(await appliesLabel.isVisible(), "Skill editor must retain the separate Wirkt-in field label");
    await page.getByTestId("skill-editor-preview").click();
    const facts = page.getByTestId("skill-editor-preview-facts");
    const labels = (await facts.locator("dt").allTextContents()).map((value) => value.trim());
    const values = (await facts.locator("dd").allTextContents()).map((value) => value.trim());
    require(labels.join("|") === `${t("common.name")}|${t("skills.column.scope")}` &&
      values.join("|") ===
        `${original.title}|${t("skills.scope.global")}`, `Skill preview facts mismatch; got labels=${JSON.stringify(labels)} values=${JSON.stringify(values)}, expected labels=${JSON.stringify([t("common.name"), t("skills.column.scope")])} values=${JSON.stringify([original.title, t("skills.scope.global")])}`);
    await page
      .getByTestId("skill-editor-preview-body")
      .getByText("Keep source and destination explicit.")
      .waitFor({ state: "visible" });
    await capture("skill-editor-preview-scope-and-body");
    await page.getByTestId("skill-editor-edit").click();
    await page.getByTestId("skill-applies-to-authoring").click();
    await page.getByTestId("skill-save").click();
    await editor.waitFor({ state: "hidden" });
    require(writes.length === 1 &&
      writes[0].applies_to === "authoring" &&
      writes[0].expected_version ===
        7, "Workflow-draft selection must produce exactly one guarded save");
    await page.reload();
    await stand.visit(page, `skills/${id}?mode=edit`);
    await page.getByTestId("skill-applies-to-authoring").waitFor({ state: "visible" });
    require(reads.includes(8), "Reopened editor must GET the saved skill version");
    await page.getByTestId("skill-applies-to-chat").click();
    await page.getByTestId("skill-discard").click();
    require((await page.getByTestId("skill-applies-to-authoring").getAttribute("data-state")) ===
      "on", "Discard must restore the persisted Workflow drafts choice");
    require(writes.length === 1 &&
      saved.applies_to ===
        "authoring", "Discarding a second selection must not send another PATCH or change persisted state");
    await capture("skill-editor-discard-does-not-save");
  } finally {
    await page.unroute("**/v1/**", handler);
  }
}
