import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DEVICE_REFUSALS } from "@shared/device/protocol.ts";
import { classifyFailure } from "../../execution/core/classify.ts";
import { sensitiveFailure } from "../../execution/sensitive-payload.ts";
import { STEP_ARGS_REFUSALS } from "./step-args.ts";
import {
  DEVICE_STEP_ERROR_CODES,
  DEVICE_STEP_REMEDIES,
  deviceStepError,
  deviceStepOutput,
  screenshotRef,
} from "./step-output.ts";

describe("device step errors", () => {
  test("every refusal and every engine-side code has a message and a remedy", () => {
    for (const code of [
      ...DEVICE_REFUSALS,
      ...STEP_ARGS_REFUSALS,
      "element_not_found",
      "element_ambiguous",
      "app_not_open",
      "import_unverified",
      "files_partly_done",
      "screenshot_unverified",
      "device_result_invalid",
    ]) {
      const remedy = DEVICE_STEP_REMEDIES[code];
      expect(remedy?.message.length).toBeGreaterThan(10);
      expect(remedy?.guidance.length).toBeGreaterThan(10);
      expect(DEVICE_STEP_ERROR_CODES).toContain(code);
    }
  });

  test("the remedy rides as guidance; the device's detail is appended once", () => {
    expect(deviceStepError("secret_file")).toEqual({
      code: "secret_file",
      message: DEVICE_STEP_REMEDIES.secret_file?.message as string,
      guidance: DEVICE_STEP_REMEDIES.secret_file?.guidance as string,
    });
    expect(deviceStepError("secret_file", "")).toEqual(deviceStepError("secret_file"));
    expect(deviceStepError("stale", DEVICE_STEP_REMEDIES.stale?.message)).toEqual(
      deviceStepError("stale"),
    );
    expect(deviceStepError("outside_boundary", "The folder x is not approved.").message).toBe(
      `${DEVICE_STEP_REMEDIES.outside_boundary?.message} The folder x is not approved.`,
    );
    const dialog =
      "File dialogs are yours to use; for files SubKit uses the allowed folders. Nothing was sent.";
    expect(deviceStepError("blocked_app", dialog)).toStrictEqual({
      code: "blocked_app",
      message: dialog,
      guidance:
        "Choose the file in the dialog yourself, or let a files step use an allowed folder.",
    });
    expect(deviceStepError("blocked_app", dialog, { x: 1 })).toMatchObject({ details: { x: 1 } });
    expect(deviceStepError("blocked_app", "other").message).toBe(
      `${DEVICE_STEP_REMEDIES.blocked_app?.message} other`,
    );
    expect(deviceStepError("secret_file", dialog).message).not.toBe(dialog);
    expect(deviceStepError("files_partly_done", "1 of 2", { items: [] })).toMatchObject({
      details: { items: [] },
    });
  });

  test("an unknown device failure keeps its own detail, or a plain fallback", () => {
    expect(deviceStepError("not_text", "The file is not text.")).toEqual({
      code: "not_text",
      message: "The file is not text.",
    });
    expect(deviceStepError("import_failed")).toEqual({
      code: "import_failed",
      message: "The device could not do this step.",
    });
    expect(deviceStepError("import_failed", "")).toEqual(deviceStepError("import_failed"));
  });

  test("codes fall into the existing failure classes", () => {
    const classOf = (code: string) =>
      classifyFailure({ status: "failed", error: deviceStepError(code) });
    expect(classOf("outside_boundary")).toBe("authority_mismatch");
    expect(classOf("folder_changed")).toBe("authority_mismatch");
    for (const code of [
      "outside_allowance",
      "origin_not_allowed",
      "private_address",
      "permission_missing",
      "trash_unavailable",
      "app_not_open",
    ])
      expect(classOf(code)).toBe("connector_unavailable");
    for (const code of ["secret_file", "stale", "deadline_passed", "owner_active", "stopped"])
      expect(classOf(code)).toBe("driver_error");
  });

  test("sensitive runs keep the remedy", () => {
    expect(sensitiveFailure("folder_changed")).toEqual({
      code: "folder_changed",
      message: `${DEVICE_STEP_REMEDIES.folder_changed?.message} ${DEVICE_STEP_REMEDIES.folder_changed?.guidance}`,
    });
  });
});

