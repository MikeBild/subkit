import { useEffect, useState } from "react";
import { TextAreaField } from "@/components/cockpit/form-field";
import { dialogFailure, FormDialog } from "@/components/cockpit/patterns";
import type { PersonalNote } from "@/features/notes/api/notes-api";
import { useNotesText } from "@/features/notes/hooks/use-notes-text";
import { editProblem, noteErrorKey } from "@/features/notes/model/notes";

export function NoteEditDialog({
  note,
  pending,
  failure,
  onClose,
  onSave,
}: {
  note: PersonalNote | null;
  pending: boolean;
  failure: unknown;
  onClose(): void;
  onSave(text: string): void;
}) {
  const nt = useNotesText();
  const [text, setText] = useState("");
  const [touched, setTouched] = useState(false);
  const noteId = note?.id ?? null;
  const noteText = note?.text ?? "";
  useEffect(() => {
    if (noteId === null) return;
    setText(noteText);
    setTouched(false);
  }, [noteId, noteText]);
  const problem = editProblem(text);
  return (
    <FormDialog
      open={note !== null}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={nt("notes.edit.title")}
      description={nt("notes.edit.description")}
      submit={{ label: nt("notes.edit.submit"), pending, testId: "notes-edit-submit" }}
      onSubmit={() => {
        setTouched(true);
        if (!problem) onSave(text.trim());
      }}
      error={failure ? dialogFailure(nt(noteErrorKey(failure)), failure) : null}
      testId="notes-edit-dialog"
    >
      <TextAreaField
        id="notes-edit-text"
        label={nt("notes.edit.label")}
        value={text}
        onChange={setText}
        rows={5}
        error={
          touched && problem
            ? nt(problem.key, problem.max === undefined ? {} : { max: problem.max })
            : null
        }
      />
    </FormDialog>
  );
}
