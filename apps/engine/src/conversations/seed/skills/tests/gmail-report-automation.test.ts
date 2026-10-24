import { describe, expect, test } from "bun:test";
import type { Db } from "../../../../db/client.ts";
import { loadEmbeddedSkillSeeds } from "../../../../skills/seed.ts";
import { renderAutomationContext } from "../../../automation-context.ts";
import { type ActivationRecord, autoloadForUserTurn } from "../../../skill-autoload.ts";

const loaded = loadEmbeddedSkillSeeds();
const catalog: ActivationRecord[] = loaded.skills.map((skill) => ({
  slug: skill.slug,
  activates_when: skill.activates_when,
  maturity: skill.maturity,
  side_effects: skill.side_effects,
  tags: skill.tags,
}));

describe("Gmail report authoring guidance", () => {
  test("lives in a connector skill bound to the Gmail template", () => {
    const skill = loaded.skills.find((entry) => entry.slug === "gmail-report-automation");
    expect(skill?.scope).toBe("connector");
    expect(skill?.activates_when).toEqual([{ kind: "connector_template", slug: "google-gmail" }]);
    expect(skill?.body).toContain("sk.base64UrlEncodeUtf8");
    expect(skill?.body).toContain("`raw` as the only property");
  });

  test("loads only when a Gmail-template connector is in scope", () => {
    const gmail = autoloadForUserTurn(
      { user_text: "make the report recurring", connector_templates: ["google-gmail"] },
      catalog,
      [],
    );
    expect(gmail).toContain("gmail-report-automation");
    const other = autoloadForUserTurn(
      { user_text: "make the report recurring", connector_templates: ["google-analytics"] },
      catalog,
      [],
    );
    expect(other).not.toContain("gmail-report-automation");
  });

  test("the generic automation prompt names no mail provider", async () => {
    const block = await renderAutomationContext("tenant", "workflow", null, {} as Db);
    expect(block).toContain("AUTOMATIC OPERATION");
    expect(block).not.toMatch(/gmail|google/i);
    expect(block).not.toContain("base64UrlEncode");
  });
});
