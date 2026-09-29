import { describe, expect, test } from "bun:test";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  type Attention,
  type AttentionItem,
  actionLabelKey,
  attentionBadge,
  attentionEntries,
  attentionSentence,
  entryActions,
  entrySnapshot,
  overviewSections,
  overviewView,
  type ReviewHistory,
  reviewAccess,
  reviewNavigation,
  reviewTarget,
  sentenceText,
  settleHidden,
  sinceLabel,
  statusLine,
} from "./overview-model";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);
const en = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("en", key, values);

const NOW = Date.parse("2026-09-28T12:00:00.000Z");
const W = "018f4b4a-6d33-7b3a-9c2d-123456789abc";
const daysAgo = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

function item(overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id: `workflow:${W}`,
    class: "failing",
    severity: "urgent",
    kind: "workflow",
    subject: { kind: "workflow", id: W, name: "Monatsbericht" },
    reason: "failing",
    cause_class: null,
    counts: {},
    since: daysAgo(3),
    deadline: null,
    detail: null,
    actions: [],
    ...overrides,
  };
}

const ANSWERED: Attention["sources"] = {
  conversations: "answered",
  schedules: "answered",
  freshness: "answered",
  failures: "answered",
  patches: "answered",
  connectors: "answered",
  connections: "answered",
  secret_approvals: "answered",
  skills: "answered",
  budget: "answered",
  risk: "answered",
};

function attention(overrides: Partial<Attention> = {}): Attention {
  return {
    schema_version: "attention.v1",
    generated_at: new Date(NOW).toISOString(),
    sources: ANSWERED,
    status: { health_state: "healthy", next_run_at: "2026-09-28T13:00:00.000Z" },
    items: [],
    ...overrides,
  };
}

describe("the sentence", () => {
  test("names the subject, the reason and since when", () => {
    const text = sentenceText(attentionSentence(item(), de, NOW));
    expect(text).toBe("Der Workflow „Monatsbericht“ scheitert — seit 3 Tagen.");
    expect(sentenceText(attentionSentence(item(), en, NOW))).toBe(
      "The workflow “Monatsbericht” is failing — for 3 days.",
    );
  });

  test("a failing workflow says how often, why, and that a fix waits", () => {
    const text = sentenceText(
      attentionSentence(
        item({ cause_class: "auth_failed", counts: { failures: 12, patches: 2 } }),
        de,
        NOW,
      ),
    );
    expect(text).toBe(
      "Der Workflow „Monatsbericht“ ist 12-mal gescheitert: Anmeldung abgelehnt; 2 Korrekturen liegen bereit — seit 3 Tagen.",
    );
  });

  test("every reason the engine names has its own words, in both languages", () => {
    const reasons: AttentionItem["reason"][] = [
      "awaiting_answer",
      "execution_authority_required",
      "execution_authority_unavailable",
      "failing",
      "patch_proposed",
      "needs_reauth",
      "needs_update",
      "degraded",
      "unhealthy",
      "refresh_refused",
      "refresh_failed",
      "expired_no_refresh",
      "secret_unreadable",
      "secret_prepared",
      "skills_proposed",
      "budget_critical",
    ];
    for (const reason of reasons) {
      for (const t of [de, en]) {
        const sentence = attentionSentence(item({ reason }), t, NOW);
        expect(sentence.machine, reason).toBeNull();
        expect(sentence.lead, reason).not.toContain("{");
        // No machine value leaks into the words: no snake_case anywhere.
        expect(sentence.lead, reason).not.toMatch(/[a-z]+_[a-z_]+/);
      }
    }
    expect(
      sentenceText(
        attentionSentence(
          item({ reason: "scheduler_stale", kind: "self_healing.drift_scan", subject: null }),
          de,
          NOW,
        ),
      ),
    ).toBe("Der Drift-Scan läuft nicht mehr — seit 3 Tagen.");
    expect(
      attentionSentence(
        item({ reason: "risk_critical", kind: "memory_high_water", subject: null, since: null }),
        de,
        NOW,
      ),
    ).toEqual({
      lead: "Kritisches Betriebssignal: Arbeitsspeicher fast voll",
      machine: null,
      since: null,
    });
    expect(
      sentenceText(
        attentionSentence(
          item({ id: "skills", reason: "skills_proposed", subject: null, counts: { skills: 4 } }),
          de,
          NOW,
        ),
      ),
    ).toBe("4 Skill-Vorschläge warten auf deine Entscheidung — seit 3 Tagen.");
  });

  test("a reason this build does not know keeps the subject and shows the engine's value, marked", () => {
    const sentence = attentionSentence(
      item({ reason: "quota_frozen" as AttentionItem["reason"] }),
      de,
      NOW,
    );
    expect(sentence.lead).toBe("Der Workflow „Monatsbericht“ braucht dich");
    expect(sentence.machine).toBe("quota_frozen");
    expect(sentenceText(sentence)).toBe(
      "Der Workflow „Monatsbericht“ braucht dich (quota_frozen) — seit 3 Tagen.",
    );
    const unknownCause = attentionSentence(
      item({ cause_class: "rate_limited" as AttentionItem["cause_class"] }),
      de,
      NOW,
    );
    expect(unknownCause.machine).toBe("rate_limited");
    // An unknown signal is named as the engine named it, never as "unbekannt".
    const signal = attentionSentence(
      item({ reason: "risk_critical", kind: "disk_full", subject: null }),
      de,
      NOW,
    );
    expect(signal.machine).toBe("disk_full");
    expect(sentenceText(signal).toLowerCase()).not.toContain("unbekannt");
  });

  test("a subject without a name is said, not left blank", () => {
    const text = sentenceText(
      attentionSentence(
        item({
          subject: { kind: "connection", id: "c", name: null },
          reason: "expired_no_refresh",
        }),
        de,
        NOW,
      ),
    );
    expect(text).toBe("Die Verbindung (ohne Namen) ist abgelaufen — seit 3 Tagen.");
  });

  test("the engine's residual wording is not part of the list sentence", () => {
    const text = sentenceText(
      attentionSentence(item({ detail: "HTTP 401 from upstream" }), de, NOW),
    );
    expect(text).not.toContain("HTTP 401");
  });

  test("since when, in the coarsest honest unit", () => {
    const at = (ms: number) => new Date(NOW - ms).toISOString();
    expect(sinceLabel(null, NOW, de)).toBeNull();
    expect(sinceLabel("not a date", NOW, de)).toBeNull();
    expect(sinceLabel(at(20_000), NOW, de)).toBe("seit gerade eben");
    expect(sinceLabel(at(60_000), NOW, de)).toBe("seit 1 Minute");
    expect(sinceLabel(at(5 * 3_600_000), NOW, de)).toBe("seit 5 Stunden");
    expect(sinceLabel(at(86_400_000), NOW, de)).toBe("seit 1 Tag");
    expect(sinceLabel(at(20 * 86_400_000), NOW, de)).toBe("seit 2 Wochen");
    expect(sinceLabel(at(90 * 86_400_000), NOW, de)).toBe("seit 3 Monaten");
    expect(sinceLabel(at(5 * 3_600_000), NOW, en)).toBe("for 5 hours");
  });
});

