import { describe, expect, test } from "bun:test";
import { createFakeClock } from "./clock.ts";
import { createMockEngineSse } from "./mock-engine-sse.ts";
import { bootstrapFixture, permissionsFor } from "./persona-fixtures.ts";

describe("createFakeClock", () => {
  test("starts at the provided epoch", () => {
    const c = createFakeClock(2_000_000_000_000);
    expect(c.now()).toBe(2_000_000_000_000);
    expect(c.date().getTime()).toBe(2_000_000_000_000);
  });

  test("advance + setTime move the clock", () => {
    const c = createFakeClock(0);
    c.advance(1000);
    expect(c.now()).toBe(1000);
    c.setTime(5000);
    expect(c.now()).toBe(5000);
  });
});

describe("createMockEngineSse", () => {
  test("exposes a ReadableStream and emits SSE frames", async () => {
    const sse = createMockEngineSse();
    sse.pushDelta("hello");
    sse.pushDone();
    sse.close();

    const reader = sse.stream.getReader();
    const decoder = new TextDecoder();
    let combined = "";
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      combined += decoder.decode(r.value);
    }
    expect(combined).toContain("event: text_delta");
    expect(combined).toContain('"text":"hello"');
    expect(combined).toContain("event: done");
  });

  test("isOpen flips to false after close()", () => {
    const sse = createMockEngineSse();
    expect(sse.isOpen()).toBe(true);
    sse.close();
    expect(sse.isOpen()).toBe(false);
  });

  test("pushError emits an envelope with the new fields", async () => {
    const sse = createMockEngineSse();
    sse.pushError({ code: "rate_limited", message: "slow", hint: "wait", retry_after: 12 });
    sse.close();
    const text = await readAll(sse.stream);
    expect(text).toContain("event: error");
    expect(text).toContain('"hint":"wait"');
    expect(text).toContain('"retry_after":12');
  });
});

describe("persona fixtures", () => {
  test("admin has the broadest set", () => {
    expect(permissionsFor("admin")).toContain("audit:read");
    expect(permissionsFor("admin").length).toBeGreaterThan(permissionsFor("operator").length);
  });

  test("enduser cannot list conversations or read audit", () => {
    expect(permissionsFor("enduser")).not.toContain("conversation:list");
    expect(permissionsFor("enduser")).not.toContain("audit:read");
  });

  test("bootstrapFixture returns a usable SkBootstrapSnapshot", () => {
    const snap = bootstrapFixture("operator");
    expect(snap.label).toBe("operator");
    expect(snap.probe.allows("workflow:read")).toBe(true);
    expect(snap.probe.allows("audit:read")).toBe(false);
  });
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    out += decoder.decode(r.value);
  }
  return out;
}
