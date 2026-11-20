import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { CATALOGS, type TranslationKey } from "@/lib/i18n";
import { workerSource } from "./worker-fixture";

interface Target {
  id: string;
  class: string;
  severity: string;
  href: string | null;
}

interface Notice {
  title: string;
  options: Record<string, unknown> & { data?: { href: string } };
}

interface NotifyCore {
  attentionTargets(text: string): {
    items: Target[];
    more: number;
    paused: number;
    digest: { total: number; byClass: Record<string, number> } | null;
  };
  attentionNotifications(
    targets: {
      items: Target[];
      more: number;
      paused?: number;
      digest?: { total: number; byClass: Record<string, number> } | null;
    },
    locale: "de" | "en",
    base: string,
    steps: Record<string, string> | null,
  ): Notice[];
  scopedHref(href: unknown, base: string): string;
}

const coreSource = readFileSync(
  new URL("../../../public/worker-notify.js", import.meta.url),
  "utf8",
);

function core(): NotifyCore {
  const self: { subkitNotify?: NotifyCore } = {};
  vm.runInNewContext(coreSource, { self, URL, setTimeout });
  if (!self.subkitNotify) throw new Error("notification core did not load");
  return self.subkitNotify;
}

const installed = "/cockpit/i/11111111-1111-4111-8111-111111111111/";
const payload = (items: unknown[], more = 0) => JSON.stringify({ type: "attention", items, more });

describe("push payload to attention targets", () => {
  test("keeps the opaque fields of each item and nothing else", () => {
    const targets = core().attentionTargets(
      payload([
        {
          id: "workflow:w1",
          class: "stopped",
          severity: "critical",
          href: "/cockpit/workflows/w1?tab=runs",
          name: "Payroll export",
        },
      ]),
    );
    expect(targets).toEqual({
      items: [
        {
          id: "workflow:w1",
          class: "stopped",
          severity: "critical",
          href: "/cockpit/workflows/w1?tab=runs",
        },
      ],
      more: 0,
      paused: 0,
      digest: null,
    });
  });

  test("an unreadable or foreign payload yields no targets", () => {
    for (const text of ["", "secret tenant text", "[]", '{"type":"other","items":[]}', "null"])
      expect(core().attentionTargets(text)).toEqual({
        items: [],
        more: 0,
        paused: 0,
        digest: null,
      });
  });

  test("items it cannot name count towards the rest instead of being shown", () => {
    const targets = core().attentionTargets(
      payload(
        [
          { id: "connector:c1", class: "failing", severity: "urgent", href: null },
          { id: "connector:c1", class: "failing", severity: "urgent", href: null },
          { id: "Not An Id", class: "failing", severity: "urgent", href: null },
          { id: "workflow:w2", class: "unknown", severity: "urgent", href: null },
        ],
        2,
      ),
    );
    expect(targets.items.map((item) => item.id)).toEqual(["connector:c1"]);
    expect(targets.more).toBe(5);
  });

  test("drops addresses outside the Cockpit and unknown severities", () => {
    const targets = core().attentionTargets(
      payload([
        { id: "a:1", class: "decide", severity: "loud", href: "https://evil.test/cockpit/" },
        { id: "a:2", class: "decide", severity: "urgent", href: "/cockpitx/steal" },
        { id: "a:3", class: "decide", severity: "urgent", href: "/cockpit/i/other/tasks" },
        { id: "a:4", class: "decide", severity: "urgent", href: "/cockpit/tasks/t1" },
      ]),
    );
    expect(targets.items.map((item) => item.href)).toEqual([null, null, null, "/cockpit/tasks/t1"]);
    expect(targets.items[0]?.severity).toBe("notice");
  });

  test("reads at most eight items and counts the overflow", () => {
    const many = Array.from({ length: 11 }, (_, index) => ({
      id: `task:${index}`,
      class: "decide",
      severity: "notice",
      href: null,
    }));
    const targets = core().attentionTargets(payload(many, 1));
    expect(targets.items).toHaveLength(8);
    expect(targets.more).toBe(4);
  });
});

