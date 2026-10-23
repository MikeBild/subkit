import type {
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { PROVIDER_RESPONSE_TIMEOUT_MS, responseTimeoutError } from "./core/response-timeout.ts";
import { LlmProviderError } from "./errors.ts";
import { getMockProvider } from "./mock-provider.ts";

function findConversationId(prompt: LanguageModelV4CallOptions["prompt"]): string | null {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m?.role !== "user") continue;
    for (const part of m.content) {
      if (part.type === "text") {
        const match = /\[conv:([^\]]+)\]/.exec(part.text);
        if (match?.[1]) return match[1];
      }
    }
  }
  return null;
}

function findLastUserText(prompt: LanguageModelV4CallOptions["prompt"]): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m?.role !== "user") continue;
    const pieces: string[] = [];
    for (const part of m.content) {
      if (part.type === "text") pieces.push(part.text);
    }
    if (pieces.length > 0) return pieces.join(" ");
  }
  return "";
}

function countPromptTextTokens(prompt: LanguageModelV4CallOptions["prompt"]): number {
  let chars = 0;
  for (const m of prompt) {
    if (m.role === "system") {
      chars += m.content.length;
      continue;
    }
    for (const part of m.content) {
      if (part.type === "text") chars += part.text.length;
    }
  }
  return Math.max(1, Math.ceil(chars / 4));
}

function findSystemLength(prompt: LanguageModelV4CallOptions["prompt"]): number {
  for (const m of prompt) {
    if (m.role === "system") return m.content.length;
  }
  return 0;
}

function mockToolCallPart(
  toolName: string,
  args: Record<string, unknown>,
  id: string,
): LanguageModelV4StreamPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName,
    input: JSON.stringify(args ?? {}),
  };
}

function textDeltaPart(id: string, delta: string): LanguageModelV4StreamPart {
  return { type: "text-delta", id, delta };
}

function textStartPart(id: string): LanguageModelV4StreamPart {
  return { type: "text-start", id };
}

function textEndPart(id: string): LanguageModelV4StreamPart {
  return { type: "text-end", id };
}

function finishPart(
  unified: "stop" | "tool-calls",
  promptTokens: number,
  completionTokens: number,
): LanguageModelV4StreamPart {
  return {
    type: "finish",
    finishReason: { unified, raw: undefined },
    usage: {
      inputTokens: {
        total: promptTokens,
        noCache: promptTokens,
        cacheRead: 0,
        cacheWrite: 0,
      },
      outputTokens: {
        total: completionTokens,
        text: completionTokens,
        reasoning: 0,
      },
    },
  };
}

let callCounter = 0;
function nextId(prefix: string): string {
  callCounter += 1;
  return `${prefix}-${Date.now()}-${callCounter}`;
}

export function createMockLanguageModel(modelId = "mock-converse"): MockLanguageModelV4 {
  const singleton = getMockProvider();
  return new MockLanguageModelV4({
    modelId,
    provider: "mock-provider",
    doStream: async (options: LanguageModelV4CallOptions): Promise<LanguageModelV4StreamResult> => {
      const primed = singleton.failureByModel.get(modelId);
      if (primed) {
        singleton.failureByModel.delete(modelId);
        if (primed === "rate_limit") {
          throw new LlmProviderError("rate_limit", `mock: rate limit on ${modelId}`);
        }
        if (primed === "quota_exhausted") {
          throw new LlmProviderError(
            "quota_exhausted",
            `mock: you have reached your specified api usage limits on ${modelId}. You will regain access on 2026-05-01 at 00:00 UTC.`,
          );
        }
        if (primed === "overloaded") {
          throw new LlmProviderError("overloaded", `mock: overloaded on ${modelId}`);
        }
        if (primed === "context_length_exceeded") {
          throw new LlmProviderError(
            "context_length_exceeded",
            `mock: context too large on ${modelId}`,
            { tokens: countPromptTextTokens(options.prompt) },
          );
        }
        if (primed === "response_never_arrives") {
          throw responseTimeoutError(PROVIDER_RESPONSE_TIMEOUT_MS);
        }
        if (primed === "stream_never_answers") {
          const abortSignal = options.abortSignal;
          return {
            stream: new ReadableStream<LanguageModelV4StreamPart>({
              start(controller) {
                if (abortSignal?.aborted) {
                  controller.error(abortSignal.reason);
                  return;
                }
                abortSignal?.addEventListener("abort", () => controller.error(abortSignal.reason), {
                  once: true,
                });
              },
            }),
          };
        }
      }

      singleton.toolChoices.push(options.toolChoice);
      singleton.toolPalettes.push(
        (options.tools ?? []).map((t) => ({
          name: t.name,
          description: t.type === "function" ? (t.description ?? "") : "",
        })),
      );
      const lastUser = findLastUserText(options.prompt);
      singleton.calls.push({
        model: modelId,
        flow: "converse",
        system_length: findSystemLength(options.prompt),
        last_user: lastUser,
        prompt_tokens_estimate: countPromptTextTokens(options.prompt),
        included_skill_ids: [],
        included_chunk_ids: [],
        included_knowledge_chunk_ids: [],
      });

      const convId = findConversationId(options.prompt);
      const step = convId ? singleton.nextConverseStep(convId) : { done: true as const };
      const promptTokens = countPromptTextTokens(options.prompt);

      const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }];

      if (step && typeof step === "object" && "tool" in step && typeof step.tool === "string") {
        chunks.push(
          mockToolCallPart(step.tool, (step.args ?? {}) as Record<string, unknown>, nextId("tc")),
        );
        chunks.push(finishPart("tool-calls", promptTokens, 8));
      } else if (step && typeof step === "object" && "text" in step) {
        const id = nextId("text");
        chunks.push(textStartPart(id));
        chunks.push(textDeltaPart(id, step.text));
        chunks.push(textEndPart(id));
        chunks.push(
          finishPart("stop", promptTokens, Math.max(8, Math.floor(step.text.length / 4))),
        );
      } else {
        const id = nextId("text");
        const ack = `Acknowledged: ${lastUser.slice(0, 200)}. (mock)`;
        chunks.push(textStartPart(id));
        chunks.push(textDeltaPart(id, ack));
        chunks.push(textEndPart(id));
        chunks.push(finishPart("stop", promptTokens, Math.max(8, Math.floor(ack.length / 4))));
      }

      return {
        stream: simulateReadableStream({
          chunks,
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      };
    },
  });
}
