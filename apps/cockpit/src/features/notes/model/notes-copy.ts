import { interpolate, type Locale } from "@/lib/i18n";
import { notesDe, notesEn } from "@/lib/i18n/notes";

export type NotesKey = keyof typeof notesEn;

export type NotesText = (key: NotesKey, values?: Record<string, string | number>) => string;

const CATALOG: Record<Locale, Record<NotesKey, string>> = { en: notesEn, de: notesDe };

export function notesText(
  locale: Locale,
  key: NotesKey,
  values?: Record<string, string | number>,
): string {
  return interpolate(CATALOG[locale][key], values);
}
