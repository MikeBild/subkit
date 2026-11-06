import type { LanguageModelV4CallOptions, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { z } from "zod";
import type { HostedLlmModelSchema } from "../../config/schema.ts";
import { LlmQuotaExhausted } from "../errors.ts";

type HostedModelBilling = z.infer<typeof HostedLlmModelSchema>;

export function unsupportedHostedBilling(reason: string): never {
  throw new LlmQuotaExhausted(
    `Hosted AI billing cannot safely authorize this call: ${reason}. Ask the operator to configure a supported text model and billing policy.`,
    { reason: "unsupported_hosted_billing" },
  );
}

const SCALE = 1_000_000n;

function rate(value: string): bigint {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) {
    return unsupportedHostedBilling("invalid exact decimal model price");
  }
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, "0"));
}

function roundedMicrounits(weighted: bigint): bigint {
  return (weighted + SCALE - 1n) / SCALE;
}

function rates(policy: HostedModelBilling) {
  return {
    input: rate(policy.input_usd_per_million_tokens),
    output: rate(policy.output_usd_per_million_tokens),
    read: rate(policy.cache_read_usd_per_million_tokens),
    write5m: rate(policy.cache_write_5m_usd_per_million_tokens),
    write1h: rate(policy.cache_write_1h_usd_per_million_tokens),
  };
}

export function hostedReservationAmount(policy: HostedModelBilling): bigint {
  const prices = rates(policy);
  const maxInput = [prices.input, prices.read, prices.write5m, prices.write1h].reduce(
    (maximum, value) => (value > maximum ? value : maximum),
  );
  if (prices.input <= 0n || prices.output <= 0n) {
    return unsupportedHostedBilling("verified positive input and output prices are required");
  }
  return roundedMicrounits(
    BigInt(policy.max_context_tokens) * maxInput + BigInt(policy.max_output_tokens) * prices.output,
  );
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return unsupportedHostedBilling("unrecognized provider options");
  }
  return value as Record<string, unknown>;
}

export function validateHostedCall(
  params: LanguageModelV4CallOptions,
  policy: HostedModelBilling,
): "5m" | "1h" {
  const ttls = new Set<"5m" | "1h">();
  const providerOptions = (options: unknown) => {
    if (options === undefined) return;
    for (const [provider, raw] of Object.entries(record(options))) {
      for (const [key, value] of Object.entries(record(raw))) {
        if (provider === "anthropic" && key === "cacheControl") {
          const cache = record(value);
          if (
            cache.type !== "ephemeral" ||
            Object.keys(cache).some((name) => name !== "type" && name !== "ttl") ||
            (cache.ttl !== undefined && cache.ttl !== "5m" && cache.ttl !== "1h")
          ) {
            return unsupportedHostedBilling("unrecognized prompt cache billing");
          }
          ttls.add(cache.ttl === "1h" ? "1h" : "5m");
        } else if (
          (provider === "anthropic" &&
            key === "disableParallelToolUse" &&
            typeof value === "boolean") ||
          (provider === "anthropic" && key === "structuredOutputMode" && value === "jsonTool") ||
          (provider === "openai" && key === "strictJsonSchema" && typeof value === "boolean")
        ) {
        } else {
          return unsupportedHostedBilling("provider options have no verified cost envelope");
        }
      }
    }
  };
  providerOptions(params.providerOptions);
  if (
    Object.entries(params.headers ?? {}).some(
      ([name, value]) => value !== undefined && name.toLowerCase() !== "user-agent",
    )
  ) {
    return unsupportedHostedBilling("custom provider headers have no verified cost envelope");
  }
  for (const tool of params.tools ?? []) {
    if (tool.type !== "function") {
      return unsupportedHostedBilling("provider-native paid tools are not supported");
    }
    providerOptions(tool.providerOptions);
  }
  for (const message of params.prompt) {
    providerOptions(message.providerOptions);
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      providerOptions(part.providerOptions);
      if (
        !["text", "reasoning", "tool-call", "tool-result", "tool-approval-response"].includes(
          part.type,
        )
      ) {
        return unsupportedHostedBilling("multimodal and custom input billing is not supported");
      }
      if (part.type === "tool-result" && part.output.type === "content") {
        for (const output of part.output.value) {
          if (output.type !== "text") {
            return unsupportedHostedBilling("multimodal tool results are not supported");
          }
          providerOptions(output.providerOptions);
        }
      }
    }
  }
  if (ttls.size > 1)
    return unsupportedHostedBilling("mixed prompt-cache durations are not supported");
  if (
    params.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(params.maxOutputTokens) || params.maxOutputTokens < 1)
  ) {
    return unsupportedHostedBilling("invalid output token bound");
  }
  params.maxOutputTokens = Math.min(
    params.maxOutputTokens ?? policy.max_output_tokens,
    policy.max_output_tokens,
  );
  return ttls.has("1h") ? "1h" : "5m";
}

export function hostedReportedAmount(
  policy: HostedModelBilling,
  usage: LanguageModelV4Usage,
  cacheTtl: "5m" | "1h",
): bigint | undefined {
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const counts = [input.total, input.noCache, input.cacheRead, input.cacheWrite, output.total];
  if (counts.some((count) => count === undefined || !Number.isSafeInteger(count) || count < 0)) {
    return undefined;
  }
  const [total, uncached, read, write, generated] = counts as [
    number,
    number,
    number,
    number,
    number,
  ];
  if (total !== uncached + read + write) return undefined;
  const prices = rates(policy);
  return roundedMicrounits(
    BigInt(uncached) * prices.input +
      BigInt(read) * prices.read +
      BigInt(write) * (cacheTtl === "1h" ? prices.write1h : prices.write5m) +
      BigInt(generated) * prices.output,
  );
}
