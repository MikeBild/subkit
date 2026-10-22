import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  SKILL_TEMPLATES,
  skillScopeKey,
  skillsLoadState,
  skillTemplateFromSearch,
  skillTemplateKeys,
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
    expect(translate("de", skillWhereKey("chat"))).toBe("Chat");
    expect(translate("de", skillWhereKey("authoring"))).toBe("Workflow-Entwürfe");
    expect(translate("de", skillWhereKey("both"))).toBe("Chat und Workflow-Entwürfe");
  });
});
