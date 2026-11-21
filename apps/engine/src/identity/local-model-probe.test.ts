import { describe, expect, test } from "bun:test";
import {
  answerCallsTool,
  firstModelId,
  probeModelServer,
  toolProbeRequest,
} from "./local-model-probe.ts";

const AT = new Date("2026-11-21T10:00:00Z");
const ORIGIN = "http://localhost:11434";

const seen: { path: string; init: RequestInit | undefined }[] = [];

function server(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    seen.push({ path, init });
    const route = routes[path];
    if (!route) throw new TypeError("connection refused");
    return route();
  }) as typeof fetch;
}

const json =
  (body: unknown, status = 200) =>
  () =>
    Response.json(body, { status });

describe("a local model server", () => {
  test("names its first model", () => {
    expect(firstModelId({ data: [{ id: "llama3.2" }, { id: "x" }] })).toBe("llama3.2");
    for (const none of [null, {}, { data: [] }, { data: [{ id: "" }] }, { data: "x" }])
      expect(firstModelId(none)).toBeNull();
  });

  test("calls tools when the answer carries a tool call", () => {
    expect(
      answerCallsTool({ choices: [{ message: { tool_calls: [{ function: { name: "ping" } }] } }] }),
    ).toBe(true);
    for (const none of [
      null,
      { choices: [] },
      { choices: [{ message: { content: "pong" } }] },
      { choices: [{ message: { tool_calls: [] } }] },
      { choices: [{}] },
    ])
      expect(answerCallsTool(none)).toBe(false);
    expect(toolProbeRequest("m")).toMatchObject({ model: "m", tool_choice: "required" });
  });

  test("the probe tells tools, no tools and unreachable apart", async () => {
    const models = json({ data: [{ id: "llama3.2" }] });
    const withTools = server({
      "/v1/models": models,
      "/v1/chat/completions": json({ choices: [{ message: { tool_calls: [{ id: "1" }] } }] }),
    });
    seen.length = 0;
    expect(await probeModelServer(ORIGIN, AT, withTools)).toEqual({
      origin: ORIGIN,
      checked_at: "2026-11-21T10:00:00.000Z",
      model: "llama3.2",
      reachable: true,
      tools: true,
    });
    expect(seen.map((call) => call.path)).toEqual(["/v1/models", "/v1/chat/completions"]);
    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    const sent = seen[1]?.init;
    expect(sent?.method).toBe("POST");
    expect(sent?.headers).toEqual({ "content-type": "application/json" });
    expect(sent?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(sent?.body))).toEqual(toolProbeRequest("llama3.2"));
    const refusedWithCall = server({
      "/v1/models": models,
      "/v1/chat/completions": json({ choices: [{ message: { tool_calls: [{ id: "1" }] } }] }, 400),
    });
    expect((await probeModelServer(ORIGIN, AT, refusedWithCall)).tools).toBe(false);
    const broken = server({ "/v1/models": () => new Response("not json") });
    expect(await probeModelServer(ORIGIN, AT, broken)).toMatchObject({ reachable: false });
    const withoutTools = server({
      "/v1/models": models,
      "/v1/chat/completions": json({ error: "tools not supported" }, 400),
    });
    expect(await probeModelServer(ORIGIN, AT, withoutTools)).toMatchObject({
      reachable: true,
      tools: false,
    });
    const noModel = server({ "/v1/models": json({ data: [] }) });
    expect(await probeModelServer(ORIGIN, AT, noModel)).toMatchObject({
      model: null,
      reachable: true,
      tools: false,
    });
    expect(await probeModelServer(ORIGIN, AT, server({}))).toMatchObject({
      reachable: false,
      tools: false,
    });
  });
});
