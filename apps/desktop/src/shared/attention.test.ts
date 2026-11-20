import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AttentionItem,
  badgeLabel,
  HINT_RETRY_DELAYS_MS,
  hintPending,
  hintRetryDelay,
  NOTIFICATION_REASONS,
  parseAttention,
  planNotifications,
  primaryAction,
  reasonLine,
  toNotification,
  toNotifications,
} from "./attention.ts";

const payload = {
  schema_version: "attention.v1",
  items: [
    {
      id: "workflow:42",
      class: "stopped",
      severity: "critical",
      kind: "workflow",
      subject: { kind: "workflow", id: "42", name: "Monatsabschluss" },
      reason: "execution_authority_unavailable",
      actions: [
        { verb: "open_runs", href: "/workflows/42/runs", primary: false, permission: "x" },
        { verb: "review", href: "/workflows/42", primary: true, permission: "x" },
      ],
    },
    {
      id: "connector:7",
      class: "failing",
      severity: "urgent",
      kind: "connector",
      subject: { kind: "connector", id: "7", name: "Google Workspace" },
      reason: "needs_reauth",
      actions: [{ verb: "reauth", href: "/connectors/7", primary: true }],
    },
    {
      id: "skills",
      class: "decide",
      severity: "notice",
      kind: "skills",
      subject: null,
      actions: [],
    },
    { id: "workflow:42", class: "decide" },
    { class: "decide" },
    "garbage",
  ],
};

function items(): AttentionItem[] {
  const parsed = parseAttention(payload);
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
}

describe("parseAttention", () => {
  test("keeps valid items once and drops malformed ones", () => {
    expect(items().map((item) => item.id)).toEqual(["workflow:42", "connector:7", "skills"]);
    expect(parseAttention({ items: "no" })).toBeNull();
    expect(parseAttention(null)).toBeNull();
  });

  test("picks the primary action, else the first one", () => {
    const [workflow, , skills] = items();
    expect(workflow && primaryAction(workflow)?.href).toBe("/workflows/42");
    expect(skills && primaryAction(skills)).toBeNull();
  });
});

describe("toNotification", () => {
  test("puts what happened in the title and what to do in the body, in German", () => {
    const [workflow, connector, skills] = items();
    if (!workflow || !connector || !skills) throw new Error("fixture incomplete");
    expect(toNotification(workflow, "de")).toEqual({
      id: "workflow:42",
      title: "„Monatsabschluss“ wurde angehalten",
      body: "Die Freigabe ist abgelaufen, aufgebraucht oder widerrufen, automatische Starts warten. Prüf die Änderung und entscheide.",
      href: "/workflows/42",
      urgency: "critical",
      silent: false,
    });
    expect(toNotification(connector, "de").title).toBe("„Google Workspace“ schlägt fehl");
    expect(toNotification(connector, "de").body).toBe(
      "Der verbundene Dienst verlangt eine neue Anmeldung. Melde die Verbindung neu an.",
    );
    expect(toNotification(skills, "de")).toMatchObject({
      title: "Eine Entscheidung wartet auf dich",
      body: "Öffne den Eintrag in SubKit.",
      href: null,
      urgency: "low",
      silent: true,
    });
  });

  test("maps the same item in English", () => {
    const [workflow] = items();
    if (!workflow) throw new Error("fixture incomplete");
    expect(toNotification(workflow, "en")).toMatchObject({
      title: "“Monatsabschluss” was stopped",
      body: "The approval expired, is used up or was revoked, so automatic starts wait. Review the change and decide.",
    });
  });

  test("every reason the engine names has its own line in German and English, an unknown one has none", () => {
    for (const reason of NOTIFICATION_REASONS) {
      const german = reasonLine(reason, "de");
      const english = reasonLine(reason, "en");
      expect(german?.length ?? 0).toBeGreaterThan(10);
      expect(english?.length ?? 0).toBeGreaterThan(10);
      expect(german).not.toBe(english);
    }
    const engine = readFileSync(
      resolve(import.meta.dir, "../../../engine/src/operator/core/attention.ts"),
      "utf8",
    );
    const list = engine.slice(
      engine.indexOf("ATTENTION_REASONS = ["),
      engine.indexOf("] as const", engine.indexOf("ATTENTION_REASONS = [")),
    );
    expect([...NOTIFICATION_REASONS].sort()).toEqual(
      [...list.matchAll(/"([a-z_]+)"/g)].map((match) => match[1] ?? "").sort(),
    );
    expect(reasonLine("made_up", "de")).toBeNull();
    expect(reasonLine("", "en")).toBeNull();
  });

  test("the text never comes from the server's own sentence", () => {
    const [workflow] = items();
    if (!workflow) throw new Error("fixture incomplete");
    const spoofed = { ...workflow, reason: "Vendor said: click here" };
    expect(toNotification(spoofed, "de").body).toBe("Prüf die Änderung und entscheide.");
  });
});