describe("the list", () => {
  test("keeps the engine's order", () => {
    const items = [
      item({
        id: "conversation:c",
        class: "stopped",
        subject: { kind: "conversation", id: "c", name: "A" },
      }),
      item({ id: "skills", class: "decide", subject: null }),
      item({ id: `workflow:${W}`, class: "failing" }),
    ];
    // Deliberately not re-sorted: the engine orders stopped → failing → decide
    // with deadlines and age inside, and a second sort here would be a second
    // rule to keep in step.
    expect(attentionEntries(items).map((entry) => entry.id)).toEqual([
      "conversation:c",
      "skills",
      `workflow:${W}`,
    ]);
  });

  test("holds one entry per subject, the first one winning", () => {
    const items = [
      item({ id: `workflow:${W}`, class: "stopped" }),
      item({ id: `workflow:${W}#again`, class: "decide" }),
      item({ id: "connector:x", subject: { kind: "connector", id: "x", name: "CRM" } }),
    ];
    expect(attentionEntries(items).map((entry) => entry.id)).toEqual([
      `workflow:${W}`,
      "connector:x",
    ]);
  });

  test("each entry has exactly one primary action and at most one secondary", () => {
    const entry = item({
      actions: [
        { verb: "open_runs", href: "/cockpit/runs", primary: false, permission: "execution:read" },
        {
          verb: "review",
          href: `/cockpit?review=workflow:${W}`,
          primary: true,
          permission: "workflow:write",
        },
        {
          verb: "chat",
          href: "/cockpit/chat/new",
          primary: false,
          permission: "conversation:write",
        },
      ],
    });
    const { primary, secondary } = entryActions(entry);
    expect(primary?.verb).toBe("review");
    expect(secondary?.verb).toBe("open_runs");
    expect(de(actionLabelKey(primary!, entry))).toBe("Prüfen");
  });
});

