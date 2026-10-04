import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { EXTRACT_BODY_CAP_BYTES } from "../../http/routes/ai/extract.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;

beforeAll(async () => {
  ctx = await createJourneyCtx("extract");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey 18: /v1/extract endpoint", () => {
  test(
    "AC1: 1 MB CSV → 200 with parsed rows",
    async () => {
      const header = "id,name,note\n";
      const baseRow = (i: number) => `${i},name-${i},note-${i}\n`;
      const target = 1 * 1024 * 1024;
      let csv = header;
      let i = 0;
      while (csv.length < target) {
        csv += baseRow(i);
        i += 1;
      }

      const res = await journeyFetch(ctx, "/v1/extract", {
        method: "POST",
        headers: { "content-type": "text/csv" },
        body: csv,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        format: string;
        data: Array<Record<string, string>>;
      };
      expect(body.format).toBe("csv");
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.length).toBeGreaterThanOrEqual(i - 1);
      expect(body.data[0]?.name).toBe("name-0");
    },
    JOURNEY_HOOK_TIMEOUT,
  );

  test("AC2: 100-row JSON array → 200", async () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      label: `row-${i}`,
    }));
    const res = await journeyFetch(ctx, "/v1/extract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(arr),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { format: string; data: unknown[] };
    expect(body.format).toBe("json");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(100);
    expect((body.data[99] as { label: string }).label).toBe("row-99");
  });

  test("AC3: YAML → 200", async () => {
    const yaml = "title: demo\nversion: 2\nauthor: alice\n";
    const res = await journeyFetch(ctx, "/v1/extract", {
      method: "POST",
      headers: { "content-type": "application/yaml" },
      body: yaml,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      format: string;
      data: Record<string, unknown>;
    };
    expect(body.format).toBe("yaml");
    expect(body.data.title).toBe("demo");
    expect(body.data.version).toBe(2);
    expect(body.data.author).toBe("alice");
  });

  test("AC4: XML → 200", async () => {
    const xml = `<?xml version="1.0"?><catalog><book id="1">alpha</book><book id="2">beta</book></catalog>`;
    const res = await journeyFetch(ctx, "/v1/extract", {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body: xml,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      format: string;
      data: { children: Array<{ name: string }> };
    };
    expect(body.format).toBe("xml");
    expect(body.data.children[0]?.name).toBe("catalog");
  });

  test(
    "AC5: body over the 100 MB cap → 413",
    async () => {
      const overhead = '{"sample":""}'.length;
      const padding = "a".repeat(EXTRACT_BODY_CAP_BYTES + 1 - overhead);
      const body = JSON.stringify({ sample: padding });
      expect(body.length).toBeGreaterThan(EXTRACT_BODY_CAP_BYTES);

      const res = await journeyFetch(ctx, "/v1/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(res.status).toBe(413);
      const envelope = (await res.json()) as { code: string };
      expect(envelope.code).toBe("payload_too_large");
    },
    JOURNEY_HOOK_TIMEOUT,
  );
});
