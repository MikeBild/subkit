import type { components } from "@cli-core/engine-api/openapi";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { apiCall } from "@/api/call";
import { ApiError } from "@/api/client";
import { useActorDirectory } from "@/app/actor-directory";
import { type ActorDirectory, actorDirectoryName } from "@/app/actor-directory-model";
import { useLiveQueryOptions } from "@/app/live-events";
import { VersionChange } from "@/components/cockpit/diff-card";
import { RestoreVersionConfirm } from "@/components/cockpit/knowledge-versions";
import {
  Button,
  CollapsibleSection,
  DataState,
  type Fact,
  FactList,
  RecordSheet,
  StatusBadge,
  TabBody,
  Timeline,
} from "@/components/cockpit/patterns";
import { useI18n } from "@/lib/i18n-context";
import { useSearchParamState } from "@/lib/use-search-param-state";
import { keptVersionCount } from "@/pages/knowledge-versions-model";
import {
  type SkillVersionRow,
  skillHistoryGap,
  skillStateLabelKey,
  skillVersionBasis,
  skillVersionChange,
  skillVersionRows,
} from "@/pages/skills-model";
import { useSkillHistory } from "./skills-queries";

type Skill = components["schemas"]["Skill"];
type Translate = ReturnType<typeof useI18n>["t"];

function actorName(directory: ActorDirectory, id: string | null, t: Translate): string {
  return (
    actorDirectoryName(directory, "user", id) ??
    actorDirectoryName(directory, "system_account", id) ??
    t("runs.caller.unknown")
  );
}

export function SkillVersions({ skill, canWrite }: { skill: Skill; canWrite: boolean }) {
  const { t, dateTime } = useI18n();
  const client = useQueryClient();
  const live = useLiveQueryOptions();
  const directory = useActorDirectory(true);
  const [selected, setSelected] = useSearchParamState("version", "");
  const history = useSkillHistory(skill.id, true, live);
  const restore = useMutation({
    mutationFn: (entry: SkillVersionRow) =>
      apiCall("post", "/v1/skills/{id}/restore", {
        path: { id: skill.id },
        body: { audit_entry_id: entry.audit_entry_id },
      }),
    onSuccess: (saved) => {
      toast.success(t("skills.versions.restored", { version: saved.version }));
      client.setQueryData(["skill", saved.id], saved);
      void client.invalidateQueries({ queryKey: ["skill", saved.id, "history"] });
      void client.invalidateQueries({ queryKey: ["catalog"] });
      setSelected("");
    },
    onError: (error) =>
      toast.error(
        error instanceof ApiError && error.status === 409
          ? t("skills.conflict")
          : t("common.actionFailed"),
      ),
  });
  const rows = skillVersionRows(history.data?.items ?? [], skill.version);
  const gap = skillHistoryGap(rows, skill.version);
  const open = rows.find((row) => row.audit_entry_id === selected) ?? null;
  const label = (row: SkillVersionRow) =>
    row.version === null
      ? t("skills.versions.unnumbered")
      : t("skills.versions.entry", { version: row.version });
  return (
    <TabBody
      testId="skill-versions"
      summary={
        history.data
          ? t(
              keptVersionCount(rows.length) === 1 ? "skills.versions.one" : "skills.versions.other",
              { count: keptVersionCount(rows.length) },
            )
          : undefined
      }
    >
      {history.isPending ? (
        <DataState state="loading" />
      ) : history.error ? (
        <DataState
          state="error"
          line={t("skills.versions.loadFailed")}
          onRetry={() => void history.refetch()}
          testId="skill-versions-failed"
        />
      ) : rows.length === 0 ? (
        <DataState state="empty" line={t("skills.versions.empty")} testId="skill-versions-empty" />
      ) : (
        <Timeline
          testId="skill-versions-timeline"
          groups={[
            {
              items: rows.map((row) => ({
                id: row.audit_entry_id,
                tone: row.current ? "info" : "neutral",
                title: label(row),
                meta: `${t(skillStateLabelKey(row.lifecycle ?? "active"))} · ${actorName(directory, row.actor_id, t)}`,
                aside: (
                  <>
                    {row.current ? (
                      <StatusBadge state="active" label={t("knowledge.versions.current")} />
                    ) : null}
                    <span className="text-xs text-muted-foreground">
                      {dateTime(row.updated_at)}
                    </span>
                  </>
                ),
                onOpen: () => setSelected(row.audit_entry_id),
                label: label(row),
                testId: `skill-version-${row.audit_entry_id}`,
              })),
            },
          ]}
        />
      )}
      {history.data && gap ? (
        <p className="text-sm text-muted-foreground" data-testid="skill-versions-gap">
          {gap.through === 1
            ? t("skills.versions.gap.one")
            : t("skills.versions.gap.other", { through: gap.through })}
        </p>
      ) : null}
      <SkillVersionSheet
        skillId={skill.id}
        row={open}
        rows={rows}
        label={open ? label(open) : ""}
        canWrite={canWrite}
        restoring={restore.isPending}
        onRestore={(row) => restore.mutateAsync(row)}
        directory={directory}
        onClose={() => setSelected("")}
      />
    </TabBody>
  );
}

