import { bareModelId } from "./pricing.ts";

const MODEL_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "claude-3-5-haiku": "Claude 3.5 Haiku",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-8": "Claude Opus 4.8",
  "claude-opus-5-5": "Claude Opus 5.5",
  "claude-fable-5": "Claude Fable 5",
  "claude-fable-5-1": "Claude Fable 5.1",
  "gpt-5.6-sol": "GPT-5.6 Sol",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o mini",
  "gpt-4.1": "GPT-4.1",
  "gpt-4.1-mini": "GPT-4.1 mini",
  "gpt-4-turbo": "GPT-4 Turbo",
  "gemini-2.5-pro": "Gemini 2.5 Pro",
  "gemini-2.5-flash": "Gemini 2.5 Flash",
});

export function modelDisplayName(modelId: string): string | null {
  if (!modelId) return null;
  return MODEL_NAMES[bareModelId(modelId)] ?? null;
}
