import { describe, expect, test } from "bun:test";
import { routerPath, taskHref } from "@/app/links";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  type AttentionAction,
  type AttentionItem,
  actionLabelKey,
  attentionRow,
  attentionSentence,
  opensReviewSheet,
  sentenceText,
  sourceLabel,
} from "./overview-model";
import { de, item, NOW, W } from "./overview-model-fixtures.ts";

const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);

const action = (verb: AttentionAction["verb"], permission: string): AttentionAction => ({
  verb,
  href: `/cockpit/tasks/${W}`,
  primary: true,
  permission,
});

const task = (
  reason: AttentionItem["reason"],
  verb: AttentionAction["verb"],
  permission: string,
  overrides: Partial<AttentionItem> = {},
): AttentionItem =>
  item({
    id: `task:${W}`,
    kind: "task",
    subject: { kind: "task", id: W, name: "Rechnungen nachfassen" },
    reason,
    since: null,
    actions: [action(verb, permission)],
    ...overrides,
  });

const CASES: ReadonlyArray<{
  entry: AttentionItem;
  de: string;
  en: string;
  actionDe: string;
  actionEn: string;
  shortDe: string;
  badgeDe: string;
}> = [
  {
    entry: task("awaiting_answer", "answer", "conversation:write", { detail: "question" }),
    de: "Die Aufgabe „Rechnungen nachfassen“ wartet auf deine Antwort.",
    en: "The task “Rechnungen nachfassen” is waiting for your answer.",
    actionDe: "Antworten",
    actionEn: "Answer",
    shortDe: "Wartet auf deine Antwort",
    badgeDe: "Wartet auf Antwort",
  },
  {
    entry: task("task_result_ready", "review", "task:run"),
    de: "Die Aufgabe „Rechnungen nachfassen“ ist fertig.",
    en: "The task “Rechnungen nachfassen” has a result ready.",
    actionDe: "Ergebnis prüfen",
    actionEn: "Review result",
    shortDe: "Ergebnis liegt vor",
    badgeDe: "Ergebnis liegt vor",
  },
  {
    entry: task("task_grant_required", "open", "task:grant", { detail: "grant_expired" }),
    de: "Die Aufgabe „Rechnungen nachfassen“ darf nicht mehr alleine starten.",
    en: "The task “Rechnungen nachfassen” may no longer start on its own.",
    actionDe: "Erlauben",
    actionEn: "Allow",
    shortDe: "Darf nicht alleine starten",
    badgeDe: "Wartet auf Erlaubnis",
  },
  {
    entry: task("task_grant_required", "open", "task:grant", { detail: "grant_required" }),
    de: "Die Aufgabe „Rechnungen nachfassen“ darf noch nicht alleine starten.",
    en: "The task “Rechnungen nachfassen” may not start on its own yet.",
    actionDe: "Erlauben",
    actionEn: "Allow",
    shortDe: "Darf nicht alleine starten",
    badgeDe: "Wartet auf Erlaubnis",
  },
  {
    entry: task("task_grant_expiring", "renew", "task:grant"),
    de: "Die Aufgabe „Rechnungen nachfassen“ verliert bald die Dauererlaubnis.",
    en: "The task “Rechnungen nachfassen” will soon lose its standing permission.",
    actionDe: "Erneuern",
    actionEn: "Renew",
    shortDe: "Die Dauererlaubnis endet bald",
    badgeDe: "Erlaubnis läuft ab",
  },
  {
    entry: task("task_run_failed", "open", "task:read", { detail: "turn_failed" }),
    de: "Die Aufgabe „Rechnungen nachfassen“ ist fehlgeschlagen.",
    en: "The task “Rechnungen nachfassen” failed.",
    actionDe: "Ansehen",
    actionEn: "View",
    shortDe: "Der letzte Run ist fehlgeschlagen",
    badgeDe: "Fehlgeschlagen",
  },
  {
    entry: task("task_owner_unavailable", "open", "task:resume", {
      detail: "owner_unavailable",
    }),
    de: "Die Aufgabe „Rechnungen nachfassen“ wurde automatisch pausiert, weil die Person dahinter nicht mehr dabei ist.",
    en: "The task “Rechnungen nachfassen” was paused automatically because the person it belongs to has left.",
    actionDe: "Fortsetzen",
    actionEn: "Resume",
    shortDe: "Automatisch pausiert, die Person fehlt",
    badgeDe: "Automatisch pausiert",
  },
];

describe("a task that needs a person", () => {
  for (const each of CASES) {
    const name = `${each.entry.reason}${each.entry.detail ? ` (${each.entry.detail})` : ""}`;
    test(`${name} is one sentence with one action, in both languages`, () => {
      const [primary] = each.entry.actions;
      if (!primary) throw new Error("fixture without an action");
      expect(sentenceText(attentionSentence(each.entry, de, NOW))).toBe(each.de);
      expect(sentenceText(attentionSentence(each.entry, en, NOW))).toBe(each.en);
      expect(attentionSentence(each.entry, de, NOW).machine).toBeNull();
      expect(each.entry.actions).toHaveLength(1);
      expect(de(actionLabelKey(primary, each.entry))).toBe(each.actionDe);
      expect(en(actionLabelKey(primary, each.entry))).toBe(each.actionEn);
      const row = attentionRow(each.entry, de);
      expect(row).toMatchObject({
        name: "Rechnungen nachfassen",
        reason: each.shortDe,
        machine: null,
      });
      expect(de(row.badge.label)).toBe(each.badgeDe);
      expect(attentionRow(each.entry, en).machine).toBeNull();
    });
  }

  test("every entry leads to the task and never opens the workflow review sheet", () => {
    for (const each of CASES) {
      const [primary] = each.entry.actions;
      if (!primary) throw new Error("fixture without an action");
      expect(routerPath(primary.href)).toBe(taskHref(W));
      expect(opensReviewSheet(each.entry, primary)).toBe(false);
    }
  });

  test("signing in again stays the word for a connection, not for a task", () => {
    const connection = item({
      kind: "connection",
      subject: { kind: "connection", id: W, name: "Postfach" },
      reason: "refresh_failed",
    });
    expect(de(actionLabelKey(action("renew", "connection:write"), connection))).toBe(
      "Neu anmelden",
    );
  });

  test("the source has a name when it cannot be read", () => {
    expect(sourceLabel("tasks", de)).toBe("Aufgaben");
    expect(sourceLabel("tasks", en)).toBe("tasks");
  });
});
