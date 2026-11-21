import { describe, expect, test } from "bun:test";
import { routerPath } from "@/app/links";
import { type TranslationKey, translate } from "@/lib/i18n";
import { actionLabelKey } from "./overview-model";
import { de, item } from "./overview-model-fixtures.ts";

const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);

describe("the monthly AI budget is reached", () => {
  const raise = {
    verb: "open" as const,
    href: "/cockpit/settings?area=usage&spend=raise",
    primary: true,
    permission: "identity:write",
  };
  const keepGoing = {
    ...raise,
    href: "/cockpit/settings?area=usage&spend=continue",
    primary: false,
  };
  const entry = item({
    id: "spend-limit:2026-11",
    class: "stopped",
    severity: "critical",
    kind: "spend_limit",
    subject: null,
    reason: "spend_limit_reached",
    actions: [raise, keepGoing],
  });

  test("offers Budget erhöhen and continuing this month, both on the usage page", () => {
    expect(de(actionLabelKey(raise, entry))).toBe("Budget erhöhen");
    expect(de(actionLabelKey(keepGoing, entry))).toBe("Diesen Monat weiter ohne Grenze");
    expect(en(actionLabelKey(raise, entry))).toBe("Raise budget");
    expect(routerPath(keepGoing.href)).toBe("/settings?area=usage&spend=continue");
  });
});
