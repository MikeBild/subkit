import { expect, test } from "bun:test";
import { EVENT_CATALOG } from "../events/catalog.ts";
import { shouldDispatchCockpitPushAttention } from "./cockpit-push-attention.ts";

test("Cockpit push only wakes a user for catalogued operator attention", () => {
  const selected = Object.entries(EVENT_CATALOG)
    .filter(([type, entry]) => shouldDispatchCockpitPushAttention(type, entry.example))
    .map(([type]) => type);

  expect(selected).toEqual([
    "execution.failed",
    "connector.oauth.callback_failed",
    "connector.auth_failed",
    "connector.health_changed",
    "patch.proposed",
  ]);
  expect(
    shouldDispatchCockpitPushAttention("connector.health_changed", {
      ...EVENT_CATALOG["connector.health_changed"].example,
      error_code: "temporary_unavailable",
    }),
  ).toBeFalse();
  expect(shouldDispatchCockpitPushAttention("unknown.event", {})).toBeFalse();
});
