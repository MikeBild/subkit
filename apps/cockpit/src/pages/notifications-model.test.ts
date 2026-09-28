// What the notifications page says about a rule and a channel.
//
// It printed `*`, `sk_cli` and the seeded rule's English name, and a delivery
// phase it had no word for fell back to the red "ausgesetzt" badge. These pin
// the words, the fallbacks and the one case that may be red.

import { describe, expect, test } from "bun:test";
import { translate } from "@/lib/i18n";
import {
  deliveryState,
  eventPatternLabel,
  platformLabel,
  ruleNameLabel,
  ruleTarget,
  workflowPatternLabel,
} from "@/pages/notifications-model";

const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("de", key, values);

const SEEDED_RULE = {
  name: "sk CLI inbox (default)",
  event_pattern: "*",
  workflow_pattern: "*",
  target_workspace_id: "_cli",
  target_channel_id: "_inbox",
};

const SLACK = {
  id: "ch-1",
  platform: "slack",
  workspace_id: "T1",
  channel_id: "C1",
  circuit_state: "closed",
  active: true,
};

describe("rules", () => {
  test("`*` reads as every event and every workflow", () => {
    expect(eventPatternLabel("*", de)).toEqual({
      text: de("notifications.events.all"),
      machine: false,
    });
    expect(workflowPatternLabel("", de)).toEqual({
      text: de("notifications.workflows.all"),
      machine: false,
    });
  });

  test("an area glob is named; any other pattern is the engine's glob, marked", () => {
    expect(eventPatternLabel("execution.*", de).text).toBe(
      de("notifications.events.area", { area: de("notifications.eventArea.execution") }),
    );
    expect(eventPatternLabel("execution.fai*", de)).toEqual({
      text: "execution.fai*",
      machine: true,
    });
    expect(workflowPatternLabel("ga4-*", de)).toEqual({ text: "ga4-*", machine: true });
  });

  test("the seeded inbox rule gets a name; an operator's rule keeps theirs", () => {
    expect(ruleNameLabel(SEEDED_RULE, de)).toBe(de("notifications.rule.defaultInbox"));
    expect(
      ruleNameLabel({ ...SEEDED_RULE, name: "Nachtschicht", target_workspace_id: "T1" }, de),
    ).toBe("Nachtschicht");
  });

  test("a rule says where it delivers", () => {
    expect(ruleTarget(SEEDED_RULE, [])).toEqual({ kind: "inbox" });
    const rule = {
      ...SEEDED_RULE,
      name: "Ops",
      target_workspace_id: "T1",
      target_channel_id: "C1",
    };
    expect(ruleTarget(rule, [SLACK])).toEqual({ kind: "channel", channel: SLACK });
    // Channels appear on the first delivery; until then the rule is not broken.
    expect(ruleTarget({ ...rule, target_channel_id: "C9" }, [SLACK])).toEqual({ kind: "pending" });
  });
});

describe("channels", () => {
  test("the local inbox is named, never `sk_cli`", () => {
    expect(platformLabel("sk_cli", de)).toEqual({
      text: de("notifications.platform.inbox"),
      machine: false,
    });
    expect(platformLabel("teams", de)).toEqual({ text: "teams", machine: true });
  });

  const now = Date.parse("2026-09-28T10:00:00.000Z");

  test("only a running cool-down is suspended", () => {
    expect(
      deliveryState(
        {
          ...SLACK,
          circuit_state: "open",
          circuit_open_until: "2026-09-28T10:04:00.000Z",
          consecutive_failures: 10,
        },
        now,
      ),
    ).toEqual({ kind: "suspended", until: "2026-09-28T10:04:00.000Z", failures: 10 });
  });

  test("a cool-down that has passed is the retry, not an outage", () => {
    expect(
      deliveryState(
        { ...SLACK, circuit_state: "open", circuit_open_until: "2026-09-28T09:00:00.000Z" },
        now,
      ),
    ).toEqual({ kind: "retrying" });
    expect(deliveryState({ ...SLACK, circuit_state: "half_open" }, now)).toEqual({
      kind: "retrying",
    });
  });

  test("the inbox is never circuit-broken, whatever the row says", () => {
    expect(deliveryState({ ...SLACK, platform: "sk_cli", circuit_state: "open" }, now)).toEqual({
      kind: "delivering",
    });
  });

  test("a phase this build has no word for is the machine value, not the red badge", () => {
    expect(deliveryState({ ...SLACK, circuit_state: "draining" }, now)).toEqual({
      kind: "machine",
      value: "draining",
    });
  });
});
