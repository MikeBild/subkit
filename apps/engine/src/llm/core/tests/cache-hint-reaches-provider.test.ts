import { describe, expect, it } from "bun:test";
import { AiSdkModel } from "../ai-sdk-model.ts";
import type { SubkitLlmMessage } from "../base-types.ts";
import { toSystemMessages } from "../cache-blocks.ts";

interface SdkCall {
  messages: SubkitLlmMessage[];
}

function recordingModel() {
  const calls: SdkCall[] = [];
  const fn = async (opts: unknown) => {
    calls.push(opts as SdkCall);
    return {
      text: "ok",
      toolCalls: [],
      toolResults: [],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
      response: { messages: [] },
    };
  };
  const model = new AiSdkModel({
    defaultModel: "claude-sonnet-4-5",
    // biome-ignore lint/suspicious/noExplicitAny: stub
    generateTextFn: fn as any,
  });
  return { model, calls };
}

const blocks = {
  stable: "STABLE HEAD",
  volatile: "VOLATILE TAIL",
  token_counts: { stable: 2, volatile: 2 },
};

describe("the prompt-cache hint on the wire", () => {
  it("reaches the provider on the stable system message", async () => {
    const { model, calls } = recordingModel();
    const system = toSystemMessages(blocks, { enabled: true, ttl: "1h" });

    await model.generateText([...system, { role: "user", content: "hi" }]);

    const sent = calls[0]!.messages;
    const head = sent.find((m) => m.content === "STABLE HEAD");
    expect(head).toBeDefined();
    expect(head!.providerOptions).toEqual({
      anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } },
    });
  });

  it("carries no hint when the route disables the cache", async () => {
    const { model, calls } = recordingModel();
    const system = toSystemMessages(blocks, { enabled: false });

    await model.generateText([...system, { role: "user", content: "hi" }]);

    const head = calls[0]!.messages.find((m) => m.content === "STABLE HEAD");
    expect(head!.providerOptions).toBeUndefined();
  });

  it("puts the wall-clock stamp behind the system block, never in front of it", async () => {
    const { model, calls } = recordingModel();
    const system = toSystemMessages(blocks, { enabled: true, ttl: "1h" });

    await model.generateText([...system, { role: "user", content: "hi" }]);

    const sent = calls[0]!.messages;
    const stampAt = sent.findIndex(
      (m) => typeof m.content === "string" && m.content.startsWith("The current date and time is"),
    );
    const headAt = sent.findIndex((m) => m.content === "STABLE HEAD");
    expect(stampAt).toBeGreaterThan(-1);
    expect(headAt).toBe(0);
    expect(stampAt).toBeGreaterThan(headAt);
  });

  it("states the time to the model without losing precision", async () => {
    const { model, calls } = recordingModel();
    await model.generateText([{ role: "user", content: "hi" }]);
    const stamp = calls[0]!.messages.find(
      (m) => typeof m.content === "string" && m.content.startsWith("The current date and time is"),
    );
    expect(stamp!.content).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("does not stamp twice when a turn is fed back in", async () => {
    const { model, calls } = recordingModel();
    const once = [
      { role: "system" as const, content: "The current date and time is 2026-08-19T00:00:00.000Z" },
      { role: "user" as const, content: "hi" },
    ];
    await model.generateText(once);
    const stamps = calls[0]!.messages.filter(
      (m) => typeof m.content === "string" && m.content.startsWith("The current date and time is"),
    );
    expect(stamps).toHaveLength(1);
  });
});
