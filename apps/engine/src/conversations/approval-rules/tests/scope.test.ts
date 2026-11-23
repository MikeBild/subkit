import { describe, expect, test } from "bun:test";
import { describeBoundAction } from "../../instruction-cover/bound-action.ts";
import { ruleEligible } from "../core/rule-scope.ts";
import {
  contentHash,
  RULE_DAILY_LIMIT,
  RULE_LIFETIME_DAYS,
  type RuleLimits,
  ruleExpiry,
  ruleRefusal,
  usesToday,
} from "../scope.ts";

const NOW = new Date("2026-11-20T10:00:00Z");

function rule(overrides: Partial<RuleLimits> = {}): RuleLimits {
  return {
    content_class: "same_content",
    content_hash: contentHash(["Status", "Alles läuft."]),
    expires_at: ruleExpiry(NOW),
    daily_limit: RULE_DAILY_LIMIT,
    uses_day: null,
    uses_on_day: 0,
    ...overrides,
  };
}

const same = { hash: contentHash(["Status", "Alles läuft."]), given: false };

describe("limits of a stored approval rule", () => {
  test("a rule lasts 90 days and runs out at that instant", () => {
    expect(RULE_LIFETIME_DAYS).toBe(90);
    expect(ruleExpiry(NOW).toISOString()).toBe("2027-02-18T10:00:00.000Z");
    expect(ruleRefusal(rule(), same, NOW)).toBeNull();
    expect(ruleRefusal(rule(), same, new Date(ruleExpiry(NOW).getTime() - 1))).toBeNull();
    expect(ruleRefusal(rule(), same, ruleExpiry(NOW))).toBe("rule_expired");
    expect(ruleRefusal(rule({ expires_at: null }), same, NOW)).toBe("rule_expired");
  });

  test("the daily bound counts per UTC day and starts again the next day", () => {
    expect(RULE_DAILY_LIMIT).toBe(20);
    const full = rule({ uses_day: "2026-11-20", uses_on_day: 20 });
    expect(usesToday(full, NOW)).toBe(20);
    expect(ruleRefusal(full, same, NOW)).toBe("rule_daily_limit");
    expect(ruleRefusal(rule({ uses_day: "2026-11-20", uses_on_day: 19 }), same, NOW)).toBeNull();
    const nextDay = new Date("2026-11-21T00:00:00Z");
    expect(usesToday(full, nextDay)).toBe(0);
    expect(ruleRefusal(full, same, nextDay)).toBeNull();
  });

  test("the content class binds what the rule lets through", () => {
    const other = { hash: contentHash(["Wir kündigen."]), given: false };
    expect(ruleRefusal(rule(), other, NOW)).toBe("rule_content");
    expect(ruleRefusal(rule({ content_class: "no_content", content_hash: null }), same, NOW)).toBe(
      "rule_content",
    );
    expect(
      ruleRefusal(
        rule({ content_class: "no_content", content_hash: null }),
        { hash: null, given: false },
        NOW,
      ),
    ).toBeNull();
    expect(ruleRefusal(rule({ content_class: "person_given" }), other, NOW)).toBe("rule_content");
    expect(
      ruleRefusal(rule({ content_class: "person_given" }), { ...other, given: true }, NOW),
    ).toBeNull();
    expect(contentHash([])).toBeNull();
    expect(contentHash(["  Alles   läuft. "])).toBe(contentHash(["Alles läuft."]));
  });

  test("no rule can exist for an always-ask class", () => {
    const never: Array<[string, string, unknown]> = [
      ["POST", "/v1/payments", { amount: 5 }],
      ["DELETE", "/tickets/1", {}],
      ["POST", "/v1/announcements", {}],
      ["PATCH", "/settings/4", {}],
      ["POST", "/notes/tokens", {}],
      ["POST", "/users", {}],
      ["POST", "/never/heard", {}],
    ];
    for (const [method, path, body] of never) {
      expect(
        ruleEligible(
          describeBoundAction("call_connector", { connector_id: "c", method, path, body }),
        ),
      ).toBe(false);
    }
    expect(
      ruleEligible(
        describeBoundAction("call_connector", {
          connector_id: "c",
          method: "POST",
          path: "/v1/messages/send",
        }),
      ),
    ).toBe(true);
  });
});
