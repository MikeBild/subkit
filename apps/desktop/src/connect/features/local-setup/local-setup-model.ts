import { loopbackModelOrigin } from "../../../../../../packages/shared/src/local-model-server.ts";
import type { MessageKey } from "../../../shared/i18n.ts";
import type { LocalFinishInput } from "../../../shared/ipc.ts";
import {
  type AiProvider,
  LOCAL_SETUP_STEPS,
  type LocalErrorKind,
  type LocalSetupStep,
  ownerName,
  type SetupPhase,
} from "../../../shared/local/local-workspace-model.ts";
import type { LocalSetupModel } from "../../domain/index.ts";

export type AiKind = "provider" | "model";

export interface SetupForm {
  name: string;
  aiKind: AiKind;
  provider: AiProvider;
  key: string;
  origin: string;
  aiError: boolean;
}

export const DEFAULT_MODEL_SERVER = "http://localhost:11434";

export const INITIAL_FORM: SetupForm = {
  name: "",
  aiKind: "provider",
  provider: "anthropic",
  key: "",
  origin: DEFAULT_MODEL_SERVER,
  aiError: false,
};

export type FormChange =
  | { field: "name"; value: string }
  | { field: "aiKind"; value: AiKind }
  | { field: "provider"; value: AiProvider }
  | { field: "key"; value: string }
  | { field: "origin"; value: string }
  | { field: "aiError"; value: boolean };

export function editForm(form: SetupForm, change: FormChange): SetupForm {
  switch (change.field) {
    case "name":
      return { ...form, name: change.value };
    case "aiKind":
      return change.value === form.aiKind
        ? form
        : { ...form, aiKind: change.value, key: "", aiError: false };
    case "provider":
      return { ...form, provider: change.value, aiError: false };
    case "key":
      return { ...form, key: change.value, aiError: false };
    case "origin":
      return { ...form, origin: change.value, aiError: false };
    case "aiError":
      return { ...form, aiError: change.value };
  }
}

export function stepName(step: number): LocalSetupStep {
  return LOCAL_SETUP_STEPS[step] ?? "setting";
}

export function finishInput(form: SetupForm): LocalFinishInput | null {
  const name = ownerName(form.name);
  if (!name) return null;
  if (form.aiKind === "provider") {
    const key = form.key.trim();
    return key ? { name, ai: { kind: "provider", provider: form.provider, key } } : null;
  }
  const origin = loopbackModelOrigin(form.origin);
  return origin ? { name, ai: { kind: "model", origin } } : null;
}

export function skipInput(form: SetupForm): LocalFinishInput | null {
  const name = ownerName(form.name);
  return name ? { name, ai: null } : null;
}

export function canContinue(screen: LocalSetupModel, form: SetupForm): boolean {
  switch (screen.step) {
    case 0:
      return screen.folderRefusal === null && !screen.working;
    case 1:
      return ownerName(form.name) !== null;
    case 2:
      return form.aiKind === "provider" ? form.key.trim() !== "" : form.origin.trim() !== "";
    default:
      return screen.done && screen.error === null;
  }
}

export function aiFieldError(form: SetupForm, error: LocalErrorKind | null): MessageKey | null {
  if (form.aiKind === "provider" && error === "keyRejected") return "workspace.keyError";
  if (!form.aiError) return null;
  return form.aiKind === "provider" ? "workspace.keyError" : "workspace.originError";
}

export type SetupRemedy = "retry" | "port" | "folder";

export interface ErrorCopy {
  title: MessageKey;
  body: MessageKey | null;
  remedy: SetupRemedy;
}

export function errorCopy(kind: LocalErrorKind): ErrorCopy {
  switch (kind) {
    case "port":
      return { title: "workspace.err.port.title", body: "workspace.err.port.body", remedy: "port" };
    case "disk":
      return {
        title: "workspace.err.disk.title",
        body: "workspace.err.disk.body",
        remedy: "retry",
      };
    case "permission":
      return {
        title: "workspace.err.permission.title",
        body: "workspace.err.permission.body",
        remedy: "folder",
      };
    case "folder":
      return {
        title: "workspace.err.folder.title",
        body: "workspace.folderError",
        remedy: "folder",
      };
    case "keyRejected":
      return {
        title: "workspace.err.keyRejected.title",
        body: "workspace.keyError",
        remedy: "retry",
      };
    case "restore":
      return {
        title: "workspace.err.restore.title",
        body: "workspace.err.restore.body",
        remedy: "retry",
      };
    case "move":
      return {
        title: "workspace.err.move.title",
        body: "workspace.err.move.body",
        remedy: "retry",
      };
    case "database":
      return {
        title: "workspace.err.database.title",
        body: "workspace.err.database.body",
        remedy: "retry",
      };
    case "version":
      return {
        title: "workspace.err.version.title",
        body: "workspace.err.version.body",
        remedy: "retry",
      };
    case "failed":
      return {
        title: "workspace.err.failed.title",
        body: "workspace.err.failed.body",
        remedy: "retry",
      };
  }
}

export const ERROR_CODES: Record<LocalErrorKind, string> = {
  port: "local_port_busy",
  disk: "local_disk_full",
  permission: "local_permission_denied",
  folder: "local_folder_refused",
  keyRejected: "llm_key_rejected",
  database: "local_database_failed",
  version: "local_version_newer",
  failed: "local_start_failed",
  restore: "local_restore_failed",
  move: "local_move_failed",
};

export const PHASE_LABEL: Record<SetupPhase, MessageKey> = {
  database: "workspace.phase.database",
  engine: "workspace.phase.engine",
  workspace: "workspace.phase.workspace",
};

export const STEP_LABEL: Record<LocalSetupStep, MessageKey> = {
  folder: "workspace.step.folder",
  you: "workspace.step.you",
  ai: "workspace.step.ai",
  setting: "workspace.step.setting",
};
