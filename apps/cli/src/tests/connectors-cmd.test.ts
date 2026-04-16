// Connector list command: stubbed client + captured stdout.

import { describe, expect, test } from "bun:test";
import { runList } from "../commands/connectors.ts";
import { EngineClient } from "../engine-client.ts";

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

describe("connectors command", () => {
  test("list renders table with key columns", async () => {
    const client = new EngineClient({
      engine_url: "http://e",
      api_key: "k",
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              items: [
                {
                  id: "c1",
                  slug: "slack",
                  display_name: "Slack",
                  driver: "slack",
                  environment: "prod",
                  auth_type: "bearer",
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        ),
    });
    const out = await captureStdout(() => runList(client, false));
    expect(out).toContain("slack");
    expect(out).toContain("Slack");
    expect(out).toContain("prod");
  });
});
