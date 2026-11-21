import { fill, type MessageKey, type Messages } from "../../shared/i18n.ts";

export type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

export function translator(messages: Messages): Translate {
  return (key, vars = {}) => fill(messages[key], vars);
}
