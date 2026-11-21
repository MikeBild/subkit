import { createHash } from "node:crypto";
import { FILE_DIALOG_REFUSAL } from "@shared/device/computer.ts";
import type { DeviceEvidence } from "@shared/device/protocol.ts";

export interface DeviceStepError {
  code: string;
  message: string;
  guidance?: string;
  details?: unknown;
}

interface Remedy {
  readonly message: string;
  readonly guidance: string;
}

const RENEW = "Open the workflow, review its approval on this device and approve it again.";
const DEVICE_SETTINGS = "Open SubKit on the device and check Settings › Local capabilities.";

export const DEVICE_STEP_REMEDIES: Readonly<Record<string, Remedy>> = {
  outside_allowance: {
    message: "The device does not allow this folder, website or app. Nothing was changed.",
    guidance: `${DEVICE_SETTINGS} Allow the folder, website or app, then run again.`,
  },
  outside_boundary: {
    message: "This step goes beyond what the workflow's approval names. Nothing was changed.",
    guidance: `${RENEW} A value filled in while the run goes must stay inside the approved folders, websites and apps.`,
  },
  folder_changed: {
    message:
      "The allowed folder was replaced on the device since the approval. Nothing was changed.",
    guidance: `Allow the folder again on the device. ${RENEW}`,
  },
  path_moved: {
    message: "The path now leads somewhere else. Nothing was changed.",
    guidance: "Check the file on the device and run again.",
  },
  secret_file: {
    message:
      "SubKit never touches files that look like keys, passwords or credentials. Nothing was changed.",
    guidance: "Choose another file for this step.",
  },
  hidden_path: {
    message: "Hidden files and folders are kept out. Nothing was changed.",
    guidance: "Use a path without segments that start with a dot.",
  },
  executable: {
    message:
      "SubKit does not touch programs or create files with a program extension. Nothing was changed.",
    guidance: "Use a document file name for this step.",
  },
  too_large: {
    message: "The file is larger than a local step may handle. Nothing was changed.",
    guidance:
      "Lists show up to 500 entries, text reads up to 256 KiB, imports up to 90 MiB and writes up to 10 MiB. Split the work or pick a smaller file.",
  },
  private_address: {
    message:
      "This address is on a private network and was not entered on the device. Nothing was sent.",
    guidance: `${DEVICE_SETTINGS} Type the address there yourself, then run again.`,
  },
  origin_not_allowed: {
    message: "This website is not allowed on the device. Nothing was sent.",
    guidance: `${DEVICE_SETTINGS} Allow the website, then run again.`,
  },
  credential_field: {
    message: "SubKit does not type into password, one-time code or card fields. Nothing was sent.",
    guidance: "Sign in yourself on the device; the session stays in this connector's browser.",
  },
  blocked_app: {
    message: "SubKit never acts in this app. Nothing was changed.",
    guidance: "Use another app, or do this step yourself.",
  },
  blocked_shortcut: {
    message: "This key combination could leave the app, so it is never sent. Nothing was changed.",
    guidance: "Use a key combination that stays inside the app.",
  },
  secure_focus: {
    message: "A password field had focus, so SubKit did nothing.",
    guidance: "Move the focus out of the password field on the device, then run again.",
  },
  stale: {
    message: "The page or window changed before SubKit could act. Nothing was changed.",
    guidance: "Run again; SubKit reads the page or window afresh before each action.",
  },
  owner_active: {
    message: "You were using the device, so SubKit did not take over. Nothing was changed.",
    guidance: "Leave the device idle for a moment and run again.",
  },
  stopped: {
    message: "Stopped on the device. Later steps won't run.",
    guidance: "Start the run again when you are ready.",
  },
  deadline_passed: {
    message: "The device did not start this step in time. Nothing was run.",
    guidance: "Keep SubKit open on the device and run again.",
  },
  permission_missing: {
    message: "The device lacks a macOS permission this step needs. Nothing was changed.",
    guidance:
      "Open SubKit on the device and grant Accessibility or Screen Recording, then run again.",
  },
  trash_unavailable: {
    message: "The Trash is not available on the device, so nothing was replaced, moved or removed.",
    guidance: "Check that the folder's disk has a working Trash, then run again.",
  },
  kind_not_ready: {
    message: "This device can't run this kind of step yet. Nothing ran.",
    guidance: "Use one of the supported local actions for this step.",
  },
  local_method_mismatch: {
    message: "The step's method does not match what it does. Nothing ran.",
    guidance: "Reading steps use GET; steps that change something use POST.",
  },
  local_step_invalid: {
    message: "The step's fields don't fit this local action. Nothing ran.",
    guidance: "Fix the step's body as the message names, then approve the new version.",
  },
  element_not_found: {
    message: "SubKit did not find the named element on the page or window. Nothing was changed.",
    guidance:
      "Check the element's role and name against the page or window, or add nth for repeated elements.",
  },
  element_ambiguous: {
    message: "Several elements match the named role and name. Nothing was changed.",
    guidance: "Add nth to the element (0 is the first match).",
  },
  app_not_open: {
    message: "The app has no open window on the device. Nothing was changed.",
    guidance: "Open the app on the device, then run again.",
  },
  import_unverified: {
    message: "The device named a file this step did not import. Nothing was kept.",
    guidance: "Run again; if it repeats, update SubKit on the device.",
  },
  files_partly_done: {
    message: "Not every item of this step was done. The result lists each item.",
    guidance:
      "Check the items that were refused or not run on the device before you run again; done items are not repeated automatically.",
  },
  screenshot_unverified: {
    message: "The screenshot does not match the hash the device reported. It was not kept.",
    guidance: "Run again; if it repeats, update SubKit on the device.",
  },
  device_result_invalid: {
    message: "The device answered in a shape SubKit does not know. Nothing more runs.",
    guidance: "Update SubKit on the device, then run again.",
  },
};