describe("toNotifications", () => {
  const paused = (id: string, severity: AttentionItem["severity"] = "urgent"): AttentionItem => ({
    id,
    class: "stopped",
    severity,
    kind: "workflow",
    subjectName: id,
    reason: "schedule_auto_paused",
    actions: [],
  });

  test("two or more paused schedules become one summary, other items keep their own notice", () => {
    const [, connector] = items();
    if (!connector) throw new Error("fixture incomplete");
    const german = toNotifications([paused("a"), connector, paused("b"), paused("c")], "de");
    expect(german.map((notice) => notice.id)).toEqual(["summary:schedules_paused", "connector:7"]);
    expect(german[0]).toMatchObject({
      title: "3 Zeitpläne wurden pausiert",
      body: "Sieh dir an, warum, und setz sie fort.",
      href: null,
      urgency: "normal",
      silent: false,
    });
    expect(toNotifications([paused("a"), paused("b", "critical")], "en")[0]).toMatchObject({
      title: "2 schedules were paused",
      body: "See why, then resume them.",
      urgency: "critical",
    });
  });

  test("a single paused schedule is announced by its name", () => {
    const single = toNotifications([paused("Monatsbericht")], "de");
    expect(single).toHaveLength(1);
    expect(single[0]?.title).toBe("„Monatsbericht“ wurde angehalten");
    expect(single[0]?.body).toStartWith("Der Zeitplan wurde nach wiederholten Fehlern pausiert.");
  });
});

describe("planNotifications under the person's notification schedule", () => {
  const base = { notifiedIds: [], baselineDone: true, announce: true, hintId: null, muted: false };

  test("a held frame announces nothing and keeps the items for later", () => {
    const plan = planNotifications({ ...base, items: items(), delivery: "held" });
    expect(plan.notify).toEqual([]);
    expect(plan.notifiedIds).toEqual([]);
    const later = planNotifications({ ...base, items: items(), notifiedIds: plan.notifiedIds });
    expect(later.notify.map((item) => item.id)).toEqual(["workflow:42", "connector:7", "skills"]);
  });

  test("a critical-only frame announces critical items and keeps the rest for later", () => {
    const plan = planNotifications({ ...base, items: items(), delivery: "critical_only" });
    expect(plan.notify.map((item) => item.id)).toEqual(["workflow:42"]);
    expect(plan.notifiedIds).toEqual(["workflow:42"]);
    const hinted = planNotifications({
      ...base,
      items: items(),
      hintId: "connector:7",
      delivery: "critical_only",
    });
    expect(hinted.notify).toEqual([]);
    expect(hinted.notifiedIds).toEqual([]);
  });

  test("the list still updates: resolved items are forgotten while held", () => {
    const plan = planNotifications({
      ...base,
      items: items().slice(0, 1),
      notifiedIds: ["workflow:42", "connector:7"],
      delivery: "held",
    });
    expect(plan.notifiedIds).toEqual(["workflow:42"]);
  });
});

