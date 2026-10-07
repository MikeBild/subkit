import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiRequest } from "@/api/client";
import {
  Button,
  type CockpitColumn,
  CollapsibleSection,
  type Fact,
  FactList,
  RecordSheet,
  StatusBadge,
} from "@/components/cockpit/patterns";
import { RecordTable } from "@/components/cockpit/record-table";
import { MISSING, tableColumns } from "@/components/cockpit/table-columns";
import type { TranslationKey } from "@/lib/i18n";
import { useI18n } from "@/lib/i18n-context";
import { useInfiniteList } from "@/lib/use-infinite-list";
import {
  restoredFrom,
  VERSION_BADGE_STATES,
  VERSION_STATE_KEYS,
  type WorkflowVersion,
  type WorkflowVersionIds,
  workflowVersionSheetCopy,
  workflowVersionState,
  workflowVersionView,
} from "@/lib/workflow-versions";

const VERSION_PAGE = 20;

type Translate = (key: TranslationKey, values?: Record<string, string | number>) => string;

function versionNote(note: string | null, t: Translate): string {
  const from = restoredFrom(note);
  if (from !== null) return t("workflowVersions.restoredFrom", { version: `v${from}` });
  return note?.trim() || MISSING;
}

function VersionBadge({ version, ids }: { version: WorkflowVersion; ids: WorkflowVersionIds }) {
  const { t } = useI18n();
  const state = workflowVersionState(version, ids);
  return <StatusBadge state={VERSION_BADGE_STATES[state]} label={t(VERSION_STATE_KEYS[state])} />;
}

export function WorkflowVersions({
  workflowId,
  workflowName,
  ids,
  canRestore,
  onRestored,
}: {
  workflowId: string;
  workflowName: string;
  ids: WorkflowVersionIds;
  canRestore: boolean;
  onRestored: () => void;
}) {
  const { t, dateTime } = useI18n();
  const [open, setOpen] = useState<WorkflowVersion | null>(null);
  const list = useInfiniteList<WorkflowVersion>(
    `/v1/workflows/${encodeURIComponent(workflowId)}/history`,
    {},
    { queryKey: ["workflow", workflowId, "versions"], limit: VERSION_PAGE },
  );
  const newest = list.first?.items[0];
  const columns = useMemo<CockpitColumn<WorkflowVersion>[]>(() => {
    const column = tableColumns<WorkflowVersion>({ t, dateTime });
    return [
      column.custom(
        "version",
        (version) => version.version,
        t("workflowVersions.column.version"),
        (version) => `v${version.version}`,
        { width: "w-[14%]" },
      ),
      column.custom(
        "note",
        (version) => version.note,
        t("workflowVersions.column.change"),
        (version) => versionNote(version.note, t),
        { width: "w-[44%]" },
      ),
      column.date("saved", (version) => version.created_at, t("workflowVersions.column.saved"), {
        width: "w-[24%]",
      }),
      column.custom(
        "state",
        (version) => version.id,
        t("resource.field.status"),
        (version) => <VersionBadge version={version} ids={ids} />,
        { width: "w-[18%]" },
      ),
    ];
  }, [t, dateTime, ids]);
  const failed = Boolean(list.query.error || list.query.failureReason) && list.items.length === 0;
  return (
    <CollapsibleSection
      label={t("workflowVersions.title")}
      count={list.total}
      testId="workflow-versions"
    >
      <RecordTable
        columns={columns}
        data={list.items}
        collectionId="workflow-versions"
        emptyLine={t("workflowVersions.empty")}
        pending={list.query.isPending && !failed}
        error={
          failed
            ? { line: t("workflowVersions.loadFailed"), onRetry: () => void list.query.refetch() }
            : null
        }
        infinite={list.infinite}
        total={list.total}
        getRowId={(version) => version.id}
        onOpen={(version) => setOpen(version)}
        rowLabel={(version) => `v${version.version}`}
      />
      {open ? (
        <WorkflowVersionSheet
          version={open}
          newest={newest}
          ids={ids}
          workflowId={workflowId}
          workflowName={workflowName}
          canRestore={canRestore}
          onClose={() => setOpen(null)}
          onRestored={onRestored}
        />
      ) : null}
    </CollapsibleSection>
  );
}

function WorkflowVersionSheet({
  version,
  newest,
  ids,
  workflowId,
  workflowName,
  canRestore,
  onClose,
  onRestored,
}: {
  version: WorkflowVersion;
  newest: WorkflowVersion | undefined;
  ids: WorkflowVersionIds;
  workflowId: string;
  workflowName: string;
  canRestore: boolean;
  onClose: () => void;
  onRestored: () => void;
}) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const view = workflowVersionView(version, newest, ids);
  const label = `v${version.version}`;
  const next = view.nextVersion === null ? MISSING : `v${view.nextVersion}`;
  const restore = useMutation({
    mutationFn: () =>
      apiRequest<{ current_version?: number | null }>(
        `/v1/workflows/${encodeURIComponent(workflowId)}/restore/${version.version}`,
        { method: "POST" },
      ),
    onSuccess: async (result) => {
      toast.success(
        t("workflowVersions.restored", {
          from: label,
          next: typeof result?.current_version === "number" ? `v${result.current_version}` : next,
        }),
      );
      onClose();
      onRestored();
      await Promise.all([
        client.invalidateQueries({ queryKey: ["workflow", workflowId, "versions"] }),
        client.invalidateQueries({ queryKey: ["catalog-detail", "workflows", workflowId] }),
        client.invalidateQueries({ queryKey: ["attention"] }),
      ]);
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError && error.status === 422
          ? t("workflowVersions.notRestorable")
          : t("common.actionFailed"),
      ),
  });
  const copy = workflowVersionSheetCopy(view, canRestore);
  const facts: Fact[] = [
    { label: t("workflowVersions.fact.version"), value: label },
    { label: t("workflowVersions.fact.saved"), value: dateTime(version.created_at) },
    { label: t("workflowVersions.fact.note"), value: versionNote(version.note, t) },
  ];
  return (
    <RecordSheet
      open
      onOpenChange={(isOpen) => !isOpen && !restore.isPending && onClose()}
      title={`${workflowName} · ${label}`}
      titleTestId="workflow-version-title"
      badge={<VersionBadge version={version} ids={ids} />}
      action={
        copy.restore ? (
          <Button
            pending={restore.isPending}
            onClick={() => restore.mutate()}
            data-testid="workflow-version-restore"
          >
            {t("workflowVersions.restore")}
          </Button>
        ) : undefined
      }
      testId="workflow-version-sheet"
      closeTestId="workflow-version-sheet-close"
    >
      <FactList items={facts} testId="workflow-version-facts" />
      <p className="text-sm text-muted-foreground" data-testid="workflow-version-hint">
        {t(copy.hint, copy.values)}
      </p>
    </RecordSheet>
  );
}
