import {
  BrowserDownloadArgsSchema,
  BrowserExtractArgsSchema,
  BrowserFillArgsSchema,
  BrowserHandoverArgsSchema,
  BrowserOpenArgsSchema,
  BrowserPageArgsSchema,
  BrowserPayArgsSchema,
  BrowserPressArgsSchema,
  BrowserSignInArgsSchema,
  BrowserWaitArgsSchema,
} from "@shared/device/browser.ts";
import {
  ComputerAppsArgsSchema,
  ComputerHandoverArgsSchema,
  ComputerKeyArgsSchema,
  ComputerRefArgsSchema,
  ComputerScrollArgsSchema,
  ComputerSelectArgsSchema,
  ComputerSetValueArgsSchema,
  ComputerTypeArgsSchema,
  ComputerWindowArgsSchema,
} from "@shared/device/computer.ts";
import {
  FilesImportArgsSchema,
  FilesListArgsSchema,
  FilesMkdirArgsSchema,
  FilesMoveArgsSchema,
  FilesReadTextArgsSchema,
  FilesTrashArgsSchema,
  FilesWriteArgsSchema,
} from "@shared/device/files.ts";
import type { DeviceCommandKind, DeviceResult } from "@shared/device/protocol.ts";
import type { z } from "zod";
import {
  type ClosureState,
  closureOutcome,
  resultOutcome,
  type StepOutcome,
} from "./command-state.ts";
import type { LocalSourceRefusal } from "./run-source.ts";

export const DEVICE_ARGS_SCHEMAS: Readonly<Record<DeviceCommandKind, z.ZodType | null>> = {
  "files.list": FilesListArgsSchema,
  "files.read_text": FilesReadTextArgsSchema,
  "files.import": FilesImportArgsSchema,
  "files.write": FilesWriteArgsSchema,
  "files.mkdir": FilesMkdirArgsSchema,
  "files.move": FilesMoveArgsSchema,
  "files.trash": FilesTrashArgsSchema,
  "browser.open": BrowserOpenArgsSchema,
  "browser.wait": BrowserWaitArgsSchema,
  "browser.extract": BrowserExtractArgsSchema,
  "browser.fill": BrowserFillArgsSchema,
  "browser.press": BrowserPressArgsSchema,
  "browser.download": BrowserDownloadArgsSchema,
  "browser.pdf": null,
  "browser.snapshot": BrowserPageArgsSchema,
  "browser.screenshot": BrowserPageArgsSchema,
  "browser.handover": BrowserHandoverArgsSchema,
  "browser.sign_in": BrowserSignInArgsSchema,
  "browser.pay": BrowserPayArgsSchema,
  "computer.apps": ComputerAppsArgsSchema,
  "computer.open": null,
  "computer.snapshot": ComputerWindowArgsSchema,
  "computer.find": null,
  "computer.screenshot": ComputerWindowArgsSchema,
  "computer.press": ComputerRefArgsSchema,
  "computer.focus": ComputerRefArgsSchema,
  "computer.select": ComputerSelectArgsSchema,
  "computer.set_value": ComputerSetValueArgsSchema,
  "computer.type": ComputerTypeArgsSchema,
  "computer.key": ComputerKeyArgsSchema,
  "computer.scroll": ComputerScrollArgsSchema,
  "computer.handover": ComputerHandoverArgsSchema,
};

export type CommandArgsParse =
  | { readonly ok: true; readonly args: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly code: "local_command_unsupported" | "local_args_invalid";
      readonly issues: readonly string[];
    };

export function parseCommandArgs(kind: DeviceCommandKind, value: unknown): CommandArgsParse {
  const schema = DEVICE_ARGS_SCHEMAS[kind];
  if (schema === null) return { ok: false, code: "local_command_unsupported", issues: [kind] };
  const parsed = schema.safeParse(value ?? {});
  if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
  return {
    ok: false,
    code: "local_args_invalid",
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "args"}: ${issue.message}`,
    ),
  };
}

export type DispatchedCommand =
  | { readonly kind: "refused"; readonly code: LocalSourceRefusal }
  | { readonly kind: "result"; readonly result: DeviceResult }
  | { readonly kind: "closed"; readonly closure: ClosureState; readonly effect: "read" | "write" };

export const SOURCE_REFUSAL_MESSAGE =
  "Only the person of this device may start browser or computer steps on it, from a chat, a task, a run they start or a schedule they set up. Nothing ran.";

export function dispatchedOutcome(outcome: DispatchedCommand): StepOutcome {
  if (outcome.kind === "refused")
    return { status: "failed", code: outcome.code, message: SOURCE_REFUSAL_MESSAGE };
  return outcome.kind === "result"
    ? resultOutcome(outcome.result)
    : closureOutcome(outcome.closure, outcome.effect);
}