export const DEVICE_STEP_ERROR_CODES = Object.keys(DEVICE_STEP_REMEDIES);

export function deviceStepError(code: string, detail?: string, details?: unknown): DeviceStepError {
  if (code === "blocked_app" && detail === FILE_DIALOG_REFUSAL.en)
    return {
      code,
      message: FILE_DIALOG_REFUSAL.en,
      guidance:
        "Choose the file in the dialog yourself, or let a files step use an allowed folder.",
      ...(details === undefined ? {} : { details }),
    };
  const remedy = DEVICE_STEP_REMEDIES[code];
  const message = remedy?.message ?? (detail || "The device could not do this step.");
  return {
    code,
    message:
      remedy && detail && detail !== remedy.message ? `${remedy.message} ${detail}` : message,
    ...(remedy ? { guidance: remedy.guidance } : {}),
    ...(details === undefined ? {} : { details }),
  };
}

export type DeviceStepOutput =
  | { kind: "output"; output: unknown }
  | { kind: "import"; file_id: string; sha256: string | null; size: number | null }
  | { kind: "error"; error: DeviceStepError };

function record(value: unknown): Record<string, unknown> {
  return Object(value) as Record<string, unknown>;
}

function invalid(): DeviceStepOutput {
  return { kind: "error", error: deviceStepError("device_result_invalid") };
}

export function screenshotRef(png: Buffer): string {
  return `sha256:${createHash("sha256").update(png).digest("hex")}`;
}

function screenshotOf(output: Record<string, unknown>, evidence: DeviceEvidence): DeviceStepOutput {
  if ("withheld" in output) return { kind: "output", output: { withheld: output.withheld } };
  const image = record(output.image);
  const base64 = typeof image.base64 === "string" ? image.base64 : output.data;
  if (typeof base64 !== "string" || base64.length === 0) return invalid();
  const ref = screenshotRef(Buffer.from(base64, "base64"));
  if (evidence.screenshot_ref !== ref)
    return { kind: "error", error: deviceStepError("screenshot_unverified") };
  const { image: _image, data: _data, audit: _audit, sha256: _sha256, ...meta } = output;
  return { kind: "output", output: { ...meta, screenshot_ref: ref } };
}

function batchOf(output: Record<string, unknown>): DeviceStepOutput {
  const items = output.items;
  if (!Array.isArray(items)) return invalid();
  const done = items.filter((item) => record(item).status === "done").length;
  const summary = { items, done, not_done: items.length - done };
  if (done === items.length) return { kind: "output", output: summary };
  return {
    kind: "error",
    error: deviceStepError(
      "files_partly_done",
      `${done} of ${items.length} items were done.`,
      summary,
    ),
  };
}

export function deviceStepOutput(
  kind: string,
  raw: unknown,
  evidence: DeviceEvidence,
): DeviceStepOutput {
  const output = record(raw);
  switch (kind) {
    case "files.import": {
      if (typeof output.file_id !== "string") return invalid();
      return {
        kind: "import",
        file_id: output.file_id,
        sha256: typeof output.sha256 === "string" ? output.sha256 : null,
        size: typeof output.size === "number" ? output.size : null,
      };
    }
    case "files.move":
    case "files.trash":
      return batchOf(output);
    case "files.write":
      return {
        kind: "output",
        output: {
          ...output,
          ...(evidence.before_version ? { before_version: evidence.before_version } : {}),
          ...(evidence.after_version ? { after_version: evidence.after_version } : {}),
        },
      };
    case "browser.screenshot":
    case "computer.screenshot":
      return screenshotOf(output, evidence);
    default:
      return { kind: "output", output: raw ?? null };
  }
}
