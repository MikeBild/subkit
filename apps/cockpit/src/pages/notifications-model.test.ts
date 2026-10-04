import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { translate } from "@/lib/i18n";
import {
  deliveryState,
  eventPatternLabels,
  platformLabel,
  ruleNameLabel,
  ruleTarget,
  workflowPatternLabel,
} from "@/pages/notifications-model";

const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("de", key, values);

const ENGINE_SRC = resolve(import.meta.dir, "../../../engine/src");
const SEEDED_EVENT_PATTERN =
  /DEFAULT_CLI_INBOX_EVENT_PATTERN =\s*"([^"]+)"/.exec(
    readFileSync(resolve(ENGINE_SRC, "db/seed.ts"), "utf8"),
  )?.[1] ?? "";
const CATALOG_SOURCE = readFileSync(resolve(ENGINE_SRC, "webhooks/events/catalog.ts"), "utf8");
const ENGINE_EVENT_TYPES = [
  ...CATALOG_SOURCE.slice(CATALOG_SOURCE.indexOf("export const EVENT_CATALOG")).matchAll(
    /^ {2}"([a-z_]+(?:\.[a-z_]+)+)": \{/gm,
  ),
].map((match) => match[1] as string);

const SEEDED_RULE = {
  name: "sk CLI inbox (default)",
  event_pattern: SEEDED_EVENT_PATTERN,
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
    expect(eventPatternLabels("*", de)).toEqual([
      { text: de("notifications.events.all"), machine: false },
    ]);
    expect(eventPatternLabels("execution.failed, *", de)).toEqual([
      { text: de("notifications.events.all"), machine: false },
    ]);
    expect(workflowPatternLabel("", de)).toEqual({
      text: de("notifications.workflows.all"),
      machine: false,
    });
  });

  test("an area glob is named; any other pattern is the engine's glob, marked", () => {
    expect(eventPatternLabels("execution.*", de)).toEqual([
      {
        text: de("notifications.events.area", { area: de("notifications.eventArea.execution") }),
        machine: false,
      },
    ]);
    expect(eventPatternLabels("execution.fai*", de)).toEqual([
      { text: "execution.fai*", machine: true },
    ]);
    expect(workflowPatternLabel("ga4-*", de)).toEqual({ text: "ga4-*", machine: true });
  });

  test("the seeded rule's list reads as its events, each by name", () => {
    expect(SEEDED_EVENT_PATTERN.split(",").length).toBeGreaterThan(1);
    const labels = eventPatternLabels(SEEDED_RULE.event_pattern, de);
    expect(labels.map((label) => label.text)).toEqual([
      "Fehlgeschlagene Läufe",
      "Anmeldung beim Connector fehlgeschlagen",
      "Anmeldung abgelehnt",
      "Connector-Zustand geändert",
      "Reparatur vorgeschlagen",
    ]);
    expect(labels.every((label) => !label.machine)).toBe(true);
  });

  test("a list is read part by part, as the engine matches it", () => {
    expect(
      eventPatternLabels(" execution.failed ,, vendor.custom_event, connector.* ", de),
    ).toEqual([
      { text: de("notifications.event.execution.failed"), machine: false },
      { text: "vendor.custom_event", machine: true },
      {
        text: de("notifications.events.area", { area: de("notifications.eventArea.connector") }),
        machine: false,
      },
    ]);
  });

  test("a run refused before it started is named as such", () => {
    expect(eventPatternLabels("execution.refused", de)).toEqual([
      { text: "Vor dem Start abgelehnte Läufe", machine: false },
    ]);
    expect(eventPatternLabels("execution.refused", (key) => translate("en", key))).toEqual([
      { text: "Runs refused before start", machine: false },
    ]);
  });

  test("every event the engine catalogues has a name in both languages", () => {
    expect(ENGINE_EVENT_TYPES.length).toBeGreaterThan(10);
    for (const locale of ["de", "en"] as const) {
      const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
        translate(locale, key, values);
      for (const type of ENGINE_EVENT_TYPES) {
        const [label] = eventPatternLabels(type, t);
        expect({ type, locale, machine: label?.machine }).toEqual({
          type,
          locale,
          machine: false,
        });
      }
    }
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
