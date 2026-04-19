import { describe, expect, test } from "bun:test";
import { runSummarize } from "../commands/summarize.ts";
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

describe("summarize command", () => {
  test("renders the summarize response", async () => {
    const client = new EngineClient({
      engine_url: "http://engine",
      api_key: "k",
      fetchImpl: makeFetch(() => {
        return new Response(
          JSON.stringify({
            summary: "Summary: connector probe passed",
            tokens: { total: 19 },
            model_used: "claude-sonnet-4-5",
            fell_back: false,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    });
    const out = await captureStdout(() =>
      runSummarize(client, false, "connector probe passed and workflow committed"),
    );
    expect(out).toContain("summary");
    expect(out).toContain("connector probe passed");
  });
});
