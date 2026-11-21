import { Button } from "@ui/atoms/button";
import { Panel, Pill } from "@ui/atoms/pill";
import { Skel } from "@ui/atoms/skeleton";
import { StatusDot } from "@ui/atoms/status-dot";
import { EmptyState } from "@ui/molecules/empty-state";
import { ErrorNotice } from "@ui/molecules/error-notice";
import { SettingsRow } from "@ui/molecules/settings-row";
import { ConfirmDialog } from "@ui/organisms/confirm-dialog";
import { Folder, Server } from "lucide-react";
import { useState } from "react";
import { useSignIn } from "../../adapter/index.ts";
import { localWorkspaceFor } from "./local-workspace-model.ts";
import { MoveLocalWorkspace } from "./MoveLocalWorkspace.tsx";

export function LocalWorkspace() {
  const { main, t, dispatch } = useSignIn();
  const [move, setMove] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  if (!main?.local.configured) return null;
  const m = localWorkspaceFor(main.local);
  const when = new Intl.DateTimeFormat(main.locale, { dateStyle: "medium", timeStyle: "short" });
  const status = (
    <span className="inline-flex items-center gap-2 text-sm">
      <StatusDot tone={m.running ? "success" : "neutral"} />
      {t(m.running ? "workspace.running" : "workspace.stopped")}
    </span>
  );
  return (
    <>
      <Panel className="divide-y px-3 py-0">
        <h2 className="py-2 text-sm font-semibold">{t("workspace.section")}</h2>
        <SettingsRow label={t("workspace.step.folder")}>
          <span className="break-all text-right font-mono text-xs">
            {m.folder}
            {m.sizeMb !== null && ` · ${t("workspace.size", { n: m.sizeMb })}`}
          </span>
        </SettingsRow>
        <SettingsRow label={t("workspace.phase.engine")}>{status}</SettingsRow>
        <SettingsRow label={t("workspace.phase.database")}>{status}</SettingsRow>
      </Panel>
      {m.moved && (
        <ErrorNotice
          testId="local-moved"
          tone="warning"
          kind="local_workspace_moved"
          title={t("workspace.moved.title")}
          body={t("workspace.moved.body", { server: m.moved.server })}
          primary={{
            label: t("workspace.moved.action"),
            onClick: () => m.moved && dispatch({ type: "LocalMoveSignIn", origin: m.moved.server }),
          }}
        />
      )}
      {!m.moved && m.aiMissing && (
        <ErrorNotice
          testId="local-ai-missing"
          tone="warning"
          kind="ai_access_missing"
          title={t("workspace.aiMissing.title")}
          body={t("workspace.aiMissing.body")}
        />
      )}
      {!m.moved && m.modelWithoutTools && (
        <ErrorNotice
          testId="local-model-tools"
          tone="warning"
          kind="model_tools_missing"
          title={t("workspace.modelTools.title")}
          body={t("workspace.modelTools.body")}
        />
      )}
      <Panel className={m.moved ? "hidden" : "px-3 py-2"}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold">{t("workspace.backups")}</h2>
          <Button
            data-testid="local-backup-create"
            size="sm"
            variant="outline"
            className="relative min-w-44"
            disabled={m.locked}
            onClick={() => dispatch({ type: "LocalBackup" })}
          >
            <span className={m.creating ? "invisible" : undefined}>
              {t("workspace.createBackup")}
            </span>
            {m.creating && (
              <span className="absolute inset-0 flex items-center justify-center">
                <Skel.Line className="w-28" />
              </span>
            )}
          </Button>
        </div>
        {m.backups.length === 0 ? (
          <EmptyState icon={Folder} title={t("workspace.noBackups")} />
        ) : (
          <ul className="divide-y">
            {m.backups.map((backup) => (
              <li key={backup.name} className="flex flex-wrap items-center gap-2 py-1.5">
                <Folder className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1 text-sm">
                  {when.format(backup.at)}
                  {backup.sizeMb !== null && (
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {t("workspace.size", { n: backup.sizeMb })}
                    </span>
                  )}
                </span>
                <Pill tone="neutral">{t(backup.label)}</Pill>
                <ConfirmDialog
                  testId="local-restore-confirm"
                  trigger={
                    <Button
                      data-testid={`local-restore-${backup.name}`}
                      size="sm"
                      variant="outline"
                      className="relative min-w-32"
                      disabled={m.locked}
                    >
                      <span
                        className={
                          m.restoring && restoring === backup.name ? "invisible" : undefined
                        }
                      >
                        {t("workspace.restore")}
                      </span>
                      {m.restoring && restoring === backup.name && (
                        <span className="absolute inset-0 flex items-center justify-center">
                          <Skel.Line className="w-20" />
                        </span>
                      )}
                    </Button>
                  }
                  title={t("workspace.restoreTitle", { name: when.format(backup.at) })}
                  consequence={t("workspace.restoreBody")}
                  confirmLabel={t("workspace.restore")}
                  onConfirm={() => {
                    setRestoring(backup.name);
                    dispatch({ type: "LocalRestore", name: backup.name });
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      {m.error && (
        <ErrorNotice
          testId="local-workspace-error"
          kind={m.error === "restore" ? "local_restore_failed" : "local_move_failed"}
          title={t(
            m.error === "restore" ? "workspace.err.restore.title" : "workspace.err.move.title",
          )}
          body={t(m.error === "restore" ? "workspace.err.restore.body" : "workspace.err.move.body")}
        />
      )}
      <Panel className={m.moved ? "hidden" : "px-3 py-2"}>
        <div className="flex items-start gap-3">
          <Server className="mt-0.5 size-4 shrink-0" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t("workspace.move")}</p>
            <p className="text-sm text-muted-foreground">{t("workspace.moveHint")}</p>
          </div>
        </div>
        <Button
          data-testid="local-move"
          size="sm"
          variant="outline"
          className="mt-3 h-auto min-h-10 max-w-full whitespace-normal"
          disabled={m.locked}
          onClick={() => setMove(true)}
        >
          {t("workspace.move")}
        </Button>
      </Panel>
      <Panel className="px-3 py-2">
        <p className="text-sm font-semibold">{t("workspace.removeAll")}</p>
        <p className="text-sm text-muted-foreground">{t("workspace.removeAll.hint")}</p>
        <ConfirmDialog
          destructive
          testId="local-remove-all-confirm"
          trigger={
            <Button
              data-testid="local-remove-all"
              size="sm"
              variant="outline"
              className="mt-3 h-auto min-h-10 max-w-full whitespace-normal"
              disabled={m.locked}
            >
              {t("workspace.removeAll")}
            </Button>
          }
          title={t("workspace.removeAll.title", { folder: m.folder })}
          consequence={t("workspace.removeAll.body")}
          confirmLabel={t("workspace.removeAll.action")}
          onConfirm={() => dispatch({ type: "LocalRemoveAll" })}
        />
      </Panel>
      <p className="text-xs text-muted-foreground">{t("workspace.hint")}</p>
      <MoveLocalWorkspace open={move} onClose={() => setMove(false)} />
    </>
  );
}
