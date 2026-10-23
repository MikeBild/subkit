import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  SKILL_TEMPLATES,
  type SkillHistoryDetail,
  skillChangedAt,
  skillHistoryGap,
  skillScope,
  skillScopeKey,
  skillScopePhraseKey,
  skillsLoadState,
  skillTemplateFromSearch,
  skillTemplateKeys,
  skillVersionBasis,
  skillVersionChange,
  skillVersionRows,
  skillWhereKey,
} from "./skills-model";

describe("skill templates prefill the editor", () => {
  test("only a known template is read from the address", () => {
    expect(skillTemplateFromSearch("?template=tone")).toBe("tone");
    expect(skillTemplateFromSearch("?template=unknown")).toBeNull();
    expect(skillTemplateFromSearch("")).toBeNull();
  });

  test("every template has a title, a line and a body in both languages", () => {
    for (const template of SKILL_TEMPLATES)
      for (const key of Object.values(skillTemplateKeys(template)))
        for (const locale of ["de", "en"] as const) expect(translate(locale, key)).not.toBe(key);
  });
});

describe("skillVersionRows", () => {
  const entry = (id: string, version: number | null, has_snapshot = true) => ({
    audit_entry_id: id,
    version,
    title: "Ton",
    lifecycle: "active",
    updated_at: "2026-10-20T08:00:00.000Z",
    actor_id: null,
    has_snapshot,
  });

  test("marks the running version as current and never offers to restore it", () => {
    const rows = skillVersionRows([entry("c", 3), entry("b", 2), entry("a", 1, false)], 3);
    expect(rows.map((row) => [row.current, row.restorable])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
  });

  test("falls back to the newest entry when the version is not listed", () => {
    const rows = skillVersionRows([entry("b", null), entry("a", null)], 7);
    expect(rows[0]?.current).toBe(true);
    expect(rows[1]?.restorable).toBe(true);
  });
});

const done = { isPending: false, error: null, failureReason: null };
const loading = { isPending: true, error: null, failureReason: null };
const broken = { isPending: false, error: new Error("boom"), failureReason: null };
const retrying = { isPending: true, error: null, failureReason: new Error("boom") };

describe("skillsLoadState", () => {
  test("waits while either the skills or the proposals are loading", () => {
    expect(skillsLoadState([done, loading])).toEqual({ pending: true, failed: false });
    expect(skillsLoadState([loading, done])).toEqual({ pending: true, failed: false });
  });

  test("a failed proposals read is an error, not a silently shorter list", () => {
    expect(skillsLoadState([done, broken])).toEqual({ pending: false, failed: true });
    expect(skillsLoadState([done, retrying])).toEqual({ pending: false, failed: true });
  });

  test("both loaded is neither pending nor failed", () => {
    expect(skillsLoadState([done, done])).toEqual({ pending: false, failed: false });
  });
});

describe("what a skill covers and where it is used are two answers", () => {
  test("the scope never names the chat and the place never names a connector", () => {
    expect(translate("de", skillScopeKey("global"))).toBe("Alles");
    expect(translate("de", skillScopeKey("connector"))).toBe("Einen Konnektor");
    expect(translate("de", skillScopeKey("workflow"))).toBe("Einen Workflow");
  });

  test("header and usage read one scope, lower-case inside a sentence", () => {
    const bound = { scope: "connector", connector_id: "c1", workflow_id: null };
    const lost = { scope: "connector", connector_id: null, workflow_id: null };
    expect(skillScope(bound)).toBe("connector");
    expect(skillScope(lost)).toBe("unbound");
    expect(skillScope({ scope: "global" })).toBe("global");
    expect(skillScope({ scope: "workflow", workflow_id: null })).toBe("unbound");
    expect(
      translate("de", "skills.strip.active", {
        scope: translate("de", skillScopePhraseKey(skillScope(bound))),
        when: "vor 2 Std.",
      }),
    ).toBe("Aktiv · gilt für einen Konnektor · geändert vor 2 Std.");
    expect(translate("de", skillScopePhraseKey("global"))).toBe("alles");
    expect(translate("de", skillWhereKey("chat"))).toBe("Chat");
    expect(translate("de", skillWhereKey("authoring"))).toBe("Workflow-Entwürfe");
    expect(translate("de", skillWhereKey("both"))).toBe("Chat und Workflow-Entwürfe");
  });
});

describe("skillVersionChange", () => {
  const detail = (
    before: SkillHistoryDetail["before"],
    after: SkillHistoryDetail["after"],
  ): SkillHistoryDetail => ({
    audit_entry_id: "entry",
    version: 2,
    title: after?.title ?? null,
    lifecycle: "active",
    updated_at: "2026-10-23T08:00:00.000Z",
    actor_id: null,
    has_snapshot: after !== null,
    before,
    after,
  });

  test("shows removed and added lines of the body against the version before", () => {
    const change = skillVersionChange(
      detail(
        { title: "Tone", body: "Be brief.\nUse du." },
        { title: "Tone", body: "Be brief.\nUse Sie." },
      ),
    );
    expect(change?.renamedFrom).toBeNull();
    expect(change?.rows).toEqual([
      { type: "context", text: "Be brief." },
      { type: "removed", text: "Use du." },
      { type: "added", text: "Use Sie." },
    ]);
  });

  test("an unchanged body has no rows and a rename keeps the old name", () => {
    const change = skillVersionChange(
      detail({ title: "Tone", body: "Same." }, { title: "Voice", body: "Same." }),
    );
    expect(change?.rows).toEqual([]);
    expect(change?.renamedFrom).toBe("Tone");
  });

  test("an entry without saved states has no change to show", () => {
    expect(skillVersionChange(detail(null, null))).toBeNull();
  });
});

describe("skill versions agree with the engine history", () => {
  const entry = (version: number | null, at: string, id = `e${version}`) => ({
    audit_entry_id: id,
    version,
    title: "Rule",
    lifecycle: "active",
    updated_at: at,
    actor_id: null,
    has_snapshot: true,
  });

  test("a skill with one recorded version says honestly that older versions were not kept", () => {
    const rows = skillVersionRows([entry(67, "2026-10-20T10:00:00Z")], 67);
    expect(skillHistoryGap(rows, 67)).toEqual({ through: 66 });
    expect(skillHistoryGap(skillVersionRows([entry(1, "2026-10-20T10:00:00Z")], 1), 1)).toBeNull();
    expect(skillHistoryGap([], 1)).toBeNull();
    expect(skillHistoryGap([], 3)).toEqual({ through: 2 });
  });

  test("Vorher names a version only when that version is listed", () => {
    const rows = skillVersionRows(
      [entry(5, "2026-10-21T10:00:00Z"), entry(4, "2026-10-20T10:00:00Z")],
      5,
    );
    const [five, four] = rows;
    if (!five || !four) throw new Error("rows missing");
    expect(skillVersionBasis(rows, five)).toBe(4);
    expect(skillVersionBasis(rows, four)).toBeNull();
  });

  test("the header's changed time is the current version's time from the history", () => {
    const rows = skillVersionRows(
      [entry(5, "2026-10-21T10:00:00Z"), entry(4, "2026-10-20T10:00:00Z")],
      5,
    );
    const skill = { version: 5, updated_at: "2026-10-22T08:00:00Z" };
    expect(skillChangedAt(skill, rows)).toBe("2026-10-21T10:00:00Z");
    expect(skillChangedAt(skill, null)).toBe("2026-10-22T08:00:00Z");
    expect(skillChangedAt({ version: 6, updated_at: "2026-10-22T08:00:00Z" }, rows)).toBe(
      "2026-10-22T08:00:00Z",
    );
  });
});
