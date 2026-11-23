import { useCallback } from "react";
import { type NotesText, notesText } from "@/features/notes/model/notes-copy";
import { useI18n } from "@/lib/i18n-context";

export function useNotesText(): NotesText {
  const { locale } = useI18n();
  return useCallback((key, values) => notesText(locale, key, values), [locale]);
}