describe("the page state", () => {
  test("calm only when nothing is open and every readable source answered", () => {
    const view = overviewView(attention());
    expect(view.kind).toBe("calm");
    if (view.kind === "calm")
      expect(statusLine(view.status, de, () => "28.09.2026, 13:00")).toBe(
        "Gesund · nächste geplante Ausführung 28.09.2026, 13:00",
      );
  });

  test("a failed source is never an empty answer", () => {
    const view = overviewView(attention({ sources: { ...ANSWERED, connectors: "failed" } }));
    expect(view).toEqual({ kind: "unread", unread: ["connectors"] });
  });

  test("a source the reader may not read is simply absent", () => {
    const view = overviewView(
      attention({
        sources: { ...ANSWERED, secret_approvals: "not_permitted", risk: "not_permitted" },
      }),
    );
    expect(view.kind).toBe("calm");
  });

  test("with entries, a failed source is still named beside them", () => {
    const view = overviewView(
      attention({ sources: { ...ANSWERED, skills: "failed" }, items: [item()] }),
    );
    expect(view.kind).toBe("items");
    if (view.kind === "items") expect(view.unread).toEqual(["skills"]);
  });

  test("nothing readable at all is its own state, not calm", () => {
    const sources = Object.fromEntries(
      Object.keys(ANSWERED).map((key) => [key, "not_permitted"]),
    ) as Attention["sources"];
    expect(overviewView(attention({ sources, status: null })).kind).toBe("nothing_readable");
  });

  test("no status line for a reader the engine sends no status", () => {
    expect(statusLine(null, de, String)).toBeNull();
    expect(statusLine({ health_state: "limited", next_run_at: null }, de, String)).toBe(
      "Eingeschränkt · keine Ausführung geplant",
    );
  });

  test("an entry decided in this tab stays away while the engine still lists it", () => {
    const decided = item();
    const view = overviewView(
      attention({ items: [decided] }),
      new Map([[decided.id, entrySnapshot(decided)]]),
    );
    expect(view.kind).toBe("calm");
  });
});

describe("the badge", () => {
  test("is the number of entries, red when anything is stopped, absent at zero", () => {
    expect(attentionBadge(undefined)).toBeNull();
    expect(attentionBadge(attention())).toBeNull();
    expect(
      attentionBadge(
        attention({ items: [item(), item({ id: "skills", subject: null, class: "decide" })] }),
      ),
    ).toEqual({
      count: 2,
      stopped: false,
    });
    expect(attentionBadge(attention({ items: [item({ class: "stopped" })] }))).toEqual({
      count: 1,
      stopped: true,
    });
  });

  test("counts what the list shows — one per subject, hidden entries left out", () => {
    const listed = attention({
      items: [item(), item({ id: `workflow:${W}#dup` }), item({ id: "skills", subject: null })],
    });
    const view = overviewView(listed);
    expect(attentionBadge(listed)?.count).toBe(view.kind === "items" ? view.items.length : -1);
    const skills = listed.items[2] as AttentionItem;
    expect(attentionBadge(listed, new Map([["skills", entrySnapshot(skills)]]))?.count).toBe(1);
  });
});

describe("the review sheet", () => {
  test("knows which decisions an entry id holds", () => {
    expect(reviewTarget(`workflow:${W}`)).toEqual({ kind: "workflow", workflowId: W });
    expect(reviewTarget("skills")).toEqual({ kind: "skills" });
    expect(reviewTarget("connector:x")).toEqual({ kind: "other" });
    expect(reviewTarget("workflow:not-a-uuid")).toEqual({ kind: "other" });
  });
});

describe("an entry decided in this tab", () => {
  // A failing workflow with one open fix: its primary action is the review.
  const withFix = item({
    counts: { failures: 3, patches: 1 },
    actions: [
      {
        verb: "review",
        href: `/cockpit?review=workflow:${W}`,
        primary: true,
        permission: "workflow:write",
      },
      { verb: "open_runs", href: "/cockpit/runs", primary: false, permission: "execution:read" },
    ],
  });
  // The same workflow once the fix is decided: still failing, now a chat.
  const stillFailing = item({
    counts: { failures: 3 },
    actions: [
      { verb: "chat", href: "/cockpit/chat/new", primary: true, permission: "conversation:write" },
      { verb: "open_runs", href: "/cockpit/runs", primary: false, permission: "execution:read" },
    ],
  });
  const hidden = new Map([[withFix.id, entrySnapshot(withFix)]]);

  test("stays hidden while the engine still lists it unchanged", () => {
    expect(overviewView(attention({ items: [withFix] }), hidden).kind).toBe("calm");
    expect(settleHidden(hidden, [withFix])).toBe(hidden);
  });

  test("is back at once when the engine lists the same subject as a different task", () => {
    // Deciding the last fix of a failing workflow does not end the task.
    const view = overviewView(attention({ items: [stillFailing] }), hidden);
    expect(view.kind).toBe("items");
    if (view.kind === "items") expect(view.items[0]?.actions[0]?.verb).toBe("chat");
    expect(attentionBadge(attention({ items: [stillFailing] }), hidden)?.count).toBe(1);
    expect(settleHidden(hidden, [stillFailing]).size).toBe(0);
  });

  test("is forgotten once the engine no longer lists it", () => {
    expect(settleHidden(hidden, []).size).toBe(0);
  });
});

