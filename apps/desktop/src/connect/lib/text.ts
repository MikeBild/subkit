import type { MessageKey } from "../../shared/i18n.ts";

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function factRows(
  facts: { label: MessageKey; value: string }[],
  t: Translate,
): [string, string][] {
  return facts.map((fact) => [t(fact.label), fact.value]);
}

export function translator(messages: Partial<Record<MessageKey, string>>): Translate {
  return (key, vars = {}) =>
    (messages[key] ?? "").replace(/\{(\w+)\}/g, (match, name: string) =>
      name in vars ? String(vars[name]) : match,
    );
}
