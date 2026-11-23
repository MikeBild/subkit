import { Panel } from "@ui/atoms/pill";
import { SwitchField } from "@/components/cockpit/patterns";
import { useNotesText } from "@/features/notes/hooks/use-notes-text";
import { useSaveNotes } from "@/features/settings/use-save-notes";
import { reportFailure } from "@/lib/action-failure";

export function SaveNotesSwitch() {
  const nt = useNotesText();
  const { saveNewNotes, ready, saving, change } = useSaveNotes((error) =>
    reportFailure(nt("notes.save.failed"), error),
  );
  return (
    <div data-testid="settings-notes-save">
      <Panel className="p-4">
        <SwitchField
          label={nt("notes.save.label")}
          help={nt("notes.save.help")}
          checked={saveNewNotes}
          disabled={!ready || saving}
          onChange={change}
          testId="settings-notes-save-switch"
        />
      </Panel>
    </div>
  );
}
