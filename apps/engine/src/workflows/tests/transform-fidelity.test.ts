// Transform data-fidelity regressions over RECORDED connector responses.
//
// The incident class this pins: a live workflow's output reached the user
// wrong or lossy while the run itself reported green — the loss happened
// in DATA SHAPING (the transform), not in transport. Each case replays a
// recorded, anonymized vendor response (fixtures/responses/) through the
// same QuickJS path the engine's transform executor uses
// (execution/steps/transform.ts: runJs with a fixed clock/seed and the
// `{ scope, input }` envelope) and asserts on the OUTPUT STRUCTURE.
//
// Cases:
//   1. EMAIL   — Gmail messages.get bodies must be decoded (base64url,
//      nested multipart), not replaced by the truncated `snippet` teaser
//      (the "succeeded with garbage output" transcript).
//   2. CALENDAR — Google Calendar `start.dateTime` carries a local offset
//      and a SEPARATE `timeZone`; both must survive shaping (the sandbox
//      has no tz database, so dropping them silently shifts times).
//      The events.list fixture is synthesized from the documented shape —
//      the recording connector's Google Cloud project has the Calendar
//      API disabled; replace it with a live recording when one exists.
//   3. DOCUMENT — Notion rich_text annotations (bold/links) and
//      unknown block types (callout) must survive markdown conversion,
//      never degrade to "" (the canonical silent-loss renderer shape).
//
// Recorded-response fixtures live in fixtures/responses/ — a SUBDIR so
// production-fixtures.test.ts's `*.json` file filter does not pick them
// up as workflow DAGs.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, rel), "utf8")) as T;
}

/** Run a transform expression exactly like execution/steps/transform.ts:
 *  same input envelope, fixed deterministic clock and seed. */
async function runTransform<T>(expression: string, scope: unknown, input: unknown = null) {
  const result = await runJs({
    code: expression,
    input: { scope, input },
    limits: { wall_ms: 5_000 },
    clock: { now_ms: 1_783_194_487_000, seed: "transform-fidelity:test" },
  });
  return result.output as T;
}

/** Wrap a recorded response in the engine's step-scope envelope. */
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
      // Loop aggregate shape: one iteration object per item, keyed by the
      // body step id — how the engine records `fetch_each`.
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
    // Headers still resolve.
    expect(item.from).toBe("Jordan Doe <jordan@example.com>");
    expect(item.subject).toBe("Team-Update – Woche 27");
    expect(item.date).toBe("Sat, 04 Jul 2026 12:48:07 -0700");
    // THE fidelity assertion: the full decoded body reaches the output —
    // multibyte UTF-8 intact, content beyond the snippet present.
    expect(item.body).toContain("die Auswertung für die Größenänderung ist fertig");
    expect(item.body).toContain("Viele Grüße");
    expect(item.body).not.toBe(item.snippet);
    // And it is decoded text, not the raw base64url payload.
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

  // A representative agenda transform in the shape authors write: format
  // a human-facing wall time via sk.rfc3339Parts and pass the vendor's
  // dateTime + timeZone through UNTOUCHED alongside it.
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

    // Berlin event: wall time is the LOCAL time, offset preserved, and
    // the vendor's start object passed through byte-identical.
    expect(berlin.wall).toBe("2026-07-06 10:00");
    expect(berlin.offset).toBe("+02:00");
    expect(berlin.start).toEqual({
      dateTime: "2026-07-06T10:00:00+02:00",
      timeZone: "Europe/Berlin",
    });

    // LA event: different offset, different timeZone — neither
    // normalized away nor shifted.
    expect(la.wall).toBe("2026-07-06 08:30");
    expect(la.offset).toBe("-07:00");
    expect(la.start).toEqual({
      dateTime: "2026-07-06T08:30:00-07:00",
      timeZone: "America/Los_Angeles",
    });

    // All-day event: date-only survives as date-only (no invented time
    // or offset).
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

    // Annotations survive.
    expect(md).toContain("**Operational Execution Layer**");
    expect(md).toContain("**The Operating Model**");
    expect(md).toContain("[Vokabular](https://example.com/wiki/vokabular)");
    // Headings and structure.
    expect(md).toContain("## Zentrales Axiom");
    expect(md).toContain("1. **These**");
    expect(md).toContain("2. **System-Anforderungen**");
    expect(md).toContain("---");
    // The silent-loss shape: the callout is an UNKNOWN type for the
    // converter — its content must degrade to text, never vanish.
    expect(md).toContain("vier Strategie-Dokumente");
    // And multibyte content is intact.
    expect(md).toContain("Referenz: Beispiel-Essay – The Magnificent Dead End");
  });
});
