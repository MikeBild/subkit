import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  archiveNote,
  confirmNote,
  exportNotes,
  forgetNote,
  listNotes,
  NOTES_KEY,
  noteKey,
  notesListKey,
  type PersonalNote,
  readNote,
  restoreNote,
  shareNote,
  updateNote,
} from "@/features/notes/api/notes-api";
import { exportLabels, isGone, noteErrorKey } from "@/features/notes/model/notes";
import type { NotesKey } from "@/features/notes/model/notes-copy";
import { reportFailure } from "@/lib/action-failure";
import { useNotesText } from "./use-notes-text";

export function useNotesList(archived: boolean) {
  return useQuery({
    queryKey: notesListKey(archived),
    queryFn: () => listNotes(archived),
    retry: false,
  });
}

export function useNote(id: string | null) {
  return useQuery({
    queryKey: noteKey(id ?? ""),
    queryFn: () => readNote(id ?? ""),
    enabled: id !== null,
    retry: false,
  });
}

export function saveMarkdown(markdown: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function useNotesExport() {
  const nt = useNotesText();
  return useMutation({
    mutationFn: () => exportNotes(exportLabels(nt)),
    onError: (failure) => reportFailure(nt(noteErrorKey(failure)), failure),
    onSuccess: (result) => {
      saveMarkdown(result.markdown, nt("notes.export.file"));
      toast.success(nt("notes.export.done"));
    },
  });
}

export function useNoteActions(handlers: { onReplaced(note: PersonalNote): void; onGone(): void }) {
  const client = useQueryClient();
  const nt = useNotesText();
  const refresh = () => client.invalidateQueries({ queryKey: NOTES_KEY });
  const failed = (failure: unknown) => {
    reportFailure(nt(noteErrorKey(failure)), failure);
    void refresh();
    if (isGone(failure)) handlers.onGone();
  };
  const done = (key: NotesKey) => async () => {
    toast.success(nt(key));
    await refresh();
  };
  const confirm = useMutation({
    mutationFn: confirmNote,
    onError: failed,
    onSuccess: done("notes.confirm.done"),
  });
  const archive = useMutation({
    mutationFn: archiveNote,
    onError: failed,
    onSuccess: done("notes.archive.done"),
  });
  const restore = useMutation({
    mutationFn: restoreNote,
    onError: failed,
    onSuccess: done("notes.restore.done"),
  });
  const share = useMutation({
    mutationFn: shareNote,
    onError: failed,
    onSuccess: done("notes.share.done"),
  });
  const forget = useMutation({
    mutationFn: forgetNote,
    onError: failed,
    onSuccess: async () => {
      toast.success(nt("notes.forget.done"));
      handlers.onGone();
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: (input: { id: string; text: string; expected_version: number }) =>
      updateNote(input.id, { text: input.text, expected_version: input.expected_version }),
    onSuccess: async (note) => {
      toast.success(nt("notes.edit.done"));
      handlers.onReplaced(note);
      await refresh();
    },
  });
  return { confirm, archive, restore, share, forget, update, refresh };
}
