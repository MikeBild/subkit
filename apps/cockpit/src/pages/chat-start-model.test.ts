import { describe, expect, test } from "bun:test";
import { type TranslationKey, translate } from "@/lib/i18n";
import {
  type ChatStarter,
  chatStarters,
  MAX_STARTERS,
  MIN_STARTERS,
  retryStarterQuery,
  type StarterSources,
  starterGates,
} from "./chat-start-model";

const de = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);

const EMPTY: StarterSources = {
  attention: [],
  usage: false,
  solutions: [],
  knowledge: [],
  categories: [],
};

const FULL: StarterSources = {
  attention: [
    { class: "decide", subject: { kind: "workflow", id: "w0", name: "nightly-sync" } },
    { class: "failing", subject: { kind: "connector", id: "c1", name: "wiki" } },
    { class: "failing", subject: { kind: "workflow", id: "w1", name: "growth-report" } },
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
};

const ids = (starters: ChatStarter[]) => starters.map((starter) => starter.id);

describe("chat start: example cards drawn from the installation", () => {
  test("the same catalog always yields the same cards in the same order", () => {
    expect(chatStarters(FULL, de)).toEqual(chatStarters(structuredClone(FULL), de));
    expect(ids(chatStarters(FULL, de))).toEqual([
      "failing-w1",
      "usage",
      "solution-webhook-to-slack",
      "knowledge-handbook",
      "catalog-billing",
    ]);
  });

  test("each card names its subject and fills the composer with a question about it", () => {
    const [failing, usage, solution, knowledge, catalog] = chatStarters(FULL, de);
    expect(failing).toEqual(
      expect.objectContaining({
        title: "Warum schlug etwas fehl?",
        line: "growth-report · scheitert gerade",
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
    expect(knowledge?.line).toBe("Quelle · Handbuch");
    expect(catalog?.line).toBe("billing · 4 Workflows");
    expect(catalog?.prompt).toBe("Zeig mir die Workflows in @kategorie/billing");
  });

  test("an installation without data still offers four ways in", () => {
    const starters = chatStarters(EMPTY, de);
    expect(starters).toHaveLength(MIN_STARTERS);
    expect(ids(starters)).toEqual(["capabilities", "create", "connect", "run"]);
    expect(starters[1]?.prompt).toBe(de("create.workflow.prompt"));
  });

  test("never fewer than four and never more than six cards", () => {
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
    expect(
      chatStarters({ ...FULL, categories: [{ category: "solo", count: 1 }] }, de).at(-1)?.line,
    ).toBe("solo · 1 Workflow");
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

describe("chat start: what each person's cards may read", () => {
  test("solutions need connector:read, so a person without it never asks for them", () => {
    expect(starterGates(["workflow:read", "conversation:write"])).toEqual({
      workflows: true,
      solutions: false,
      knowledge: false,
      usage: false,
    });
    expect(
      starterGates(["workflow:read", "connector:read", "knowledge:read", "stats:read"]),
    ).toEqual({ workflows: true, solutions: true, knowledge: true, usage: true });
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
      "catalog-billing",
    ]);
  });
});