describe("attention targets to notifications", () => {
  const item = (id: string, kind = "failing", severity = "urgent", href: string | null = null) => ({
    id,
    class: kind,
    severity,
    href,
  });

  test("the title says what happened and the body what to do", () => {
    const [notice] = core().attentionNotifications(
      { items: [item("connector:c1", "failing", "urgent", "/cockpit/connectors/c1")], more: 0 },
      "de",
      installed,
      { "connector:c1": "reauth" },
    );
    expect(notice).toEqual({
      title: "Etwas schlägt fehl",
      options: {
        body: "Melde die Verbindung neu an.",
        icon: "/cockpit/app-icon-192.png",
        tag: `${installed}#connector:c1`,
        renotify: true,
        silent: false,
        data: { href: `${installed}connectors/c1` },
      },
    });
  });

  test("without details the body falls back to opening the item", () => {
    const list = core().attentionNotifications(
      { items: [item("workflow:w1", "stopped"), item("task:t1", "decide", "notice")], more: 0 },
      "en",
      "/cockpit/",
      null,
    );
    expect(
      list.map((notice) => [notice.title, notice.options.body, notice.options.silent]),
    ).toEqual([
      ["Something is on hold", "Open the item in SubKit.", false],
      ["A decision is waiting for you", "Open the item in SubKit.", true],
    ]);
    expect(list.map((notice) => notice.options.data?.href)).toEqual(["/cockpit/", "/cockpit/"]);
  });

  test("an unknown step from the server never becomes notification text", () => {
    const [notice] = core().attentionNotifications(
      { items: [item("workflow:w1")], more: 0 },
      "en",
      "/cockpit/",
      { "workflow:w1": "constructor" },
    );
    expect(notice?.options.body).toBe("Open the item in SubKit.");
  });

  test("shows three items and folds the rest into the neutral notice", () => {
    const items = ["a:1", "a:2", "a:3", "a:4"].map((id) => item(id));
    const list = core().attentionNotifications({ items, more: 2 }, "en", "/cockpit/", null);
    expect(list).toHaveLength(4);
    expect(list[3]).toEqual({
      title: "SubKit",
      options: {
        body: "New entries need you",
        icon: "/cockpit/app-icon-192.png",
        tag: "/cockpit/",
        renotify: true,
      },
    });
  });

  test("an empty payload stays the neutral notice", () => {
    expect(core().attentionNotifications({ items: [], more: 0 }, "de", installed, null)).toEqual([
      {
        title: "SubKit",
        options: {
          body: "Neue Einträge brauchen dich",
          icon: "/cockpit/app-icon-192.png",
          tag: installed,
          renotify: true,
        },
      },
    ]);
  });
});

describe("item address inside the worker's own scope", () => {
  test("moves a Cockpit address under the installation path", () => {
    const scoped = core().scopedHref;
    expect(scoped("/cockpit/tasks/t1?open=1#top", installed)).toBe(
      `${installed}tasks/t1?open=1#top`,
    );
    expect(scoped("/cockpit", installed)).toBe(installed);
    expect(scoped("/cockpit?review=workflow:w1", installed)).toBe(
      `${installed}?review=workflow:w1`,
    );
    expect(scoped("/cockpit/tasks/t1", "/cockpit/")).toBe("/cockpit/tasks/t1");
  });

  test("anything else opens the start page", () => {
    const scoped = core().scopedHref;
    for (const href of [null, 7, "", "//evil.test", "https://evil.test", "/cockpitx", "/v1/x"])
      expect(scoped(href, installed)).toBe(installed);
    expect(scoped("/cockpit/i/22222222-2222-4222-8222-222222222222/tasks", installed)).toBe(
      installed,
    );
  });
});

