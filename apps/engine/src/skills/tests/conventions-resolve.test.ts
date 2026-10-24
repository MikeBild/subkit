import { describe, expect, test } from "bun:test";
import { countTokens } from "../../llm/accounting/index.ts";
import {
  CONVENTIONS_HEADING,
  CONVENTIONS_SECTION_CAP,
  conventionsTrimReference,
  formatAppliedConventions,
} from "../../llm/core/context-assembler/formatters.ts";
import {
  type AppliedConvention,
  type ConventionLevel,
  NO_CONVENTIONS,
  resolveConventions,
} from "../conventions.ts";
import type { SkillRule } from "../types.ts";

function timezone(rule_id: string, value: string): SkillRule {
  return { rule_id, type: "timezone", statement: `Schedules run in ${value}.`, payload: { value } };
}

function pitfall(rule_id: string, text: string): SkillRule {
  return { rule_id, type: "pitfall", statement: text, payload: { text } };
}

function at(
  level: ConventionLevel,
  rule: SkillRule,
  skill_id = `${level}-skill`,
): AppliedConvention {
  return { level, skill_id, skill_title: `${level} conventions`, skill_version: 1, rule };
}

describe("resolveConventions", () => {
  test("the most specific level wins for the same convention", () => {
    const resolved = resolveConventions([
      at("global", timezone("tz-global", "UTC")),
      at("workflow", timezone("tz-workflow", "Europe/Berlin")),
      at("connector", timezone("tz-connector", "America/New_York")),
    ]);
    expect(resolved.conventions.map((entry) => entry.rule.rule_id)).toEqual(["tz-workflow"]);
    expect(resolved.conflicts).toEqual([]);
  });

  test("a same-level disagreement is a conflict, not a silent choice", () => {
    const resolved = resolveConventions([
      at("global", timezone("tz-b", "UTC"), "skill-b"),
      at("global", timezone("tz-a", "Europe/Berlin"), "skill-a"),
    ]);
    expect(resolved.conventions.map((entry) => entry.rule.rule_id)).toEqual(["tz-a", "tz-b"]);
    expect(resolved.conflicts).toHaveLength(1);
    expect(resolved.conflicts[0]?.key).toBe("timezone");
    expect(resolved.conflicts[0]?.conventions.map((entry) => entry.rule.rule_id)).toEqual([
      "tz-a",
      "tz-b",
    ]);
  });

  test("equal payloads at the same level do not conflict and pitfalls add up", () => {
    const resolved = resolveConventions([
      at("global", timezone("tz-a", "Europe/Berlin"), "skill-a"),
      at("global", timezone("tz-b", "Europe/Berlin"), "skill-b"),
      at("global", pitfall("p1", "Never delete invoices.")),
      at("workflow", pitfall("p2", "Never page at night.")),
    ]);
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.conventions.map((entry) => entry.rule.rule_id)).toEqual([
      "p2",
      "p1",
      "tz-a",
      "tz-b",
    ]);
  });
});

describe("formatAppliedConventions", () => {
  test("renders nothing without rules", () => {
    expect(formatAppliedConventions(NO_CONVENTIONS, "interactive")).toBeNull();
  });

  test("renders the heading, rules and conflicts", () => {
    const active = resolveConventions([
      at("global", timezone("tz-a", "Europe/Berlin"), "skill-a"),
      at("global", timezone("tz-b", "UTC"), "skill-b"),
    ]);
    const rendered = formatAppliedConventions(active, "interactive");
    expect(rendered?.section.startsWith(CONVENTIONS_HEADING)).toBe(true);
    expect(rendered?.section).toContain("- tz-a [timezone] Schedules run in Europe/Berlin.");
    expect(rendered?.section).toContain("Do not pick one; ask the person which applies");
    expect(rendered?.section).toContain(
      'timezone (global): tz-a {"value":"Europe/Berlin"} vs tz-b',
    );
  });

  test("keeps its own cap and names what it omitted", () => {
    const active = resolveConventions(
      Array.from({ length: 50 }, (_, i) =>
        at(
          "global",
          pitfall(`pitfall-${String(i).padStart(2, "0")}`, `${"Careful ".repeat(30)}${i}`),
        ),
      ),
    );
    const rendered = formatAppliedConventions(active, "interactive");
    expect(rendered).not.toBeNull();
    expect(countTokens(rendered?.section ?? "")).toBeLessThanOrEqual(CONVENTIONS_SECTION_CAP);
    expect(rendered?.included.length).toBeLessThan(50);
    expect(rendered?.included.length).toBeGreaterThan(0);
    expect(rendered?.section).toContain("load_skill('global conventions')");
  });

  test("the trim reference points at load_skill outside generation only", () => {
    const active = resolveConventions([at("global", timezone("tz", "Europe/Berlin"))]);
    expect(conventionsTrimReference(active, "interactive")).toContain("read them with load_skill");
    expect(conventionsTrimReference(active, "generate")).toContain("ask the outer agent");
  });
});
