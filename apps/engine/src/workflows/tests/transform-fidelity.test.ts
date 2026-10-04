import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, rel), "utf8")) as T;
}

async function runTransform<T>(expression: string, scope: unknown, input: unknown = null) {
  const result = await runJs({
    code: expression,
    input: { scope, input },
    limits: { wall_ms: 5_000 },
    clock: { now_ms: 1_783_194_487_000, seed: "transform-fidelity:test" },
  });
  return result.output as T;
}

const envelope = (data: unknown) => ({ data, duration_ms: 1, error: null });

describe("EMAIL — Gmail read-side fidelity (recorded messages.get)", () => {
  const dag = loadJson<{ steps: Array<{ id: string; expression?: string }> }>(
    "get-last-3-gmail-messages.json",
  );
  const expression = dag.steps.find((s) => s.id === "transform_output")?.expression ?? "";
  const listResponse = loadJson<Record<string, unknown>>("responses/gmail-messages-list.json");
  const message = loadJson<{
    snippet: string;
    payload: { parts: Array<{ mimeType: string; body: { data: string } }> };
  }>("responses/gmail-messages-get-full.json");

  test("the production transform decodes the base64url message body — not just the snippet", async () => {
    const scope = {
      list_messages: envelope(listResponse),
      fetch_each: envelope([{ get_message: envelope(message) }]),
    };
    const out = await runTransform<
      Array<{
        id: string;
        from?: string;
        subject?: string;
        date?: string;
        snippet: string;
        body: string;
      }>
    >(expression, scope);

    expect(out).toHaveLength(1);
    const item = out[0]!;
    expect(item.from).toBe("Jordan Doe <jordan@example.com>");
    expect(item.subject).toBe("Team-Update – Woche 27");
    expect(item.date).toBe("Sat, 04 Jul 2026 12:48:07 -0700");
    expect(item.body).toContain("die Auswertung für die Größenänderung ist fertig");
    expect(item.body).toContain("Viele Grüße");
    expect(item.body).not.toBe(item.snippet);
    expect(item.body).not.toBe(message.payload.parts[0]?.body.data);
  });
});

describe("CALENDAR — dateTime offset + timeZone survive shaping (events.list)", () => {
  const events = loadJson<{
    items: Array<{
      summary: string;
      start: { dateTime?: string; date?: string; timeZone?: string };
      end: { dateTime?: string; date?: string; timeZone?: string };
    }>;
  }>("responses/google-calendar-events-list.json");

  const expression = `
    return input.scope.fetch_events.data.items.map((e) => {
      const startRaw = e.start.dateTime !== undefined ? e.start.dateTime : e.start.date;
      const parts = sk.rfc3339Parts(startRaw);
      return {
        summary: e.summary,
        all_day: e.start.date !== undefined,
        wall: parts.wall,
        offset: parts.offset,
        start: e.start,
        end: e.end,
      };
    });
  `;

  test("timed events keep their offset-bearing dateTime and separate timeZone", async () => {
    const out = await runTransform<
      Array<{
        summary: string;
        all_day: boolean;
        wall: string;
        offset: string | null;
        start: { dateTime?: string; date?: string; timeZone?: string };
      }>
    >(expression, { fetch_events: envelope(events) });

    expect(out).toHaveLength(3);
    const [berlin, la, allDay] = out as [
      (typeof out)[number],
      (typeof out)[number],
      (typeof out)[number],
    ];

    expect(berlin.wall).toBe("2026-07-06 10:00");
    expect(berlin.offset).toBe("+02:00");
    expect(berlin.start).toEqual({
      dateTime: "2026-07-06T10:00:00+02:00",
      timeZone: "Europe/Berlin",
    });

    expect(la.wall).toBe("2026-07-06 08:30");
    expect(la.offset).toBe("-07:00");
    expect(la.start).toEqual({
      dateTime: "2026-07-06T08:30:00-07:00",
      timeZone: "America/Los_Angeles",
    });

    expect(allDay.all_day).toBe(true);
    expect(allDay.wall).toBe("2026-07-08");
    expect(allDay.offset).toBeNull();
    expect(allDay.start).toEqual({ date: "2026-07-08" });
  });
});

describe("DOCUMENT — Notion annotations survive markdown conversion (recorded blocks.children.list)", () => {
  const blocks = loadJson<Record<string, unknown>>("responses/notion-blocks-children-list.json");
  const expression = "return { markdown: sk.documentToMarkdown(input.scope.fetch_blocks.data) };";

  test("bold spans, links, callouts, and dividers all reach the markdown output", async () => {
    const out = await runTransform<{ markdown: string }>(expression, {
      fetch_blocks: envelope(blocks),
    });
    const md = out.markdown;

    expect(md).toContain("**Operational Execution Layer**");
    expect(md).toContain("**The Operating Model**");
    expect(md).toContain("[Vokabular](https://example.com/wiki/vokabular)");
    expect(md).toContain("## Zentrales Axiom");
    expect(md).toContain("1. **These**");
    expect(md).toContain("2. **System-Anforderungen**");
    expect(md).toContain("---");
    expect(md).toContain("vier Strategie-Dokumente");
    expect(md).toContain("Referenz: Beispiel-Essay – The Magnificent Dead End");
  });
});