describe("what a review sheet may show", () => {
  test("a workflow's fixes need workflow:read, skill proposals skill:read", () => {
    const workflow = reviewTarget(`workflow:${W}`);
    expect(reviewAccess(workflow, ["workflow:read"])).toBe("readable");
    expect(reviewAccess(workflow, ["conversation:read", "stats:read"])).toBe("not_permitted");
    expect(reviewAccess(reviewTarget("skills"), ["skill:read"])).toBe("readable");
    expect(reviewAccess(reviewTarget("skills"), ["workflow:read"])).toBe("not_permitted");
  });

  test("any other entry has nothing to review in the sheet", () => {
    expect(reviewAccess(reviewTarget("connector:x"), ["connector:read"])).toBe("nothing");
    expect(reviewAccess(reviewTarget("workflow:stale"), ["workflow:read"])).toBe("nothing");
  });
});

/** A browser history, small enough to reason about. */
function fakeHistory() {
  const entries: { url: string; state: unknown }[] = [{ url: "/cockpit", state: null }];
  let index = 0;
  const history: ReviewHistory & { entries: typeof entries; url: () => string } = {
    entries,
    url: () => entries[index]?.url ?? "",
    get state() {
      return entries[index]?.state ?? null;
    },
    pushState(state, _unused, url) {
      entries.splice(index + 1);
      entries.push({ url, state });
      index += 1;
    },
    replaceState(state, _unused, url) {
      entries[index] = { url, state };
    },
    back() {
      index = Math.max(0, index - 1);
    },
  };
  return history;
}

describe("the review sheet and Back", () => {
  const href = (review: string | null) => (review ? `/cockpit?review=${review}` : "/cockpit");

  test("open then close leaves the history as it was — Back never reopens the sheet", () => {
    const history = fakeHistory();
    const navigation = reviewNavigation(history, href);
    navigation.open("skills");
    expect(history.url()).toBe("/cockpit?review=skills");
    navigation.close();
    expect(history.url()).toBe("/cockpit");
    // Nothing ahead of the reader but the closed sheet, and nothing behind.
    expect(history.entries.slice(0, 1).map((entry) => entry.url)).toEqual(["/cockpit"]);
    history.back();
    expect(history.url()).toBe("/cockpit");
  });

  test("a sheet that arrived by link closes in place", () => {
    const history = fakeHistory();
    history.replaceState(null, "", "/cockpit?review=skills");
    reviewNavigation(history, href).close();
    expect(history.url()).toBe("/cockpit");
    expect(history.entries).toHaveLength(1);
  });
});

describe("what the Übersicht holds", () => {
  const all = { operations: true, history: true };

  test("the operations bar stands first when nothing is open — it is not a task, it stays", () => {
    expect(overviewSections(overviewView(attention()), all)).toEqual([
      "operations",
      "calm",
      "history",
    ]);
  });

  test("the operations bar stands first over the attention list", () => {
    expect(overviewSections(overviewView(attention({ items: [item()] })), all)).toEqual([
      "operations",
      "attention",
      "history",
    ]);
    const unread = overviewView(
      attention({ items: [item()], sources: { ...ANSWERED, connectors: "failed" } }),
    );
    expect(overviewSections(unread, all)).toEqual(["operations", "attention", "unread", "history"]);
  });

  test("a failed source is named, never 'all done', and the bar still stands", () => {
    const view = overviewView(attention({ sources: { ...ANSWERED, connectors: "failed" } }));
    expect(overviewSections(view, all)).toEqual(["operations", "unread", "history"]);
  });

  test("no bar for a reader who may not read the figures, no history link without audit", () => {
    expect(
      overviewSections(overviewView(attention()), { operations: false, history: false }),
    ).toEqual(["calm"]);
  });
});
