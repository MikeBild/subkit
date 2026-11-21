import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { translate } from "@/lib/i18n";
import {
  CHANNEL_PLATFORMS,
  channelTargetLabel,
  deliveryState,
  eventPatternLabels,
  platformLabel,
  ruleDraftOf,
  ruleEditBody,
  ruleNameLabel,
  rulesUsing,
  ruleTarget,
  workflowPatternLabel,
} from "./notification-rules-model";

const de = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
  translate("de", key, values);

const ENGINE_SRC = resolve(import.meta.dir, "../../../../../engine/src");
const SEEDED_EVENT_PATTERN =
  /DEFAULT_CLI_INBOX_EVENT_PATTERN =\s*"([^"]+)"/.exec(
    readFileSync(resolve(ENGINE_SRC, "notifications/default-cli-rule.ts"), "utf8"),
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
      "Fehlgeschlagene Runs",
      "Anmeldung beim Connector fehlgeschlagen",
      "Anmeldung abgelehnt",
      "Connector-Zustand geändert",
      "Korrektur vorgeschlagen",
      "Aufgabe wartet auf dich",
      "Ergebnis einer Aufgabe liegt vor",
      "Aufgabe fehlgeschlagen",
      "Zeitplan nach wiederholten Fehlern automatisch pausiert",
      "Freigabe endet in 3 Tagen",
      "Dauererlaubnis endet in 3 Tagen",
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
      { text: "Vor dem Start abgelehnte Runs", machine: false },
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
  test("notification channel options are ordered and named in both languages without email", () => {
    expect(CHANNEL_PLATFORMS).toEqual(["slack", "google_chat", "webhook"]);

    const expected = {
      de: [
        ["slack", "Slack"],
        ["google_chat", "Google Chat"],
        ["webhook", "Webhook"],
      ],
      en: [
        ["slack", "Slack"],
        ["google_chat", "Google Chat"],
        ["webhook", "Webhook"],
      ],
    } as const;

    for (const locale of ["de", "en"] as const) {
      const t = (key: Parameters<typeof translate>[1], values?: Record<string, string | number>) =>
        translate(locale, key, values);
      const options = CHANNEL_PLATFORMS.map((platform) => [
        platform,
        platformLabel(platform, t).text,
      ]);
      const expectedOptions: string[][] = expected[locale].map(([platform, label]) => [
        platform,
        label,
      ]);
      expect(options).toEqual(expectedOptions);
      expect(CHANNEL_PLATFORMS.every((platform) => !platformLabel(platform, t).machine)).toBe(true);
    }
    expect(CHANNEL_PLATFORMS).not.toContain("email");
  });

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

describe("a channel's rules", () => {
  const rule = (channel: string) => ({
    name: "Fehler",
    event_pattern: "execution.failed",
    workflow_pattern: "*",
    target_workspace_id: "T1",
    target_channel_id: channel,
  });
  const other = { ...SLACK, id: "ch-2", channel_id: "C2" };

  test("counts only the rules that deliver to it", () => {
    expect(rulesUsing(SLACK, [rule("C1"), rule("C1"), rule("C2")])).toBe(2);
    expect(rulesUsing(other, [rule("C1")])).toBe(0);
  });

  test("the inbox rule keeps the inbox channel in use", () => {
    const inbox = { ...SLACK, id: "ch-inbox", workspace_id: "_cli", channel_id: "_inbox" };
    expect(rulesUsing(inbox, [SEEDED_RULE])).toBe(1);
    expect(rulesUsing(SLACK, [SEEDED_RULE])).toBe(0);
  });
});

describe("editing a rule", () => {
  const slack = {
    id: "ch-1",
    platform: "slack",
    workspace_id: "T1",
    channel_id: "C1",
    circuit_state: "closed",
    active: true,
  };
  const rule = {
    name: "Fehler",
    event_pattern: "execution.failed",
    workflow_pattern: "*",
    severity: "error",
    target_workspace_id: "T1",
    target_channel_id: "C1",
  };

  test("the form starts from what the rule does now", () => {
    expect(ruleDraftOf(rule, [slack])).toEqual({
      name: "Fehler",
      event: "execution.failed",
      severity: "error",
      target: "ch-1",
    });
  });

  test("saving sends only what changed", () => {
    const before = ruleDraftOf(rule, [slack]);
    expect(ruleEditBody(before, { ...before }, [slack])).toEqual({});
    expect(ruleEditBody(before, { ...before, severity: "critical" }, [slack])).toEqual({
      severity: "critical",
    });
  });

  test("moving the rule to the inbox names the inbox as its target", () => {
    const before = ruleDraftOf(rule, [slack]);
    expect(ruleEditBody(before, { ...before, target: "inbox" }, [slack])).toEqual({
      target_workspace_id: "_cli",
      target_channel_id: "_inbox",
    });
  });

  test("a target no channel answers for stays untouched", () => {
    const orphan = { ...rule, target_channel_id: "gone" };
    const before = ruleDraftOf(orphan, [slack]);
    expect(before.target).toBe("current");
    expect(ruleEditBody(before, { ...before, name: "Neu" }, [slack])).toEqual({ name: "Neu" });
  });
});

test("channel targets use their stored destination rather than a platform guess", () => {
  expect(
    channelTargetLabel({ platform: "webhook", channel_id: "https://example.test/events" }, de),
  ).toBe("https://example.test/events");
  expect(channelTargetLabel({ platform: "slack", channel_id: "C024" }, de)).toBe("C024");
  expect(channelTargetLabel({ platform: "sk_cli", channel_id: "_inbox" }, de)).toBe(
    translate("de", "notifications.target.inbox"),
  );
});
