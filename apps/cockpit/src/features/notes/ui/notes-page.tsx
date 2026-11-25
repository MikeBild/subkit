import { useNavigate, useParams } from "@tanstack/react-router";
import { EmptyState } from "@ui/molecules/empty-state";
import { Download, NotebookPen } from "lucide-react";
import { useState } from "react";
import { useSession } from "@/app/session";
import {
  Button,
  ConfirmDialog,
  DataState,
  SegmentedControl,
  TopPageHeader,
  useConfirmTarget,
} from "@/components/cockpit/patterns";
import { Screen } from "@/components/cockpit/patterns/screen";
import type { PersonalNote, PersonalNoteDetail } from "@/features/notes/api/notes-api";
import {
  useNote,
  useNoteActions,
  useNotesExport,
  useNotesList,
} from "@/features/notes/hooks/use-notes";
import { useNotesText } from "@/features/notes/hooks/use-notes-text";
import { groupByStatus, NOTES_PATH, type NoteAction, noteHref } from "@/features/notes/model/notes";
import { NoteEditDialog } from "./note-edit-dialog";
import { NoteSheet } from "./note-sheet";
import { NotesList } from "./notes-list";

type Filter = "active" | "archived";

export function NotesPage() {
  const nt = useNotesText();
  const navigate = useNavigate();
  const { permissions } = useSession();
  const { resourceId } = useParams({ strict: false }) as { resourceId?: string };
  const openId = resourceId ?? null;
  const [filter, setFilter] = useState<Filter>("active");
  const [editing, setEditing] = useState<PersonalNoteDetail | null>(null);
  const forgettingConfirm = useConfirmTarget<PersonalNoteDetail>();
  const forgetting = forgettingConfirm.target;
  const sharingConfirm = useConfirmTarget<PersonalNoteDetail>();
  const sharing = sharingConfirm.target;
  const list = useNotesList(filter === "archived");
  const detail = useNote(openId);
  const exporting = useNotesExport();
  const home = () => void navigate({ to: NOTES_PATH });
  const open = (note: Pick<PersonalNote, "id">) => void navigate({ to: noteHref(note.id) });
  const actions = useNoteActions({
    onReplaced: (note) => {
      setEditing(null);
      open(note);
    },
    onGone: () => {
      forgettingConfirm.close();
      home();
    },
  });
  const act = (action: NoteAction, note: PersonalNoteDetail) => {
    if (action === "confirm") actions.confirm.mutate(note.id);
    else if (action === "archive") actions.archive.mutate(note.id);
    else if (action === "restore") actions.restore.mutate(note.id);
    else if (action === "edit") {
      actions.update.reset();
      setEditing(note);
    } else if (action === "share") sharingConfirm.ask(note);
    else forgettingConfirm.ask(note);
  };
  const groups = groupByStatus(list.data ?? []);
  const busy = actions.confirm.isPending || actions.archive.isPending || actions.restore.isPending;
  return (
    <Screen testId="notes-page">
      <TopPageHeader
        title={nt("notes.title")}
        summary={nt("notes.intro")}
        action={
          <Button
            variant="outline"
            disabled={exporting.isPending}
            onClick={() => exporting.mutate()}
            data-testid="notes-export"
          >
            <Download data-icon="inline-start" aria-hidden />
            {nt("notes.export")}
          </Button>
        }
        testId="notes-header"
      />
      <div className="flex flex-col gap-4">
        <SegmentedControl
          label={nt("notes.filter.label")}
          value={filter}
          onValueChange={(next) => setFilter(next as Filter)}
          options={(["active", "archived"] as const).map((value) => ({
            value,
            label: nt(value === "active" ? "notes.filter.active" : "notes.filter.archived"),
            testId: `notes-filter-${value}`,
          }))}
          testId="notes-filter"
        />
        {list.isPending ? (
          <DataState state="loading" testId="notes-loading" />
        ) : list.isError ? (
          <DataState
            state="error"
            line={nt("notes.loadFailed")}
            error={list.error}
            onRetry={() => void list.refetch()}
            testId="notes-load-failed"
          />
        ) : groups.length === 0 && filter === "archived" ? (
          <DataState
            state="empty"
            line={nt("notes.empty.archived")}
            testId="notes-empty-archived"
          />
        ) : groups.length === 0 ? (
          <EmptyState
            icon={NotebookPen}
            title={nt("notes.empty.title")}
            text={nt("notes.empty.body")}
            testId="notes-empty"
          />
        ) : (
          <NotesList groups={groups} onOpen={open} />
        )}
      </div>
      <NoteSheet
        open={openId !== null}
        note={detail.data}
        loading={openId !== null && detail.isPending}
        error={detail.error}
        canShare={permissions.includes("intake:write")}
        busy={busy}
        onClose={home}
        onRetry={() => void detail.refetch()}
        onAction={act}
      />
      <NoteEditDialog
        note={editing}
        pending={actions.update.isPending}
        failure={actions.update.error}
        onClose={() => setEditing(null)}
        onSave={(text) => {
          if (editing)
            actions.update.mutate({
              id: editing.id,
              text,
              expected_version: editing.version,
            });
        }}
      />
      {forgetting ? (
        <ConfirmDialog
          {...forgettingConfirm.dialog()}
          object={nt("notes.forget.object")}
          verb={nt("notes.forget")}
          consequence={nt("notes.forget.consequence")}
          destructive
          pending={actions.forget.isPending}
          onConfirm={() => actions.forget.mutate(forgetting.id)}
          testId="notes-forget-dialog"
        />
      ) : null}
      {sharing ? (
        <ConfirmDialog
          {...sharingConfirm.dialog()}
          title={nt("notes.share.title")}
          consequence={nt("notes.share.consequence")}
          confirmLabel={nt("notes.share.confirm")}
          pending={actions.share.isPending}
          onConfirm={() =>
            actions.share.mutate(sharing.id, { onSettled: () => sharingConfirm.close() })
          }
          testId="notes-share-dialog"
        />
      ) : null}
    </Screen>
  );
}
