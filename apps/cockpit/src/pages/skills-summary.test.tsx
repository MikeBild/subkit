import { describe, expect, test } from "bun:test";
import { render } from "@/components/cockpit/patterns/test-utils";
import { translate } from "@/lib/i18n";
import { skillsLine } from "./skills";

const t = ((key, values) => translate("de", key, values)) as Parameters<typeof skillsLine>[0];

describe("skills summary", () => {
  test("open proposals lead to the candidates page", () => {
    const html = render(<p>{skillsLine(t, 4, 2)}</p>);
    expect(html).toContain("4 Skills");
    expect(html).toContain('data-testid="skills-review-candidates"');
    expect(html).toContain('href="/cockpit/skills/candidates"');
    expect(html).toContain("2 Vorschläge offen");
  });

  test("without proposals the line names only the skills", () => {
    expect(render(<p>{skillsLine(t, 1, 0)}</p>)).toBe("<p>1 Skill</p>");
  });
});