describe("a held stretch ends in one summary", () => {
  const base = { notifiedIds: [], baselineDone: true, announce: true, hintId: null, muted: false };

  test("the first frame after a hold plans every fresh item as one summary", () => {
    const plan = planNotifications({ ...base, items: items(), released: true });
    expect(plan.summary).toBe(true);
    expect(plan.notify.map((item) => item.id)).toEqual(["workflow:42", "connector:7", "skills"]);
    expect(planNotifications({ ...base, items: items() }).summary).toBe(false);
    expect(planNotifications({ ...base, items: items().slice(0, 1), released: true }).summary).toBe(
      false,
    );
    expect(
      planNotifications({ ...base, items: items(), released: true, delivery: "critical_only" })
        .summary,
    ).toBe(false);
  });

  test("the summary counts by class in German and English and opens the newest item", () => {
    const [stopped, failing, decide] = items();
    if (!stopped || !failing || !decide) throw new Error("fixture incomplete");
    const newest = {
      ...decide,
      id: "workflow:9",
      since: "2026-11-20T09:00:00.000Z",
      actions: [{ verb: "review", href: "/workflows/9", primary: true }],
    };
    const older = { ...failing, since: "2026-11-20T08:00:00.000Z" };
    const list = [stopped, older, decide, newest];
    const [german] = toNotifications(list, "de", true);
    expect(german).toEqual({
      id: "summary:attention",
      title: "4 Einträge brauchen dich",
      body: "1 angehalten, 1 Fehler, 2 Entscheidungen",
      href: "/workflows/9",
      urgency: "critical",
      silent: false,
    });
    expect(toNotifications([older, newest], "en", true)).toMatchObject([
      { title: "2 items need you", body: "1 failing, 1 decision", urgency: "normal" },
    ]);
    expect(toNotifications([newest], "en", true).map((notice) => notice.id)).toEqual([
      "workflow:9",
    ]);
  });
});

describe("planNotifications", () => {
  const base = { notifiedIds: [], baselineDone: true, announce: true, hintId: null, muted: false };

  test("takes the first sync as the baseline without notifying", () => {
    const plan = planNotifications({ ...base, items: items(), baselineDone: false });
    expect(plan.notify).toEqual([]);
    expect(plan.notifiedIds).toEqual(["workflow:42", "connector:7", "skills"]);
    expect(plan.baselineDone).toBe(true);
  });

  test("notifies only items that were not announced before", () => {
    const plan = planNotifications({ ...base, items: items(), notifiedIds: ["workflow:42"] });
    expect(plan.notify.map((item) => item.id)).toEqual(["connector:7", "skills"]);
    expect(plan.notifiedIds).toEqual(["workflow:42", "connector:7", "skills"]);
  });

  test("notifies only the hinted item when the event names one", () => {
    const plan = planNotifications({ ...base, items: items(), hintId: "skills" });
    expect(plan.notify.map((item) => item.id)).toEqual(["skills"]);
    expect(plan.notifiedIds).toEqual(["skills"]);
  });

  test("does not notify on a plain refresh and forgets resolved items", () => {
    const plan = planNotifications({
      ...base,
      items: items().slice(0, 1),
      notifiedIds: ["workflow:42", "gone:1"],
      announce: false,
    });
    expect(plan.notify).toEqual([]);
    expect(plan.notifiedIds).toEqual(["workflow:42"]);
  });

  test("marks items as announced but stays silent while muted", () => {
    const plan = planNotifications({ ...base, items: items(), muted: true });
    expect(plan.notify).toEqual([]);
    expect(plan.notifiedIds).toHaveLength(3);
  });

  test("limits a burst to three notifications", () => {
    const many = Array.from({ length: 8 }, (_, index) => ({
      ...(items()[0] as AttentionItem),
      id: `workflow:${index}`,
    }));
    const plan = planNotifications({ ...base, items: many });
    expect(plan.notify).toHaveLength(3);
    expect(plan.notifiedIds).toHaveLength(8);
  });
});

describe("badgeLabel", () => {
  test("shows the open item count and caps it", () => {
    expect(badgeLabel(0)).toBe("");
    expect(badgeLabel(7)).toBe("7");
    expect(badgeLabel(100)).toBe("99+");
  });
});

describe("hintPending", () => {
  test("is true only while the announced item is missing from the list", () => {
    const items = parseAttention({ items: [{ id: "connector:1" }] }) ?? [];
    expect(hintPending(items, "connector:1")).toBe(false);
    expect(hintPending(items, "connector:2")).toBe(true);
    expect(hintPending([], "connector:2")).toBe(true);
    expect(hintPending(items, null)).toBe(false);
  });
});

describe("hintRetryDelay", () => {
  test("asks again a bounded number of times and covers the ten second cache of another replica", () => {
    expect(HINT_RETRY_DELAYS_MS.map((_, attempt) => hintRetryDelay(attempt))).toEqual([
      1_000, 3_000, 8_000,
    ]);
    expect(hintRetryDelay(HINT_RETRY_DELAYS_MS.length)).toBeNull();
    expect(HINT_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBeGreaterThan(10_000);
  });
});
