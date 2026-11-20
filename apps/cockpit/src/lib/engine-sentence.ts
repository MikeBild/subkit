import type { TranslationKey } from "@/lib/i18n";
import { engineSentenceEn } from "@/lib/i18n/engine-sentence";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;
type SentenceKey = keyof typeof engineSentenceEn;

const KNOWN = new Set<string>(Object.keys(engineSentenceEn));

function keyOf(family: "hold" | "class" | "code", value: string | null | undefined) {
  const key = value ? `engine.${family}.${value}` : "";
  return KNOWN.has(key) ? (key as SentenceKey) : null;
}

export interface EngineFacts {
  hold?: string | null | undefined;
  code?: string | null | undefined;
  cause_class?: string | null | undefined;
  text?: string | null | undefined;
}

export function engineSentenceKey(facts: EngineFacts): SentenceKey | null {
  return (
    keyOf("hold", facts.hold) ?? keyOf("code", facts.code) ?? keyOf("class", facts.cause_class)
  );
}

export interface EngineSentence {
  text: string;
  source: "cockpit" | "engine";
}

export function engineSentence(facts: EngineFacts, t: Translate): EngineSentence | null {
  const key = engineSentenceKey(facts);
  if (key) return { text: t(key), source: "cockpit" };
  const text = facts.text?.trim();
  return text ? { text, source: "engine" } : null;
}

export const ENGINE_HOLD_CODES: readonly string[] = [...KNOWN]
  .filter((key) => key.startsWith("engine.hold."))
  .map((key) => key.slice("engine.hold.".length));
export const ENGINE_CLASS_CODES: readonly string[] = [...KNOWN]
  .filter((key) => key.startsWith("engine.class."))
  .map((key) => key.slice("engine.class.".length));
export const ENGINE_FAILURE_CODES: readonly string[] = [...KNOWN]
  .filter((key) => key.startsWith("engine.code."))
  .map((key) => key.slice("engine.code.".length));
