import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";

export function cacheReportingModels(cached: number | undefined) {
  const openai = createOpenAI({
    apiKey: "test-key",
    fetch: Object.assign(
      async () =>
        Response.json({
          id: "chat-test",
          object: "chat.completion",
          created: 0,
          model: "gpt-4o",
          choices: [
            { index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 1,
            ...(cached === undefined ? {} : { prompt_tokens_details: { cached_tokens: cached } }),
          },
        }),
      { preconnect: () => {} },
    ),
  });
  const anthropic = createAnthropic({
    apiKey: "test-key",
    fetch: Object.assign(
      async () =>
        Response.json({
          id: "msg-test",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            ...(cached === undefined ? {} : { cache_read_input_tokens: cached }),
          },
        }),
      { preconnect: () => {} },
    ),
  });

  return [openai.chat("gpt-4o"), anthropic("claude-sonnet-4-5")];
}