describe("device step output", () => {
  test("a write reports size, hash and the versions around it", () => {
    expect(
      deviceStepOutput(
        "files.write",
        { size: 2, sha256: "ab", replaced: true, previous_in_trash: true },
        { before_version: "v1", after_version: "v2" },
      ),
    ).toEqual({
      kind: "output",
      output: {
        size: 2,
        sha256: "ab",
        replaced: true,
        previous_in_trash: true,
        before_version: "v1",
        after_version: "v2",
      },
    });
    expect(deviceStepOutput("files.write", { size: 1 }, {})).toEqual({
      kind: "output",
      output: { size: 1 },
    });
  });

  test("an import hands over its file id for the file record", () => {
    expect(
      deviceStepOutput("files.import", { file_id: "f", name: "a", size: 3, sha256: "cd" }, {}),
    ).toEqual({ kind: "import", file_id: "f", sha256: "cd", size: 3 });
    expect(deviceStepOutput("files.import", { file_id: "f" }, {})).toEqual({
      kind: "import",
      file_id: "f",
      sha256: null,
      size: null,
    });
    expect(deviceStepOutput("files.import", { name: "a" }, {})).toEqual({
      kind: "error",
      error: deviceStepError("device_result_invalid"),
    });
  });

  test("move and trash succeed only when every item was done", () => {
    const done = { items: [{ index: 0, status: "done", version: "v" }] };
    expect(deviceStepOutput("files.trash", done, {})).toEqual({
      kind: "output",
      output: { ...done, done: 1, not_done: 0 },
    });
    const mixed = {
      items: [
        { index: 0, status: "done" },
        { index: 1, status: "refused", code: "secret_file" },
        null,
      ],
    };
    expect(deviceStepOutput("files.move", mixed, {})).toEqual({
      kind: "error",
      error: deviceStepError("files_partly_done", "1 of 3 items were done.", {
        ...mixed,
        done: 1,
        not_done: 2,
      }),
    });
    expect(deviceStepOutput("files.move", { items: "x" }, {}).kind).toBe("error");
  });

  test("a browser screenshot keeps only its verified PNG hash", () => {
    const png = Buffer.from("ABC");
    const ref = `sha256:${createHash("sha256").update(png).digest("hex")}`;
    expect(screenshotRef(png)).toBe(ref);
    expect(
      deviceStepOutput(
        "browser.screenshot",
        { image: { mime: "image/png", base64: png.toString("base64") } },
        { screenshot_ref: ref, after_version: "p" },
      ),
    ).toEqual({ kind: "output", output: { screenshot_ref: ref } });
    expect(deviceStepOutput("browser.screenshot", { withheld: "keep_out" }, {})).toEqual({
      kind: "output",
      output: { withheld: "keep_out" },
    });
  });

  test("a hash over anything but the PNG bytes is refused", () => {
    const base64 = Buffer.from("ABC").toString("base64");
    const overBase64 = `sha256:${createHash("sha256").update(base64).digest("hex")}`;
    for (const evidence of [{ screenshot_ref: overBase64 }, {}])
      expect(deviceStepOutput("browser.screenshot", { image: { base64 } }, evidence)).toEqual({
        kind: "error",
        error: deviceStepError("screenshot_unverified"),
      });
  });

  test("computer screenshots keep their size facts but not data, hash copy or audit", () => {
    const png = Buffer.from("PNG");
    const ref = screenshotRef(png);
    expect(
      deviceStepOutput(
        "computer.screenshot",
        {
          format: "png",
          width: 10,
          height: 5,
          data: png.toString("base64"),
          sha256: "ff",
          redacted: 2,
          audit: { app_bundle_id: "x" },
        },
        { screenshot_ref: ref },
      ),
    ).toEqual({
      kind: "output",
      output: { format: "png", width: 10, height: 5, redacted: 2, screenshot_ref: ref },
    });
    for (const raw of [{ data: "" }, { data: 5 }, {}, null, { image: { base64: 1 } }])
      expect(deviceStepOutput("computer.screenshot", raw, { screenshot_ref: ref })).toEqual({
        kind: "error",
        error: deviceStepError("device_result_invalid"),
      });
  });

  test("other kinds pass their output through", () => {
    expect(deviceStepOutput("files.read_text", { text: "x" }, {})).toEqual({
      kind: "output",
      output: { text: "x" },
    });
    expect(deviceStepOutput("browser.open", undefined, {})).toEqual({
      kind: "output",
      output: null,
    });
    expect(deviceStepOutput("files.list", [1], {})).toEqual({ kind: "output", output: [1] });
  });
});

describe("remedies and shapes in detail", () => {
  test("the shared remedy phrases are spelled out", () => {
    expect(DEVICE_STEP_REMEDIES.outside_boundary?.guidance).toBe(
      "Open the workflow, review its approval on this device and approve it again. A value filled in while the run goes must stay inside the approved folders, websites and apps.",
    );
    expect(DEVICE_STEP_REMEDIES.outside_allowance?.guidance).toBe(
      "Open SubKit on the device and check Settings › Local capabilities. Allow the folder, website or app, then run again.",
    );
  });

  test("an error without details carries no details key", () => {
    expect(deviceStepError("stale")).toStrictEqual({
      code: "stale",
      message: DEVICE_STEP_REMEDIES.stale?.message as string,
      guidance: DEVICE_STEP_REMEDIES.stale?.guidance as string,
    });
  });
});
