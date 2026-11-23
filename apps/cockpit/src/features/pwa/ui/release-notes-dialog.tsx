import { useState } from "react";
import { RELEASE_HISTORY } from "@/app/release-notes.generated";
import { Button, FormDialog, Section } from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { releaseNotesFor } from "../release-notes";

export function ReleaseNotesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const pending = RELEASE_HISTORY.unpublished;
  const pendingNotes = releaseNotesFor(pending).notes;
  const hasNotes = pendingNotes.length > 0 || RELEASE_HISTORY.releases.length > 0;
  const releases = [...RELEASE_HISTORY.releases].reverse();
  const visibleReleases = showAll ? releases : releases.slice(0, 5);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("releaseNotes.title")}
      description={t("releaseNotes.description")}
      testId="release-notes"
    >
      <div className="flex flex-col gap-5">
        {pendingNotes.length > 0 && (
          <ReleaseNotesSection
            title={pending.version ? `v${pending.version}` : t("releaseNotes.unpublished")}
            notes={pendingNotes}
            empty={t("releaseNotes.empty")}
          />
        )}
        {visibleReleases.map((release) => (
          <ReleaseNotesSection
            key={release.version}
            title={release.version}
            notes={releaseNotesFor(release).notes}
            empty={t("releaseNotes.empty")}
          />
        ))}
        {!showAll && releases.length > visibleReleases.length && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="release-notes-show-all"
            onClick={() => setShowAll(true)}
          >
            {t("releaseNotes.showAll")}
          </Button>
        )}
        {!hasNotes && <p className="text-sm text-muted-foreground">{t("releaseNotes.empty")}</p>}
      </div>
    </FormDialog>
  );
}

function ReleaseNotesSection({
  title,
  notes,
  empty,
}: {
  title: string;
  notes: string[];
  empty: string;
}) {
  return (
    <Section label={title}>
      {notes.length > 0 ? (
        <ul lang="en" className="flex list-disc flex-col gap-1 pl-4 text-sm text-muted-foreground">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </Section>
  );
}
