import { formatBytes, previewKind } from "@shared/file-kinds.ts";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@ui/lib/utils";
import { IconButton } from "@ui/molecules/icon-button";
import { type FileText, X } from "lucide-react";
import { useEffect } from "react";
import { dryRunPatchCandidate, getPatchCandidatePreview } from "@/api/decisions";
import { CHAT_COLUMN } from "@/app/shell-header";
import {
  buttonVariants,
  DataState,
  FilePreview,
  RecordSheet,
  useMessageScroller,
} from "@/components/cockpit/patterns";
import { DiffCard } from "@/features/workflows";
import { formatDateTime, LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import type { WorkflowResultLink } from "@/lib/tool-presentation";
import { fileContentHref } from "../api/attachments";
import type { AttachmentPreview } from "../model/labels";

export function ReadingColumn({
  testId,
  className,
  children,
}: {
  testId?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "scrollbar-thin overflow-hidden px-4 sm:px-8 [scrollbar-gutter:stable]",
        className,
      )}
      data-testid={testId}
    >
      <div className={CHAT_COLUMN}>{children}</div>
    </div>
  );
}

export function PatchProposalDiff({
  candidateId,
  testId,
}: {
  candidateId: string;
  testId: string;
}) {
  const { t } = useI18n();
  const preview = useQuery({
    queryKey: ["patch-candidate", "preview", candidateId],
    queryFn: () => getPatchCandidatePreview(candidateId),
  });
  const dryRun = useQuery({
    queryKey: ["patch-candidate", "dry-run", candidateId],
    enabled: preview.data?.fixture_available === true,
    retry: false,
    queryFn: () => dryRunPatchCandidate(candidateId),
  });

  if (preview.isPending)
    return (
      <p className="text-sm text-muted-foreground" data-testid={`${testId}-loading`}>
        {t("decisions.diffLoading")}
      </p>
    );
  if (preview.error || !preview.data)
    return (
      <DataState
        state="error"
        line={t("decisions.diffFailed")}
        error={preview.error ?? undefined}
        onRetry={() => void preview.refetch()}
        testId={`${testId}-error`}
      />
    );
  return (
    <DiffCard
      testId={testId}
      embedded
      targetLabel={preview.data.proposal?.description ?? t("decisions.kind.patch")}
      before={preview.data.before_step}
      after={preview.data.after_step}
      changedPaths={preview.data.changed_paths}
      driftSummary={preview.data.drift_summary}
      patch={preview.data.proposal?.patch}
      fixtureAvailable={preview.data.fixture_available}
      dryRun={dryRun.data ?? null}
      dryRunPending={preview.data.fixture_available === true && dryRun.isPending}
    />
  );
}

export function AttachmentChip({
  name,
  size,
  sizeLabel,
  icon: Icon,
  onOpen,
  onRemove,
  testId,
}: {
  name: string;
  size?: number;
  sizeLabel?: string;
  icon: typeof FileText;
  onOpen: () => void;
  onRemove?: () => void;
  testId: string;
}) {
  const { t, locale } = useI18n();
  return (
    <span
      className="inline-flex min-w-0 items-center overflow-hidden rounded-md border bg-muted/40 text-xs"
      data-testid={testId}
    >
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-md px-2 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid={`${testId}-open`}
      >
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">
          {name}
          {sizeLabel !== undefined
            ? ` · ${sizeLabel}`
            : size !== undefined
              ? ` · ${formatBytes(size, LOCALE_TAGS[locale])}`
              : ""}
        </span>
      </button>
      {onRemove ? (
        <IconButton
          label={t("chat.attachment.remove", { name })}
          size="icon-xs"
          onClick={onRemove}
          data-testid={`${testId}-remove`}
        >
          <X />
        </IconButton>
      ) : null}
    </span>
  );
}

export function ResultLink({ link, testId }: { link: WorkflowResultLink; testId: string }) {
  const { t, locale } = useI18n();
  if (Date.parse(link.expiresAt) <= Date.now()) {
    return (
      <p className="text-sm text-muted-foreground" data-testid={testId}>
        {t("chat.resultLink.expired")}
      </p>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3" data-testid={testId}>
      <a
        className={buttonVariants({ variant: "default", size: "sm" })}
        data-testid={`${testId}-open`}
        href={link.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        {t("chat.resultLink.open")}
      </a>
      <span className="text-sm text-muted-foreground">
        {t("chat.resultLink.validUntil", { time: formatDateTime(locale, link.expiresAt) })}
      </span>
    </div>
  );
}

export function FollowSubmittedTurn({ submittedAt }: { submittedAt: number }) {
  const { scrollToEnd } = useMessageScroller();
  useEffect(() => {
    if (submittedAt) scrollToEnd({ behavior: "instant" });
  }, [submittedAt, scrollToEnd]);
  return null;
}

export function AttachmentPreviewSheet({
  preview,
  onClose,
}: {
  preview: AttachmentPreview | null;
  onClose: () => void;
}) {
  const kind = preview ? previewKind(preview.name, preview.contentType) : "other";
  const textual = kind === "markdown" || kind === "text" || kind === "csv";
  const stored = preview?.fileId ?? null;
  const content = useQuery({
    queryKey: ["file-content", stored],
    enabled: Boolean(stored && textual),
    queryFn: async () => {
      const response = await fetch(fileContentHref(stored ?? ""), { credentials: "same-origin" });
      if (!response.ok) throw new Error(`file content ${response.status}`);
      return response.text();
    },
  });
  return (
    <RecordSheet
      open={preview !== null}
      onOpenChange={(open) => !open && onClose()}
      title={preview?.name ?? ""}
      testId="chat-attachment-preview"
      closeTestId="chat-attachment-preview-close"
    >
      {preview ? (
        <FilePreview
          name={preview.name}
          mimeType={preview.contentType}
          size={preview.size}
          file={preview.file}
          url={stored ? fileContentHref(stored) : undefined}
          text={stored && textual ? content.data : undefined}
          testId="chat-attachment-preview-body"
        />
      ) : null}
    </RecordSheet>
  );
}
