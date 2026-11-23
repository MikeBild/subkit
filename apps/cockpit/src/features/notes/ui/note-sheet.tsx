import { Pill } from "@ui/atoms/pill";
import { absolute } from "@/app/links";
import {
  ActionMenu,
  type ActionMenuItem,
  Button,
  DataState,
  type Fact,
  FactList,
  RecordSheet,
  SectionHeading,
  TechnicalDetails,
} from "@/components/cockpit/patterns";
import type {
  PersonalNoteDetail,
  PersonalNoteSource,
  PersonalNoteVersion,
} from "@/features/notes/api/notes-api";
import { useNotesText } from "@/features/notes/hooks/use-notes-text";
import {
  channelKey,
  isGone,
  NOTE_AREA_LABEL,
  NOTE_KIND_LABEL,
  NOTE_ORIGIN_LABEL,
  NOTE_STATUS_LABEL,
  NOTE_STATUS_TONE,
  type NoteAction,
  noteActions,
  noteTitle,
  reasonKey,
  sourceHref,
} from "@/features/notes/model/notes";
import type { NotesKey } from "@/features/notes/model/notes-copy";
import { useI18n } from "@/lib/i18n-context";

const MENU_LABEL: Record<Exclude<NoteAction, "confirm" | "restore">, NotesKey> = {
  edit: "notes.edit",
  share: "notes.share",
  archive: "notes.archive",
  forget: "notes.forget",
};

function Sources({ sources }: { sources: readonly PersonalNoteSource[] }) {
  const nt = useNotesText();
  const { dateTime } = useI18n();
  if (sources.length === 0)
    return (
      <p className="text-sm text-muted-foreground" data-testid="notes-sheet-no-sources">
        {nt("notes.sheet.noSources")}
      </p>
    );
  return (
    <ul className="grid gap-3" data-testid="notes-sheet-sources">
      {sources.map((source) => {
        const href = sourceHref(source);
        return (
          <li key={source.id} className="grid gap-1.5">
            <figure className="grid gap-1">
              <figcaption className="text-xs text-muted-foreground">
                {nt("notes.sheet.quote")}
              </figcaption>
              <blockquote className="border-s-2 ps-3 text-sm [overflow-wrap:anywhere]">
                {source.quote}
              </blockquote>
            </figure>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                {nt("notes.sheet.when", {
                  date: dateTime(source.created_at),
                  channel: nt(channelKey(source.channel)),
                })}
              </span>
              {href ? (
                <a
                  href={absolute(href)}
                  className="font-medium text-foreground underline underline-offset-4"
                  data-testid={`notes-source-${source.id}-open`}
                >
                  {nt("notes.sheet.openMessage")}
                </a>
              ) : (
                <span>{nt("notes.sheet.messageGone")}</span>
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

function EarlierVersions({ versions }: { versions: readonly PersonalNoteVersion[] }) {
  const nt = useNotesText();
  const { dateTime } = useI18n();
  if (versions.length === 0) return null;
  return (
    <section className="grid gap-2" aria-labelledby="notes-sheet-earlier">
      <SectionHeading id="notes-sheet-earlier">{nt("notes.sheet.earlier")}</SectionHeading>
      <ul className="grid gap-3" data-testid="notes-sheet-earlier-list">
        {versions.map((version) => (
          <li key={version.id} className="grid gap-2 rounded-lg border p-3">
            <p className="text-sm [overflow-wrap:anywhere]">{version.text}</p>
            <p className="text-xs text-muted-foreground">
              {nt(reasonKey(version.archive_reason))}
              {version.archived_at ? ` · ${dateTime(version.archived_at)}` : ""}
            </p>
            {version.sources.length > 0 ? <Sources sources={version.sources} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

function facts(
  note: PersonalNoteDetail,
  nt: ReturnType<typeof useNotesText>,
  dateTime: (value: string) => string,
): Fact[] {
  return [
    { label: nt("notes.fact.id"), value: <span className="font-mono">{note.id}</span> },
    {
      label: nt("notes.fact.address"),
      value: <span className="font-mono">{`${note.area}/${note.slug}`}</span>,
    },
    { label: nt("notes.fact.version"), value: note.version },
    { label: nt("notes.fact.origin"), value: nt(NOTE_ORIGIN_LABEL[note.origin]) },
    { label: nt("notes.fact.kind"), value: nt(NOTE_KIND_LABEL[note.fact_kind]) },
    { label: nt("notes.fact.created"), value: dateTime(note.created_at) },
    { label: nt("notes.fact.updated"), value: dateTime(note.updated_at) },
  ];
}

export function NoteSheet({
  open,
  note,
  loading,
  error,
  canShare,
  busy,
  onClose,
  onRetry,
  onAction,
}: {
  open: boolean;
  note: PersonalNoteDetail | undefined;
  loading: boolean;
  error: unknown;
  canShare: boolean;
  busy: boolean;
  onClose(): void;
  onRetry(): void;
  onAction(action: NoteAction, note: PersonalNoteDetail): void;
}) {
  const nt = useNotesText();
  const { dateTime } = useI18n();
  const actions = note ? noteActions(note, canShare) : [];
  const primary = actions.find((action) => action === "confirm" || action === "restore");
  const menu: ActionMenuItem[] = note
    ? actions.flatMap((action) =>
        action === "confirm" || action === "restore"
          ? []
          : [
              {
                label: nt(MENU_LABEL[action]),
                onSelect: () => onAction(action, note),
                destructive: action === "forget",
                testId: `notes-sheet-${action}`,
              },
            ],
      )
    : [];
  return (
    <RecordSheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={note ? noteTitle(note) : nt("notes.title")}
      subtitle={note ? nt(NOTE_AREA_LABEL[note.area]) : undefined}
      badge={
        note ? (
          <Pill tone={NOTE_STATUS_TONE[note.status]}>{nt(NOTE_STATUS_LABEL[note.status])}</Pill>
        ) : undefined
      }
      action={
        note && primary ? (
          <Button
            disabled={busy}
            onClick={() => onAction(primary, note)}
            data-testid={`notes-sheet-${primary}`}
          >
            {nt(primary === "confirm" ? "notes.confirm" : "notes.restore")}
          </Button>
        ) : undefined
      }
      menu={
        menu.length > 0 ? (
          <ActionMenu items={menu} alwaysMenu testId="notes-sheet-menu" />
        ) : undefined
      }
      loading={loading}
      testId="notes-sheet"
    >
      {note ? (
        <div className="grid gap-6">
          <p className="text-sm [overflow-wrap:anywhere]" data-testid="notes-sheet-text">
            {note.text}
          </p>
          <section className="grid gap-2" aria-labelledby="notes-sheet-why">
            <SectionHeading id="notes-sheet-why">{nt("notes.sheet.why")}</SectionHeading>
            <Sources sources={note.sources} />
          </section>
          <EarlierVersions versions={note.earlier_versions} />
          <TechnicalDetails testId="notes-sheet-technical">
            <FactList items={facts(note, nt, dateTime)} testId="notes-sheet-facts" />
          </TechnicalDetails>
        </div>
      ) : error ? (
        <DataState
          state="error"
          line={nt(isGone(error) ? "notes.sheet.notFound" : "notes.sheet.loadFailed")}
          error={error}
          {...(isGone(error) ? {} : { onRetry })}
          testId="notes-sheet-failed"
        />
      ) : null}
    </RecordSheet>
  );
}
