import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { apiRequest } from "@/api/client";
import { useActorDirectory } from "@/app/actor-directory";
import type { ActorDirectory } from "@/app/actor-directory-model";
import { useLiveQueryOptions } from "@/app/live-events";
import { FocusedDiff } from "@/components/cockpit/diff-card";
import {
  Button,
  DataState,
  type Fact,
  FactList,
  FilePreview,
  RecordSheet,
  Section,
  StatusBadge,
  Timeline,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { useSearchParamState } from "@/lib/use-search-param-state";
import {
  authorName,
  type KnowledgeVersion,
  type KnowledgeVersionDetail,
  previousVersion,
  restoreHint,
  versionChange,
  versionText,
  versionWhy,
} from "@/pages/knowledge-versions-model";

type History = { items: KnowledgeVersion[]; total: number };

function sourcePath(sourceId: string): string {
  return `/v1/knowledge-sources/${encodeURIComponent(sourceId)}`;
}

function versionBadge(version: KnowledgeVersion, t: ReturnType<typeof useI18n>["t"]) {
  return (
    <StatusBadge
      state={version.current ? "active" : "superseded"}
      label={t(version.current ? "knowledge.versions.current" : "knowledge.versions.earlier")}
    />
  );
}

export function useKnowledgeHistory(sourceId: string) {
  const live = useLiveQueryOptions();
  return useQuery({
    queryKey: ["knowledge-source", sourceId, "history"],
    queryFn: () => apiRequest<History>(`${sourcePath(sourceId)}/history?limit=200`),
    ...live,
  });
}

export function KnowledgeVersions({
  sourceId,
  sourceName,
  canWrite,
}: {
  sourceId: string;
  sourceName: string;
  canWrite: boolean;
}) {
  const { t, dateTime } = useI18n();
  const directory = useActorDirectory(true);
  const history = useKnowledgeHistory(sourceId);
  const [selected, setSelected] = useSearchParamState("version", "");
  const items = history.data?.items ?? [];
  const latest = items[0]?.version ?? 0;
  const open = items.find((item) => String(item.version) === selected) ?? null;

  if (history.isPending) return <DataState state="loading" />;
  if (history.error)
    return (
      <DataState
        state="error"
        line={t("knowledge.versions.loadFailed")}
        onRetry={() => void history.refetch()}
        testId="knowledge-versions-failed"
      />
    );
  return (
    <>
      {items.length === 0 ? (
        <DataState
          state="empty"
          line={t("knowledge.versions.empty")}
          testId="knowledge-versions-empty"
        />
      ) : (
        <Timeline
          testId="knowledge-versions"
          groups={[
            {
              items: items.map((item) => ({
                id: String(item.version),
                tone: item.current ? "info" : "neutral",
                title: `v${item.version} · ${versionWhy(item.note, directory, t) ?? t("knowledge.versions.saved")}`,
                meta: authorName(item.author, directory, t),
                aside: (
                  <>
                    {item.current ? versionBadge(item, t) : null}
                    <span className="text-xs text-muted-foreground">
                      {dateTime(item.created_at)}
                    </span>
                  </>
                ),
                onOpen: () => setSelected(String(item.version)),
                label: `v${item.version}`,
                testId: `knowledge-version-${item.version}`,
              })),
            },
          ]}
        />
      )}
      <KnowledgeVersionSheet
        sourceId={sourceId}
        sourceName={sourceName}
        version={open}
        kept={items}
        latest={latest}
        canWrite={canWrite}
        directory={directory}
        onClose={() => setSelected("")}
      />
    </>
  );
}

function KnowledgeVersionSheet({
  sourceId,
  sourceName,
  version,
  kept,
  latest,
  canWrite,
  directory,
  onClose,
}: {
  sourceId: string;
  sourceName: string;
  version: KnowledgeVersion | null;
  kept: readonly KnowledgeVersion[];
  latest: number;
  canWrite: boolean;
  directory: ActorDirectory;
  onClose: () => void;
}) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const number = version?.version ?? 0;
  const prior = previousVersion(kept, number);
  const detail = useQuery({
    queryKey: ["knowledge-source", sourceId, "history", number],
    queryFn: () => apiRequest<KnowledgeVersionDetail>(`${sourcePath(sourceId)}/history/${number}`),
    enabled: version !== null,
  });
  const previous = useQuery({
    queryKey: ["knowledge-source", sourceId, "history", prior],
    queryFn: () => apiRequest<KnowledgeVersionDetail>(`${sourcePath(sourceId)}/history/${prior}`),
    enabled: version !== null && prior !== null,
  });
  const restore = useMutation({
    mutationFn: () =>
      apiRequest<{ version: number }>(`${sourcePath(sourceId)}/restore/${number}`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      toast.success(t("knowledge.versions.restored", { from: number, to: result.version }));
      void client.invalidateQueries({ queryKey: ["knowledge-source", sourceId] });
      void client.invalidateQueries({ queryKey: ["catalog"] });
      onClose();
    },
    onError: () => toast.error(t("common.actionFailed")),
  });

  const why = version ? versionWhy(version.note, directory, t) : null;
  const facts: Fact[] = version
    ? [
        { label: t("knowledge.versions.savedBy"), value: authorName(version.author, directory, t) },
        ...(why ? [{ label: t("knowledge.versions.why"), value: why }] : []),
        { label: t("knowledge.versions.at"), value: dateTime(version.created_at) },
      ]
    : [];
  const loading = detail.isPending || (prior !== null && previous.isPending);
  const failed = Boolean(detail.error || previous.error);
  const rows =
    detail.data && (prior === null || previous.data)
      ? versionChange(previous.data?.documents ?? [], detail.data.documents)
      : [];

  return (
    <RecordSheet
      open={version !== null}
      onOpenChange={(open) => !open && onClose()}
      title={version ? `${sourceName} · v${version.version}` : ""}
      subtitle={
        version
          ? `${authorName(version.author, directory, t)} · ${dateTime(version.created_at)}`
          : undefined
      }
      badge={version ? versionBadge(version, t) : undefined}
      action={
        version && canWrite && !version.current ? (
          <Button
            pending={restore.isPending}
            onClick={() => restore.mutate()}
            data-testid="knowledge-version-restore"
          >
            {t("knowledge.versions.restore")}
          </Button>
        ) : undefined
      }
      testId="knowledge-version-sheet"
      closeTestId="knowledge-version-close"
    >
      {version ? (
        <div className="flex flex-col gap-6">
          <FactList items={facts} testId="knowledge-version-facts" />
          {loading ? (
            <DataState state="loading" />
          ) : failed || !detail.data ? (
            <DataState
              state="error"
              line={t("knowledge.versions.loadFailed")}
              onRetry={() => {
                void detail.refetch();
                if (prior !== null) void previous.refetch();
              }}
              testId="knowledge-version-failed"
            />
          ) : prior === null ? (
            <Section label={t("knowledge.versions.content")} testId="knowledge-version-content">
              <FilePreview
                name=""
                mimeType="text/markdown"
                text={versionText(detail.data.documents)}
              />
            </Section>
          ) : (
            <Section
              label={t("knowledge.versions.changeSince", { version: prior })}
              testId="knowledge-version-change"
            >
              {rows.length > 0 ? (
                <FocusedDiff rows={rows} testId="knowledge-version-diff" />
              ) : (
                <p className="text-sm text-muted-foreground">{t("knowledge.versions.unchanged")}</p>
              )}
            </Section>
          )}
          <p className="text-sm text-muted-foreground" data-testid="knowledge-version-hint">
            {restoreHint(version, latest, t)}
          </p>
        </div>
      ) : null}
    </RecordSheet>
  );
}