describe("several schedules paused at once", () => {
  const stopped = (id: string): Target => ({
    id: `workflow:${id}`,
    class: "stopped",
    severity: "urgent",
    href: null,
  });

  test("the payload's summary is read as a count of at least two", () => {
    const text = (summary: unknown) => JSON.stringify({ type: "attention", items: [], summary });
    expect(core().attentionTargets(text({ schedules_paused: 3 })).paused).toBe(3);
    expect(core().attentionTargets(text({ schedules_paused: 1 })).paused).toBe(0);
    expect(core().attentionTargets(text({ schedules_paused: "3" })).paused).toBe(0);
    expect(core().attentionTargets(text(undefined)).paused).toBe(0);
    expect(core().attentionTargets(text({ schedules_paused: 5_000 })).paused).toBe(999);
  });

  test("one notification names the count, in German and English, and takes a place in the burst", () => {
    const targets = { items: [stopped("a"), stopped("b"), stopped("c")], more: 0, paused: 3 };
    const german = core().attentionNotifications(targets, "de", "/cockpit/", null);
    expect(german.map((notice) => notice.title)).toEqual([
      "3 Zeitpläne wurden pausiert",
      "Ein Ablauf wurde angehalten",
      "Ein Ablauf wurde angehalten",
      "SubKit",
    ]);
    expect(german[0]?.options).toMatchObject({
      body: "Sieh dir an, warum, und setz sie fort.",
      tag: "/cockpit/#schedules-paused",
      data: { href: "/cockpit/" },
    });
    const english = core().attentionNotifications(
      { items: [], more: 0, paused: 12 },
      "en",
      "/cockpit/",
      null,
    );
    expect(english.map((notice) => notice.title)).toEqual(["12 schedules were paused"]);
    expect(english[0]?.options.body).toBe("See why, then resume them.");
  });
});

describe("the daily summary arrives as one notification", () => {
  const payload = (summary: unknown, items: unknown[] = []) =>
    JSON.stringify({ type: "attention", items, more: 4, summary });
  const newest = {
    id: "workflow:w9",
    class: "decide",
    severity: "urgent",
    href: "/cockpit/workflows/w9",
  };

  test("the payload's summary is read as a total of at least two with counts by class", () => {
    const read = (summary: unknown) => core().attentionTargets(payload(summary)).digest;
    expect(read({ total: 5, by_class: { decide: 3, failing: 2 } })).toEqual({
      total: 5,
      byClass: { failing: 2, decide: 3 },
    });
    expect(read({ total: 1, by_class: { decide: 1 } })).toBeNull();
    expect(read({ total: "5" })).toBeNull();
    expect(read({ schedules_paused: 3 })).toBeNull();
    expect(read({ total: 3, by_class: { decide: -1, other: 3, stopped: 3 } })).toEqual({
      total: 3,
      byClass: { stopped: 3 },
    });
  });

  test("one notification counts what waits, in German and English, and opens the newest item", () => {
    const targets = core().attentionTargets(
      payload({ total: 5, by_class: { decide: 3, failing: 2 } }, [newest]),
    );
    const german = core().attentionNotifications(targets, "de", "/cockpit/", null);
    expect(german).toHaveLength(1);
    expect(german[0]?.title).toBe("5 Einträge brauchen dich");
    expect(german[0]?.options).toMatchObject({
      body: "2 Fehler, 3 Entscheidungen",
      tag: "/cockpit/#summary",
      data: { href: "/cockpit/workflows/w9" },
    });
    const english = core().attentionNotifications(
      core().attentionTargets(payload({ total: 2, by_class: { decide: 1, stopped: 1 } })),
      "en",
      "/cockpit/",
      null,
    );
    expect(english.map((notice) => [notice.title, notice.options.body])).toEqual([
      ["2 items need you", "1 on hold, 1 decision"],
    ]);
    expect(english[0]?.options.data?.href).toBe("/cockpit/");
  });
});

describe("worker copy matches the catalog", () => {
  const keys = (Object.keys(CATALOGS.en) as TranslationKey[]).filter(
    (key) => key.startsWith("pwa.notify.") || key.startsWith("pwa.offline."),
  );

  test("every notification and offline text exists in both languages", () => {
    const source = workerSource("installation-worker.js");
    expect(keys.length).toBe(20);
    for (const locale of ["en", "de"] as const)
      for (const key of keys)
        expect(source, `${locale} ${key}`).toContain(JSON.stringify(CATALOGS[locale][key]));
  });

  test("the browser tab worker shares the notification text", () => {
    const source = workerSource("browser-worker.js");
    for (const key of keys.filter((entry) => entry.startsWith("pwa.notify.")))
      expect(source, key).toContain(JSON.stringify(CATALOGS.de[key]));
  });
});
