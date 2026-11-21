import { describe, expect, test } from "bun:test";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  CHIP_STARTERS,
  type ChatStarter,
  chatStarters,
  MAX_STARTERS,
  MIN_STARTERS,
  retryStarterQuery,
  type StarterSources,
  starterChips,
  starterGates,
  startersVisible,
} from "./start-model";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);

const EMPTY: StarterSources = {
  attention: [],
  usage: false,
  intake: null,
  solutions: [],
  knowledge: [],
  categories: [],
};

const FULL: StarterSources = {
  attention: [
    { class: "decide", subject: { kind: "workflow", id: "w0", name: "nightly-sync" } },
    { class: "failing", subject: { kind: "connector", id: "c1", name: "wiki" } },
    {
      class: "failing",
      subject: { kind: "workflow", id: "w1", name: "growth-report" },
      counts: { consecutive_failures: 2 },
    },
    { class: "failing", subject: { kind: "workflow", id: "w2", name: "late-report" } },
  ],
  usage: true,
  solutions: [
    {
      slug: "invoice-attachments-to-drive",
      title: "Rechnungen aus Gmail ablegen",
      line: "Legt PDF-Rechnungen ab.",
      needs: "Gmail und Google Drive",
      ready: false,
    },
    {
      slug: "webhook-to-slack",
      title: "Webhook meldet in Slack",
      line: "Meldet Wichtiges.",
      needs: "Slack",
      ready: true,
    },
  ],
  knowledge: [
    { slug: "runbook", name: "Runbook" },
    { slug: "handbook", name: "Handbuch" },
  ],
  categories: [
    { category: "reports", count: 4 },
    { category: "billing", count: 4 },
    { category: "ops", count: 2 },
  ],
  intake: { category: "inbox", collected: 2 },
};

const ids = (starters: ChatStarter[]) => starters.map((starter) => starter.id);

describe("chat copy from the conversation reference", () => {
  test("keeps the header actions as the short rename and delete labels", () => {
    expect(de("chat.rename")).toBe("Umbenennen");
    expect(de("chat.delete")).toBe("Löschen");
  });

  test("states that deleting a conversation removes it permanently", () => {
    expect(de("chat.delete.consequence", { title: "Projektbericht" })).toBe(
      "„Projektbericht“ wird endgültig entfernt.",
    );
  });
});

describe("chat start: example cards drawn from the installation", () => {
  test("the same catalog always yields the same cards in the same order", () => {
    expect(chatStarters(FULL, de)).toEqual(chatStarters(structuredClone(FULL), de));
    expect(ids(chatStarters(FULL, de))).toEqual([
      "failing-w1",
      "usage",
      "solution-webhook-to-slack",
      "knowledge-handbook",
      "intake-inbox",
      "catalog-billing",
      "capabilities",
      "create",
      "connect",
      "run",
    ]);
  });

  test("each card names its subject and fills the composer with a question about it", () => {
    const [failing, usage, solution, knowledge, intake, catalog] = chatStarters(FULL, de);
    expect(failing).toEqual(
      expect.objectContaining({
        title: "Warum schlug etwas fehl?",
        line: "growth-report · 2 Fehlschläge in Folge",
        prompt: "Warum schlägt growth-report fehl?",
      }),
    );
    expect(usage?.prompt).toBe("Was hat die KI diese Woche gekostet, und wofür?");
    expect(solution).toEqual(
      expect.objectContaining({
        title: "Webhook meldet in Slack",
        line: "Vorlage · Slack",
        prompt: "Richte die Vorlage „Webhook meldet in Slack“ ein: Meldet Wichtiges.",
      }),
    );
    expect(knowledge?.title).toBe("Was gilt im Betrieb?");
    expect(knowledge?.line).toBe("Quelle · Handbuch");
    expect(intake).toEqual(
      expect.objectContaining({
        id: "intake-inbox",
        title: "Eingang prüfen",
        line: "Gesammelte Einträge prüfen und Wissen oder Skills vorschlagen.",
        prompt:
          "Schau meine neuen Einträge in „inbox“ durch. Welche davon helfen uns? Schlage vor, was wir übernehmen sollten, als Wissen oder als Skill, mit genauem Text, Quellen und Ziel zur Bestätigung.",
      }),
    );
    expect(catalog?.line).toBe("billing · 4 Workflows");
    expect(catalog?.prompt).toBe("Zeig mir die Workflows in @kategorie/billing");
  });

  test("only an evidenced consecutive failure count changes the starter line", () => {
    const starter = (count?: number) =>
      chatStarters(
        {
          ...EMPTY,
          attention: [
            {
              class: "failing",
              subject: { kind: "workflow", id: "w1", name: "Report" },
              counts: { consecutive_failures: count },
            },
          ],
        },
        de,
      )[0];
    expect(starter(1)?.line).toBe("Report · 1 Fehlschlag in Folge");
    expect(starter(5)?.line).toBe("Report · 5 Fehlschläge in Folge");
    for (const count of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect(starter(count)?.line).toBe("Report · scheitert gerade");
    }
    const attention = [
      {
        class: "failing",
        subject: { kind: "workflow", id: "w1", name: "Report" },
        counts: { failures: 9, consecutive_failures: undefined },
      },
    ];
    expect(chatStarters({ ...EMPTY, attention }, de)[0]?.line).toBe("Report · scheitert gerade");
  });

  test("an installation without data still offers four ways in", () => {
    const starters = chatStarters(EMPTY, de);
    expect(starters).toHaveLength(MIN_STARTERS);
    expect(ids(starters)).toEqual(["capabilities", "create", "connect", "run"]);
    expect(starters[1]?.prompt).toBe(de("create.workflow.prompt"));
  });

  test("keeps the general support cards alongside contextual suggestions", () => {
    const variants: StarterSources[] = [
      EMPTY,
      { ...EMPTY, usage: true },
      { ...EMPTY, usage: true, knowledge: FULL.knowledge },
      FULL,
      { ...FULL, categories: [{ category: "solo", count: 1 }] },
    ];
    for (const sources of variants) {
      const count = chatStarters(sources, de).length;
      expect(count).toBeGreaterThanOrEqual(MIN_STARTERS);
      expect(count).toBeLessThanOrEqual(MAX_STARTERS);
    }
    const starters = chatStarters({ ...FULL, categories: [{ category: "solo", count: 1 }] }, de);
    expect(starters.map((starter) => starter.id)).toContain("intake-inbox");
    expect(starters.map((starter) => starter.id)).toEqual(
      expect.arrayContaining(["capabilities", "create", "connect", "run"]),
    );
  });

  test("only failing workflows with a name become a failure card; empty blocks are skipped", () => {
    const sources: StarterSources = {
      ...EMPTY,
      attention: [{ class: "failing", subject: { kind: "workflow", id: "w9", name: null } }],
      categories: [{ category: "empty", count: 0 }],
    };
    expect(ids(chatStarters(sources, de))).toEqual(["capabilities", "create", "connect", "run"]);
  });
});

