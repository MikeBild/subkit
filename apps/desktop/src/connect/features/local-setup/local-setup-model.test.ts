import { describe, expect, test } from "bun:test";
import { messageKeys } from "../../../shared/i18n.ts";
import type { LocalErrorKind } from "../../../shared/local/local-workspace-model.ts";
import type { LocalSetupModel } from "../../domain/index.ts";
import {
  aiFieldError,
  canContinue,
  ERROR_CODES,
  editForm,
  errorCopy,
  finishInput,
  INITIAL_FORM,
  PHASE_LABEL,
  STEP_LABEL,
  skipInput,
  stepName,
} from "./local-setup-model.ts";

const screen = (patch: Partial<LocalSetupModel> = {}): LocalSetupModel => ({
  kind: "local",
  step: 0,
  starting: false,
  folder: "/Users/anna/Library/Application Support/SubKit",
  folderRefusal: null,
  rows: [],
  error: null,
  working: false,
  done: false,
  ...patch,
});

const KINDS: LocalErrorKind[] = [
  "port",
  "disk",
  "permission",
  "folder",
  "keyRejected",
  "failed",
  "restore",
  "move",
];

describe("the setup form", () => {
  test("switching the kind of AI access drops a typed key", () => {
    const typed = editForm(INITIAL_FORM, { field: "key", value: "sk-1" });
    expect(editForm(typed, { field: "aiKind", value: "model" })).toMatchObject({
      aiKind: "model",
      key: "",
    });
    expect(editForm(typed, { field: "aiKind", value: "provider" })).toBe(typed);
  });

  test("editing clears a shown AI error", () => {
    const failed = editForm(INITIAL_FORM, { field: "aiError", value: true });
    expect(editForm(failed, { field: "key", value: "k" }).aiError).toBe(false);
    expect(editForm(failed, { field: "origin", value: "http://localhost:1" }).aiError).toBe(false);
    expect(editForm(failed, { field: "provider", value: "openai" }).aiError).toBe(false);
    expect(editForm(failed, { field: "name", value: "Anna" }).aiError).toBe(true);
  });

  test("the input for main carries the trimmed name and either a key or a loopback origin", () => {
    const named = { ...INITIAL_FORM, name: " Anna " };
    expect(finishInput({ ...named, key: " sk-1 " })).toEqual({
      name: "Anna",
      ai: { kind: "provider", provider: "anthropic", key: "sk-1" },
    });
    expect(finishInput({ ...named, key: "" })).toBeNull();
    expect(finishInput({ ...named, aiKind: "model", origin: "http://127.0.0.1:8080/" })).toEqual({
      name: "Anna",
      ai: { kind: "model", origin: "http://127.0.0.1:8080" },
    });
    expect(finishInput({ ...named, aiKind: "model", origin: "http://10.0.0.2:8080" })).toBeNull();
    expect(finishInput({ ...INITIAL_FORM, key: "sk-1" })).toBeNull();
  });

  test("each step continues only when its part is complete", () => {
    expect(canContinue(screen(), INITIAL_FORM)).toBe(true);
    expect(canContinue(screen({ folderRefusal: "network_folder" }), INITIAL_FORM)).toBe(false);
    expect(canContinue(screen({ working: true }), INITIAL_FORM)).toBe(false);
    expect(canContinue(screen({ step: 1 }), INITIAL_FORM)).toBe(false);
    expect(canContinue(screen({ step: 1 }), { ...INITIAL_FORM, name: "Anna" })).toBe(true);
    expect(canContinue(screen({ step: 2 }), INITIAL_FORM)).toBe(false);
    expect(canContinue(screen({ step: 2 }), { ...INITIAL_FORM, key: "k" })).toBe(true);
    expect(canContinue(screen({ step: 2 }), { ...INITIAL_FORM, aiKind: "model" })).toBe(true);
    expect(canContinue(screen({ step: 3 }), INITIAL_FORM)).toBe(false);
    expect(canContinue(screen({ step: 3, done: true }), INITIAL_FORM)).toBe(true);
    expect(canContinue(screen({ step: 3, done: true, error: "disk" }), INITIAL_FORM)).toBe(false);
  });

  test("a rejected key and an invalid entry show at the AI field", () => {
    expect(aiFieldError(INITIAL_FORM, null)).toBeNull();
    expect(aiFieldError(INITIAL_FORM, "keyRejected")).toBe("workspace.keyError");
    const model = { ...INITIAL_FORM, aiKind: "model" as const };
    expect(aiFieldError(model, "keyRejected")).toBeNull();
    expect(aiFieldError({ ...model, aiError: true }, null)).toBe("workspace.originError");
    expect(aiFieldError({ ...INITIAL_FORM, aiError: true }, null)).toBe("workspace.keyError");
  });
});

