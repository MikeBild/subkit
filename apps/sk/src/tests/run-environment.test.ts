import { describe, expect, test } from "bun:test";
import { EngineClient } from "../engine-client.ts";
import { environmentMismatchHint, parseRunEnvironment } from "../lib/run-environment.ts";
import { tailExecution } from "../lib/tail-execution.ts";

function recordingClient() {
  const headers: Array<Record<string, string>> = [];
  const client = new EngineClient({
    engine_url: "https://engine.test",
    api_key: "key",
    fetchImpl: async (_input, init) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return Response.json({ execution_id: "e1", status: "succeeded" });
    },
  });
  return { client, headers };
}

describe("run environment", () => {
  test("parses dev by default and accepts only the engine's environments", () => {
    expect(parseRunEnvironment(undefined)).toBe("dev");
    expect(parseRunEnvironment("prod")).toBe("prod");
    expect(parseRunEnvironment("dev")).toBe("dev");
    expect(parseRunEnvironment("staging")).toBeNull();
    expect(parseRunEnvironment("PROD")).toBeNull();
  });

  test("runExecution sends the chosen environment as x-subkit-environment", async () => {
    const { client, headers } = recordingClient();
    await client.runExecution({ source: "saved", workflow_id: "w1" }, { environment: "prod" });
    await client.runExecution({ source: "saved", workflow_id: "w1" });
    expect(headers[0]?.["x-subkit-environment"]).toBe("prod");
    expect(headers[1]?.["x-subkit-environment"]).toBeUndefined();
  });

  test("points a connector environment mismatch at the option", () => {
    const result = {
      execution_id: "e1",
      status: "failed",
      steps: [{ step_key: "write", error: { code: "connector_environment_mismatch" } }],
    };
    expect(environmentMismatchHint(result, "dev")).toContain("--environment prod");
    expect(environmentMismatchHint(result, "prod")).toContain("--environment dev");
    expect(environmentMismatchHint({ status: "succeeded", steps: [] }, "dev")).toBeNull();
  });

  test("a followed run surfaces the mismatch from its stream frames", async () => {
    const sse =
      'event: step.failed\ndata: {"step_key":"write","error":{"code":"connector_environment_mismatch"}}\n\n' +
      'event: execution.failed\ndata: {"status":"failed"}\n\n';
    const client = {
      streamExecution: async () =>
        new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    } as unknown as EngineClient;
    const hints: Array<string | null> = [];
    const terminal = await tailExecution(client, "e1", { write: () => true }, (frame) => {
      hints.push(environmentMismatchHint(frame, "dev"));
    });
    expect(terminal).toBe("failed");
    expect(hints[0]).toContain("--environment prod");
  });
});
