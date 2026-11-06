import { afterEach, describe, expect, mock, test } from "bun:test";
import { startWorkflowRun } from "./workflow-run";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function capture() {
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify({ execution_id: "e-1", status: "running" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return calls;
}

describe("startWorkflowRun", () => {
  test("sends the saved run with its input and the chosen environment header", async () => {
    const calls = capture();
    const result = await startWorkflowRun("wf-1", "prod", { region: "north" });
    expect(result).toEqual({ execution_id: "e-1", status: "running" } as never);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.endsWith("/v1/executions")).toBe(true);
    expect(calls[0]?.init.method).toBe("POST");
    expect(new Headers(calls[0]?.init.headers).get("x-subkit-environment")).toBe("prod");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      source: "saved",
      workflow_id: "wf-1",
      input: { region: "north" },
    });
  });

  test("leaves the environment header and the input out when there are none", async () => {
    const calls = capture();
    await startWorkflowRun("wf-1", null, undefined);
    expect(new Headers(calls[0]?.init.headers).get("x-subkit-environment")).toBeNull();
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      source: "saved",
      workflow_id: "wf-1",
    });
  });
});