describe("copy and remedies", () => {
  const keys = new Set(messageKeys());

  test("every error kind has a title, a code and a remedy", () => {
    for (const kind of KINDS) {
      const copy = errorCopy(kind);
      expect(keys.has(copy.title)).toBe(true);
      if (copy.body) expect(keys.has(copy.body)).toBe(true);
      expect(ERROR_CODES[kind]).toMatch(/^[a-z_]+$/);
    }
    expect(errorCopy("port").remedy).toBe("port");
    expect(errorCopy("permission").remedy).toBe("folder");
    expect(errorCopy("folder").remedy).toBe("folder");
    expect(errorCopy("disk").remedy).toBe("retry");
  });

  test("steps and phases have labels", () => {
    expect([0, 1, 2, 3, 9].map(stepName)).toEqual(["folder", "you", "ai", "setting", "setting"]);
    for (const key of [...Object.values(STEP_LABEL), ...Object.values(PHASE_LABEL)])
      expect(keys.has(key)).toBe(true);
    expect(PHASE_LABEL).toEqual({
      database: "workspace.phase.database",
      engine: "workspace.phase.engine",
      workspace: "workspace.phase.workspace",
    });
    expect(STEP_LABEL).toEqual({
      folder: "workspace.step.folder",
      you: "workspace.step.you",
      ai: "workspace.step.ai",
      setting: "workspace.step.setting",
    });
  });

  test("each error names its own copy", () => {
    expect(KINDS.map((kind) => [kind, errorCopy(kind)])).toEqual([
      [
        "port",
        { title: "workspace.err.port.title", body: "workspace.err.port.body", remedy: "port" },
      ],
      [
        "disk",
        { title: "workspace.err.disk.title", body: "workspace.err.disk.body", remedy: "retry" },
      ],
      [
        "permission",
        {
          title: "workspace.err.permission.title",
          body: "workspace.err.permission.body",
          remedy: "folder",
        },
      ],
      [
        "folder",
        { title: "workspace.err.folder.title", body: "workspace.folderError", remedy: "folder" },
      ],
      [
        "keyRejected",
        { title: "workspace.err.keyRejected.title", body: "workspace.keyError", remedy: "retry" },
      ],
      [
        "failed",
        { title: "workspace.err.failed.title", body: "workspace.err.failed.body", remedy: "retry" },
      ],
      [
        "restore",
        {
          title: "workspace.err.restore.title",
          body: "workspace.err.restore.body",
          remedy: "retry",
        },
      ],
      [
        "move",
        { title: "workspace.err.move.title", body: "workspace.err.move.body", remedy: "retry" },
      ],
    ]);
    expect(new Set(Object.values(ERROR_CODES)).size).toBe(KINDS.length);
  });
});

describe("form edits change exactly their field", () => {
  test("each field", () => {
    const failed = { ...INITIAL_FORM, aiError: true, key: "k" };
    expect(editForm(failed, { field: "provider", value: "gemini" })).toEqual({
      ...failed,
      provider: "gemini",
      aiError: false,
    });
    expect(editForm(failed, { field: "key", value: "k2" })).toEqual({
      ...failed,
      key: "k2",
      aiError: false,
    });
    expect(editForm(failed, { field: "origin", value: "o" })).toEqual({
      ...failed,
      origin: "o",
      aiError: false,
    });
    expect(editForm(failed, { field: "name", value: "Anna" })).toEqual({ ...failed, name: "Anna" });
    expect(editForm(failed, { field: "aiKind", value: "model" })).toEqual({
      ...failed,
      aiKind: "model",
      key: "",
      aiError: false,
    });
  });

  test("blank entries do not continue", () => {
    const step2 = screen({ step: 2 });
    expect(canContinue(step2, { ...INITIAL_FORM, key: "  " })).toBe(false);
    expect(canContinue(step2, { ...INITIAL_FORM, aiKind: "model", origin: "  " })).toBe(false);
    expect(canContinue(step2, { ...INITIAL_FORM, aiKind: "model", key: "k", origin: "" })).toBe(
      false,
    );
  });
});

describe("setting up AI later", () => {
  test("needs only the name", () => {
    expect(skipInput({ ...INITIAL_FORM, name: " Anna " })).toEqual({ name: "Anna", ai: null });
    expect(skipInput(INITIAL_FORM)).toBeNull();
  });
});
