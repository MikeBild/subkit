import type { MessageKey } from "../../../shared/i18n.ts";
import type { LocalMoved, LocalView } from "../../../shared/ipc.ts";
import {
  type BackupRow,
  megabytes,
  moveServerTarget,
} from "../../../shared/local/local-workspace-model.ts";

export interface BackupItem {
  name: string;
  at: number;
  label: MessageKey;
  sizeMb: number | null;
}

const BACKUP_LABEL: Record<BackupRow["reason"], MessageKey> = {
  update: "workspace.automatic",
  restore: "workspace.beforeRestore",
  manual: "workspace.manual",
};

export function backupItems(rows: BackupRow[]): BackupItem[] {
  return rows.map((row) => ({
    name: row.name,
    at: row.at,
    label: BACKUP_LABEL[row.reason],
    sizeMb: megabytes(row.sizeBytes),
  }));
}

export interface LocalWorkspaceModel {
  folder: string;
  sizeMb: number | null;
  running: boolean;
  backups: BackupItem[];
  creating: boolean;
  restoring: boolean;
  removing: boolean;
  locked: boolean;
  moved: LocalMoved | null;
  aiMissing: boolean;
  modelWithoutTools: boolean;
  error: "restore" | "move" | null;
}

export function localWorkspaceFor(local: LocalView): LocalWorkspaceModel {
  return {
    folder: local.folder,
    sizeMb: megabytes(local.sizeBytes),
    running: local.progress.engine && local.error === null,
    backups: backupItems(local.backups),
    creating: local.busy === "backup",
    restoring: local.busy === "restore",
    removing: local.busy === "remove",
    locked: local.busy !== null,
    moved: local.moved,
    aiMissing: !local.aiConfigured,
    modelWithoutTools: local.modelTools === false,
    error: local.error === "restore" || local.error === "move" ? local.error : null,
  };
}

export type MoveStep = 0 | 1 | 2;

export interface MoveModel {
  step: MoveStep;
  origin: string | null;
  busy: boolean;
  canContinue: boolean;
  urlError: boolean;
}

export function moveModel(
  step: MoveStep,
  local: Pick<LocalView, "busy" | "moved">,
  url: string,
  tried: boolean,
): MoveModel {
  const origin = moveServerTarget(url);
  const busy = local.busy === "move";
  const current: MoveStep = local.moved ? 2 : step;
  return {
    step: current,
    origin,
    busy,
    canContinue: current === 0 ? url.trim() !== "" : current === 1 ? !busy : local.moved !== null,
    urlError: tried && current === 0 && origin === null,
  };
}
