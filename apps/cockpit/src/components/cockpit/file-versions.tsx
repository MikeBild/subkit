import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError, apiText } from "@/api/client";
import { tenantContentHref } from "@/api/tenant-context";
import { useActorDirectory } from "@/app/actor-directory";
import type { ActorDirectory } from "@/app/actor-directory-model";
import { useLiveQueryOptions } from "@/app/live-events";
import {
  Button,
  CollapsibleSection,
  DataState,
  FactList,
  FilePreview,
  formatBytes,
  previewKind,
  RecordSheet,
  Section,
  StatusBadge,
  Timeline,
} from "@/components/cockpit/patterns";
import { reportFailure } from "@/lib/action-failure";
import { LOCALE_TAGS } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useSearchParamState } from "@/lib/use-search-param-state";
import {
  type FileVersion,
  fileKindKey,
  fileVersionContentPath,
  fileVersionTitle,
  fileVersionUploader,
  hasEarlierVersions,
} from "@/pages/file-versions-model";

export function useFileVersions(fileId: string) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: ["file", fileId, "versions"],
    queryFn: () => apiCall("get", "/v1/files/{id}/versions", { path: { id: fileId } }),
    enabled: fileId !== "",
    ...live,
  });
}

function versionBadge(version: FileVersion, t: ReturnType<typeof useI18n>["t"]) {
  return version.current ? (
    <StatusBadge state="active" label={t("files.versions.current")} />
  ) : null;
}

export function FileVersionTimeline({
  items,
  directory,
  onOpen,
}: {
  items: readonly FileVersion[];
  directory: ActorDirectory;
  onOpen(version: number): void;
}) {
  const { t, dateTime } = useI18n();
  return (
    <Timeline
      testId="file-versions"
      groups={[
        {
          items: items.map((item) => ({
            id: String(item.version),
            tone: item.current ? "info" : "neutral",
            title: fileVersionTitle(item, t),
            meta: fileVersionUploader(item, directory, t),
            aside: (
              <>
                {versionBadge(item, t)}
                <span className="text-xs text-muted-foreground">{dateTime(item.uploaded_at)}</span>
              </>
            ),
            onOpen: () => onOpen(item.version),
            label: `v${item.version}`,
            testId: `file-version-${item.version}`,
          })),
        },
      ]}
    />
  );
}

export function FileVersionsSection({
  fileId,
  fileName,
  canWrite,
}: {
  fileId: string;
  fileName: string;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const directory = useActorDirectory(true);
  const versions = useFileVersions(fileId);
  const [selected, setSelected] = useSearchParamState("version", "");
  const items = versions.data?.items ?? [];
  const open = items.find((item) => String(item.version) === selected) ?? null;

  if (versions.error)
    return (
      <DataState
        state="error"
        line={t("files.versions.loadFailed")}
        onRetry={() => void versions.refetch()}
        testId="file-versions-failed"
      />
    );
  if (!hasEarlierVersions(items)) return null;
  return (
    <>
      <CollapsibleSection
        label={t("files.versions.title")}
        count={items.length}
        defaultOpen={open !== null}
        testId="file-versions-section"
      >
        <FileVersionTimeline
          items={items}
          directory={directory}
          onOpen={(version) => setSelected(String(version))}
        />
      </CollapsibleSection>
      <FileVersionSheet
        fileId={fileId}
        fileName={fileName}
        version={open}
        canWrite={canWrite}
        directory={directory}
        onClose={() => setSelected("")}
      />
    </>
  );
}

function FileVersionSheet({
  fileId,
  fileName,
  version,
  canWrite,
  directory,
  onClose,
}: {
  fileId: string;
  fileName: string;
  version: FileVersion | null;
  canWrite: boolean;
  directory: ActorDirectory;
  onClose: () => void;
}) {
  const { t, dateTime, locale } = useI18n();
  const client = useQueryClient();
  const number = version?.version ?? 0;
  const contentPath = tenantContentHref(fileVersionContentPath(fileId, number));
  const kind = version ? previewKind(version.filename, version.content_type) : "other";
  const textual = kind === "markdown" || kind === "text" || kind === "csv";
  const text = useQuery({
    queryKey: ["file", fileId, "versions", number, "content"],
    queryFn: () => apiText(contentPath),
    enabled: version !== null && textual,
  });
  const restore = useMutation({
    mutationFn: () =>
      apiCall("post", "/v1/files/{id}/versions/{version}/restore", {
        path: { id: fileId, version: number },
      }),

    onSuccess: (result) => {
      toast.success(t("files.versions.restored", { from: number, to: result.version }));
      void client.invalidateQueries({ queryKey: ["file", fileId] });
      void client.invalidateQueries({ queryKey: ["catalog"] });
      onClose();
    },
    onError: (error) =>
      reportFailure(
        error instanceof ApiError && error.code === "duplicate_content"
          ? t("files.duplicate")
          : t("common.actionFailed"),
        error,
      ),
  });
  const uploader = version ? fileVersionUploader(version, directory, t) : "";

  return (
    <RecordSheet
      open={version !== null}
      onOpenChange={(next) => !next && onClose()}
      title={version ? t("files.versions.sheetTitle", { name: fileName, version: number }) : ""}
      subtitle={version ? `${uploader} · ${dateTime(version.uploaded_at)}` : undefined}
      badge={version ? versionBadge(version, t) : undefined}
      action={
        version && canWrite && !version.current ? (
          <Button
            pending={restore.isPending}
            onClick={() => restore.mutate()}
            data-testid="file-version-restore"
          >
            {t("files.versions.restore")}
          </Button>
        ) : undefined
      }
      testId="file-version-sheet"
      closeTestId="file-version-close"
    >
      {version ? (
        <div className="flex flex-col gap-6">
          <FactList
            testId="file-version-facts"
            items={[
              {
                label: t("files.fact.kind"),
                value: t(fileKindKey(version.filename, version.content_type)),
              },
              {
                label: t("files.fact.size"),
                value: formatBytes(version.size_bytes, LOCALE_TAGS[locale]),
              },
              { label: t("files.fact.uploaded"), value: dateTime(version.uploaded_at) },
              { label: t("files.fact.by"), value: uploader },
              ...(version.replaced_at
                ? [{ label: t("files.fact.replaced"), value: dateTime(version.replaced_at) }]
                : []),
            ]}
          />
          <Section label={t("files.tab.preview")} testId="file-version-preview">
            {textual && text.isPending ? (
              <DataState state="loading" />
            ) : textual && text.error ? (
              <DataState
                state="error"
                line={t("files.versions.loadFailed")}
                onRetry={() => void text.refetch()}
                testId="file-version-preview-failed"
              />
            ) : (
              <FilePreview
                name={version.filename}
                mimeType={version.content_type}
                size={version.size_bytes}
                url={textual ? undefined : contentPath}
                text={textual ? text.data : undefined}
              />
            )}
          </Section>
          <p className="text-sm text-muted-foreground" data-testid="file-version-hint">
            {version.current ? t("files.versions.currentHint") : t("files.versions.restoreHint")}
          </p>
        </div>
      ) : null}
    </RecordSheet>
  );
}
