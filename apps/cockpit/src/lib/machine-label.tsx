import type { TranslationKey } from "@/lib/i18n";

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

/**
 * A value as the reader sees it: the catalogue's word for it, or — where this
 * build has no word yet — the engine's own value, flagged so it is rendered as
 * one.
 *
 * The fallback used to be "Unbekannt". That is false twice over: the engine
 * recorded exactly which role, source or scope it was, and §2 bans the word.
 * §15.2 names the replacement — the machine value, recognisably as such.
 */
export interface CatalogLabel {
  text: string;
  machine: boolean;
}

export function catalogLabel(
  value: string,
  key: TranslationKey | undefined,
  t: Translate,
): CatalogLabel {
  return key ? { text: t(key), machine: false } : { text: value, machine: true };
}

/** A label in its face: prose for a word, monospace for a machine value. */
export function LabelText({ label }: { label: CatalogLabel }) {
  return label.machine ? (
    <code className="font-mono text-xs" data-machine-value="true">
      {label.text}
    </code>
  ) : (
    label.text
  );
}