function SkillVersionSheet({
  skillId,
  row,
  rows,
  label,
  canWrite,
  restoring,
  onRestore,
  directory,
  onClose,
}: {
  skillId: string;
  row: SkillVersionRow | null;
  rows: readonly SkillVersionRow[];
  label: string;
  canWrite: boolean;
  restoring: boolean;
  onRestore: (row: SkillVersionRow) => Promise<unknown>;
  directory: ActorDirectory;
  onClose: () => void;
}) {
  const { t, dateTime } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const entryId = row?.audit_entry_id ?? "";
  const detail = useQuery({
    queryKey: ["skill", skillId, "history", entryId],
    queryFn: () =>
      apiCall("get", "/v1/skills/{id}/history/{audit_entry_id}", {
        path: { id: skillId, audit_entry_id: entryId },
      }),
    enabled: row?.has_snapshot === true,
  });
  const change = detail.data ? skillVersionChange(detail.data) : null;
  const basis = row ? skillVersionBasis(rows, row) : null;
  const author = row ? actorName(directory, row.actor_id, t) : "";
  const facts: Fact[] = row
    ? [
        { label: t("knowledge.versions.savedBy"), value: author },
        { label: t("knowledge.versions.at"), value: dateTime(row.updated_at) },
        {
          label: t("resource.field.status"),
          value: t(skillStateLabelKey(row.lifecycle ?? "active")),
        },
        ...(row.title ? [{ label: t("common.name"), value: row.title }] : []),
        ...(change?.renamedFrom
          ? [{ label: t("skills.versions.renamedFrom"), value: change.renamedFrom }]
          : []),
      ]
    : [];
  return (
    <RecordSheet
      open={row !== null}
      onOpenChange={(next) => !next && onClose()}
      title={label}
      subtitle={row ? `${author} · ${dateTime(row.updated_at)}` : undefined}
      badge={
        row?.current ? (
          <StatusBadge state="active" label={t("knowledge.versions.current")} />
        ) : undefined
      }
      action={
        row && canWrite && row.restorable ? (
          <Button
            pending={restoring}
            onClick={() => setConfirming(true)}
            data-testid="skill-version-restore"
          >
            {t("knowledge.versions.restore")}
          </Button>
        ) : undefined
      }
      testId="skill-version-sheet"
      closeTestId="skill-version-close"
    >
      {row ? (
        <div className="flex flex-col gap-6">
          <FactList testId="skill-version-facts" items={facts} />
          {!row.has_snapshot ? null : detail.isPending ? (
            <DataState state="loading" />
          ) : detail.error ? (
            <DataState
              state="error"
              line={t("skills.versions.loadFailed")}
              onRetry={() => void detail.refetch()}
              testId="skill-version-failed"
            />
          ) : change ? (
            <VersionChange
              label={
                basis !== null
                  ? t("knowledge.versions.changeSince", { version: basis })
                  : t("skills.versions.change")
              }
              rows={change.rows}
              testId="skill-version"
            />
          ) : null}
          <p className="text-sm text-muted-foreground" data-testid="skill-version-hint">
            {row.current
              ? t("skills.versions.currentHint")
              : row.restorable
                ? t("skills.versions.restoreHint")
                : t("skills.versions.noSnapshot")}
          </p>
          <CollapsibleSection label={t("common.technical")} testId="skill-version-technical">
            <FactList
              items={[
                {
                  label: t("skills.versions.auditEntry"),
                  value: <span className="font-mono text-xs">{row.audit_entry_id}</span>,
                },
              ]}
            />
          </CollapsibleSection>
          <RestoreVersionConfirm
            open={confirming}
            onOpenChange={setConfirming}
            pending={restoring}
            onConfirm={() => onRestore(row)}
            testId="skill-version-restore-confirm"
          />
        </div>
      ) : null}
    </RecordSheet>
  );
}
