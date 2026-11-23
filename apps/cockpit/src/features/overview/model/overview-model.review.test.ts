import { describe, expect, test } from "bun:test";
import { routerTarget } from "@/app/links";
import { reviewAccess, reviewSettles, reviewTarget } from "./attention-navigation";
import {
  type Attention,
  type AttentionItem,
  attentionBadge,
  attentionEntries,
  entryActions,
  entrySnapshot,
  overviewSections,
  overviewView,
  settleHidden,
} from "./attention-projection";
import {
  actionLabelKey,
  opensReviewSheet,
  type ReviewHistory,
  reviewForward,
  reviewNavigation,
  statusLine,
} from "./overview-model";
import { de, item, NOW, W } from "./overview-model-fixtures.ts";

const ANSWERED: Attention["sources"] = {
  conversations: "answered",
  schedules: "answered",
  freshness: "answered",
  failures: "answered",
  patches: "answered",
  connectors: "answered",
  connections: "answered",
  secret_approvals: "answered",
  knowledge: "answered",
  skills: "answered",
  intake: "answered",
  budget: "answered",
  ai_access: "answered",
  risk: "answered",
  tasks: "answered",
};

function attention(overrides: Partial<Attention> = {}): Attention {
  return {
    schema_version: "attention.v1",
    generated_at: new Date(NOW).toISOString(),
    sources: ANSWERED,
    status: { health_state: "healthy", next_run_at: "2026-09-28T13:00:00.000Z" },
    items: [],
    snoozed: [],
    ...overrides,
  };
}

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
        "Gesund · nächster geplanter Run 28.09.2026, 13:00",
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
      "Eingeschränkt · kein Run geplant",
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

  const intakeReview = {
    verb: "review",
    href: "/cockpit/intake?category=all",
    primary: true,
    permission: "intake:read",
  } as const;
  const collected = item({
    id: "intake",
    reason: "intake_collected",
    subject: null,
    counts: { intake: 12 },
    actions: [intakeReview],
  });
  const workflowReview = {
    verb: "review",
    href: `/cockpit?review=workflow:${W}`,
    primary: true,
    permission: "workflow:write",
  } as const;

  test("collected material is reviewed in the Inbox, not in the sheet", () => {
    expect(opensReviewSheet(collected, intakeReview)).toBe(false);
    expect(routerTarget(intakeReview.href)).toEqual({
      to: "/intake",
      search: { category: "all" },
    });
  });

  test("workflow fixes and skill proposals still open the sheet", () => {
    expect(opensReviewSheet(item({ actions: [workflowReview] }), workflowReview)).toBe(true);
    const skills = { ...workflowReview, href: "/cockpit?review=skills" };
    expect(opensReviewSheet(item({ id: "skills", actions: [skills] }), skills)).toBe(true);
  });

  test("an empty sheet leads on to where the entry is handled", () => {
    expect(reviewForward(intakeReview, "nothing")).toBe(intakeReview);
    const chat = { ...intakeReview, verb: "chat", href: "/cockpit/chat/new" } as const;
    expect(reviewForward(chat, "not_permitted")).toBe(chat);
    expect(reviewForward(chat, "readable")).toBe(chat);
  });

  test("an empty sheet offers no link back to itself or past a missing permission", () => {
    expect(reviewForward(workflowReview, "nothing")).toBeNull();
    expect(reviewForward(intakeReview, "not_permitted")).toBeNull();
    expect(reviewForward(intakeReview, "readable")).toBeNull();
    expect(reviewForward(null, "nothing")).toBeNull();
  });
});

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

describe("the review closes when its last item is decided", () => {
  const settles = (
    openBefore: number | null,
    openNow: number,
    listedBefore = true,
    listedNow = true,
  ) => reviewSettles({ openBefore, openNow, listedBefore, listedNow });

  test("a review that had items and now has none closes", () => {
    expect(settles(1, 0)).toBe(true);
    expect(settles(3, 0)).toBe(true);
  });

  test("a review decided elsewhere closes once its entry leaves the list", () => {
    expect(settles(0, 0, true, false)).toBe(true);
    expect(settles(null, 0, true, false)).toBe(true);
  });

  test("a review opened on nothing stays, so it can say so and point elsewhere", () => {
    expect(settles(null, 0, false, false)).toBe(false);
    expect(settles(0, 0)).toBe(false);
  });

  test("a review with items left stays open", () => {
    expect(settles(2, 1)).toBe(false);
    expect(settles(null, 2, true, false)).toBe(false);
  });
});
