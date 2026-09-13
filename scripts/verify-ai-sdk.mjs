import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";

import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { generateObject, generateText, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

let scenario = "text";
let calls = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  calls.push(body);
  const provider = request.url.split("/")[1];
  if (scenario === "abort") return;
  if (scenario === "unauthorized" || (scenario === "retry" && calls.length === 1)) {
    response.writeHead(scenario === "retry" ? 429 : 401, {
      "content-type": "application/json",
      "retry-after": "0",
    });
    response.end(
      JSON.stringify({
        error: { message: "fixture refusal", type: "invalid_request_error", code: "fixture" },
      }),
    );
    return;
  }
  const content = scenario === "object" ? '{"ok":true}' : "fixture answer";
  const invoke = scenario === "tool" && calls.length === 1;
  const streaming = body.stream || request.url.includes("streamGenerateContent");
  if (streaming) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const event = (data, name) =>
      response.write(`${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
    if (provider === "openai") {
      event({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
      });
      event({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "fixture",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
      });
      response.write("data: [DONE]\n\n");
    } else if (provider === "anthropic") {
      event(
        {
          type: "message_start",
          message: {
            id: "fixture",
            type: "message",
            role: "assistant",
            content: [],
            model: "fixture",
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
        "message_start",
      );
      event(
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        "content_block_start",
      );
      event(
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content } },
        "content_block_delta",
      );
      event({ type: "content_block_stop", index: 0 }, "content_block_stop");
      event(
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 3 },
        },
        "message_delta",
      );
      event({ type: "message_stop" }, "message_stop");
    } else {
      event({
        candidates: [
          {
            index: 0,
            content: { role: "model", parts: [{ text: content }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
      });
    }
    response.end();
    return;
  }
  let payload;
  if (provider === "openai") {
    payload = {
      id: "fixture",
      object: "chat.completion",
      created: 1,
      model: "fixture",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: invoke ? null : content,
            ...(invoke
              ? {
                  tool_calls: [
                    {
                      id: "call-fixture",
                      type: "function",
                      function: { name: "double", arguments: '{"value":2}' },
                    },
                  ],
                }
              : {}),
          },
          finish_reason: invoke ? "tool_calls" : "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    };
  } else if (provider === "anthropic") {
    payload = {
      id: "fixture",
      type: "message",
      role: "assistant",
      model: "fixture",
      content: invoke
        ? [{ type: "tool_use", id: "call-fixture", name: "double", input: { value: 2 } }]
        : [{ type: "text", text: content }],
      stop_reason: invoke ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 3 },
    };
  } else {
    payload = {
      candidates: [
        {
          index: 0,
          content: {
            role: "model",
            parts: invoke
              ? [{ functionCall: { name: "double", args: { value: 2 } } }]
              : [{ text: content }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
    };
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const models = {
  openai: createOpenAI({ apiKey: "local-fixture", baseURL: `${origin}/openai` }).chat("fixture"),
  anthropic: createAnthropic({ apiKey: "local-fixture", baseURL: `${origin}/anthropic` })(
    "claude-sonnet-4-6",
  ),
  google: createGoogleGenerativeAI({ apiKey: "local-fixture", baseURL: `${origin}/google` })(
    "gemini-2.5-flash",
  ),
};
let passed = 0;
try {
  for (const [provider, model] of Object.entries(models)) {
    const check = async (name, action) => {
      scenario = name;
      calls = [];
      await action();
      assert.ok(calls.length > 0, "the real SDK must reach the HTTP fixture");
      console.log(`PASS ${provider}: ${name}`);
      passed++;
    };
    await check("text", async () => {
      const result = await generateText({ model, prompt: "fixture", maxRetries: 0 });
      assert.equal(result.text, "fixture answer");
      assert.equal(result.usage.inputTokens, 10);
      assert.equal(result.usage.outputTokens, 3);
    });
    await check("stream", async () => {
      const result = streamText({ model, prompt: "fixture", maxRetries: 0 });
      let text = "";
      for await (const part of result.textStream) text += part;
      assert.equal(text, "fixture answer");
      assert.equal((await result.totalUsage).outputTokens, 3);
    });
    await check("object", async () => {
      const result = await generateObject({
        model,
        prompt: "fixture",
        mode: "json",
        schema: z.object({ ok: z.boolean() }),
        maxRetries: 0,
      });
      assert.deepEqual(result.object, { ok: true });
    });
    await check("tool", async () => {
      const executed = [];
      const result = await generateText({
        model,
        prompt: "fixture",
        maxRetries: 0,
        stopWhen: stepCountIs(2),
        tools: {
          double: tool({
            inputSchema: z.object({ value: z.number() }),
            execute: async ({ value }) => {
              executed.push(value);
              return value * 2;
            },
          }),
        },
      });
      assert.deepEqual(executed, [2]);
      assert.equal(result.text, "fixture answer");
      assert.equal(calls.length, 2);
      assert.ok(JSON.stringify(calls[1]).includes("4"), "tool result must return to the provider");
      assert.equal(result.totalUsage.inputTokens, 20);
    });
    await check("retry", async () => {
      const result = await generateText({ model, prompt: "fixture", maxRetries: 1 });
      assert.equal(result.text, "fixture answer");
      assert.equal(calls.length, 2);
    });
    await check("unauthorized", async () => {
      await assert.rejects(
        generateText({ model, prompt: "fixture", maxRetries: 0 }),
        (error) => error.statusCode === 401,
      );
      assert.equal(calls.length, 1);
    });
    await check("abort", async () => {
      await assert.rejects(
        generateText({
          model,
          prompt: "fixture",
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(100),
        }),
      );
      assert.equal(calls.length, 1);
    });
  }
  console.log(`${passed} provider HTTP checks passed; no live model was called.`);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
