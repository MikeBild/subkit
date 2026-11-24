import { describe, expect, test } from "bun:test";
import {
  skillHistoryGap,
  skillScopeKey,
  skillVersionRows,
} from "@/features/knowledge/model/skills-model";
import { translate } from "@/lib/i18n";

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

  test("labels no row current when the running version is not in the history (#538)", () => {
    const rows = skillVersionRows([entry("c", 3), entry("b", 2)], 4);
    expect(rows.map((row) => [row.current, row.restorable])).toEqual([
      [false, true],
      [false, true],
    ]);
  });
});

describe("what a skill covers and where it is used are two answers", () => {
  test("the scope never names the chat and the place never names a connector", () => {
    expect(translate("de", skillScopeKey("global"))).toBe("Alles");
    expect(translate("de", skillScopeKey("connector"))).toBe("Einen Connector");
    expect(translate("de", skillScopeKey("workflow"))).toBe("Einen Workflow");
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
});