test("keeps the intake review starter when the personal category has no collected items", () => {
  expect(
    ids(chatStarters({ ...EMPTY, intake: { category: "inbox", collected: 1 } }, de)),
  ).toContain("intake-inbox");
  expect(
    ids(chatStarters({ ...EMPTY, intake: { category: "inbox", collected: 0 } }, de)),
  ).toContain("intake-inbox");
});

describe("chat start: what each person's cards may read", () => {
  test("solutions need connector:read, so a person without it never asks for them", () => {
    expect(starterGates(["workflow:read", "conversation:write"])).toEqual({
      workflows: true,
      solutions: false,
      knowledge: false,
      usage: false,
      intake: false,
    });
    expect(
      starterGates(["workflow:read", "connector:read", "knowledge:read", "stats:read"]),
    ).toEqual({ workflows: true, solutions: true, knowledge: true, usage: true, intake: false });
    expect(starterGates(["intake:read"])).toEqual({
      workflows: false,
      solutions: false,
      knowledge: false,
      usage: false,
      intake: true,
    });
  });

  test("a refused read is never retried; an outage is retried once", () => {
    expect(retryStarterQuery(0, { status: 403 })).toBe(false);
    expect(retryStarterQuery(0, { status: 404 })).toBe(false);
    expect(retryStarterQuery(0, { status: 503 })).toBe(true);
    expect(retryStarterQuery(1, { status: 503 })).toBe(false);
    expect(retryStarterQuery(0, new Error("network"))).toBe(true);
  });

  test("without solutions the cards still come from the catalog", () => {
    const starters = chatStarters({ ...FULL, solutions: [] }, de);
    expect(starters.map((starter) => starter.id)).toEqual([
      "failing-w1",
      "usage",
      "knowledge-handbook",
      "intake-inbox",
      "catalog-billing",
      "capabilities",
      "create",
      "connect",
      "run",
    ]);
  });

  test("the empty chat shows four suggestions as chips and keeps the rest one click away", () => {
    const starters = chatStarters({ ...FULL, solutions: [] }, de);
    const folded = starterChips(starters, false);
    expect(folded.shown.map((starter) => starter.id)).toEqual(
      starters.slice(0, CHIP_STARTERS).map((starter) => starter.id),
    );
    expect(folded.hidden).toBe(starters.length - CHIP_STARTERS);
    const open = starterChips(starters, true);
    expect(open.shown).toEqual(starters);
    expect(open.hidden).toBe(0);
    expect(starterChips(starters.slice(0, 2), false)).toEqual({
      shown: starters.slice(0, 2),
      hidden: 0,
    });
  });

  test("the chips stand above the composer only while the chat is empty and nothing is on its way", () => {
    const empty = { messages: 0, sending: false, optimistic: false, failed: false, seeded: false };
    expect(startersVisible(empty)).toBe(true);
    expect(startersVisible({ ...empty, messages: 1 })).toBe(false);
    expect(startersVisible({ ...empty, sending: true })).toBe(false);
    expect(startersVisible({ ...empty, optimistic: true })).toBe(false);
    expect(startersVisible({ ...empty, failed: true })).toBe(false);
    expect(startersVisible({ ...empty, seeded: true })).toBe(false);
  });
});
