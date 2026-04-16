// Unit-test the workflow command handlers by passing a fake EngineClient
// (no subprocess spawn, no pg). We capture stdout and assert the rendered
// output matches the expected table or JSON shape.

import { describe, expect, test } from "bun:test";
import { runGet, runList, runRun } from "../commands/workflows.ts";
import { EngineClient } from "../engine-client.ts";

function makeFetch(handler: (url: string, init: RequestInit) => Response) {
  return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    return Promise.resolve(handler(url, init ?? {}));
  };
}

function captureStdout(fn: () => Promise<unknown> | unknown): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (c: string | Uint8Array) => boolean }).write = (
    chunk: string | Uint8Array,
  ) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  return Promise.resolve(fn())
    .then(() => chunks.join(""))
    .finally(() => {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    });
}

const SAMPLE_WF = {
  id: "11111111-1111-1111-1111-111111111111",
  tenant_id: "tn",
  slug: "hello",
  name: "Hello",
  lifecycle: "active",
  current_version_id: "v1",
  current_version: 1,
  created_at: "2026-04-14T00:00:00.000Z",
  updated_at: "2026-04-14T00:00:00.000Z",
  steps: [],
};

describe("workflows command", () => {
  test("list renders a table", async () => {
    const client = new EngineClient({
      engine_url: "http://e",
      api_key: "k",
      fetchImpl: makeFetch(
        () =>
          new Response(JSON.stringify({ items: [SAMPLE_WF] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    const out = await captureStdout(() => runList(client, false));
    expect(out).toContain("id\tslug\tname\tlifecycle\tversion\tupdated_at");
    expect(out).toContain("hello");
    expect(out).toContain("Hello");
  });

  test("list --json emits JSON array", async () => {
    const client = new EngineClient({
      engine_url: "http://e",
      api_key: "k",
      fetchImpl: makeFetch(
        () =>
          new Response(JSON.stringify({ items: [SAMPLE_WF] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    const out = await captureStdout(() => runList(client, true));
    const parsed = JSON.parse(out) as Array<{ slug: string; version: number }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.slug).toBe("hello");
    expect(parsed[0]?.version).toBe(1);
  });

  test("get fetches and renders key/value", async () => {
    const client = new EngineClient({
      engine_url: "http://e",
      api_key: "k",
      fetchImpl: makeFetch(
        () =>
          new Response(JSON.stringify(SAMPLE_WF), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    const out = await captureStdout(() => runGet(client, false, SAMPLE_WF.id));
    expect(out).toContain("slug");
    expect(out).toContain("hello");
  });

  test("run POSTs with request_source=cli and sync=1", async () => {
    let seenUrl = "";
    let seenBody = "";
    const client = new EngineClient({
      engine_url: "http://e",
      api_key: "k",
      fetchImpl: makeFetch((url, init) => {
        seenUrl = url;
        seenBody = typeof init.body === "string" ? init.body : "";
        return new Response(
          JSON.stringify({ id: "exec-1", status: "succeeded", output: { ok: 1 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });
    const out = await captureStdout(() => runRun(client, true, SAMPLE_WF.id, { hello: "world" }));
    expect(seenUrl).toContain(`/v1/workflows/${SAMPLE_WF.id}/run`);
    expect(seenUrl).toContain("sync=1");
    const parsedBody = JSON.parse(seenBody) as { input: unknown; request_source: string };
    expect(parsedBody.request_source).toBe("cli");
    expect(parsedBody.input).toEqual({ hello: "world" });
    const parsedOut = JSON.parse(out) as { id: string; status: string };
    expect(parsedOut.id).toBe("exec-1");
    expect(parsedOut.status).toBe("succeeded");
  });
});
