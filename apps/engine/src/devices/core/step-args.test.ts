import { describe, expect, test } from "bun:test";
import type { DeviceSubBoundary } from "@shared/device/boundary.ts";
import {
  localStepArgs,
  parseLocalStep,
  STEP_ARGS_REFUSALS,
  type StepArgsInput,
} from "./step-args.ts";

const DEVICE = "6f1c2a7e-1b2c-4d3e-8f90-0a1b2c3d4e5f";
const D = (c: string) => c.repeat(64);
const PARTITION = "a1b2c3d4-0000-4000-8000-000000000001";

const files: DeviceSubBoundary = {
  device_id: DEVICE,
  capability: "files",
  folders: [
    { folder_id: "docs", access: "write", root_digest: D("a") },
    { folder_id: "inbox", access: "read", root_digest: D("b") },
  ],
};
const browser: DeviceSubBoundary = {
  device_id: DEVICE,
  capability: "browser",
  sites: [{ origin: "https://shop.example", private: false, site_digest: D("c") }],
  folders: [
    { folder_id: "docs", access: "write", root_digest: D("a") },
    { folder_id: "inbox", access: "read", root_digest: D("b") },
  ],
};
const computer: DeviceSubBoundary = {
  device_id: DEVICE,
  capability: "computer",
  apps: [{ app_id: "com.apple.iWork.Numbers", app_digest: D("d") }],
};

function plan(input: Partial<StepArgsInput> & Pick<StepArgsInput, "kind" | "body">) {
  const capability = input.kind.split(".")[0];
  const boundary =
    "boundary" in input
      ? (input.boundary ?? null)
      : capability === "files"
        ? files
        : capability === "browser"
          ? browser
          : computer;
  return localStepArgs({
    method: input.method ?? "POST",
    partition: PARTITION,
    ...input,
    boundary,
  });
}

function args(input: Parameters<typeof plan>[0]) {
  const result = plan(input);
  if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
  return result.plan;
}

describe("files bodies become runner args with the bound boundary", () => {
  test("list, read and mkdir address one target", () => {
    expect(args({ kind: "files.list", method: "GET", body: { folder_id: "inbox" } })).toEqual({
      kind: "files.list",
      args: { target: { folder_id: "inbox", path: "" }, boundary: files },
      element: null,
      app_id: null,
    });
    expect(
      args({ kind: "files.read_text", method: "get", body: { folder_id: "inbox", path: "a.txt" } })
        .args,
    ).toEqual({ target: { folder_id: "inbox", path: "a.txt" }, boundary: files });
    expect(args({ kind: "files.mkdir", body: { folder_id: "docs", path: "new" } }).args).toEqual({
      target: { folder_id: "docs", path: "new" },
      boundary: files,
    });
  });

  test("import keeps an optional name", () => {
    expect(
      args({
        kind: "files.import",
        body: { folder_id: "inbox", path: "r.pdf", name: "Report.pdf" },
      }).args,
    ).toEqual({
      target: { folder_id: "inbox", path: "r.pdf" },
      name: "Report.pdf",
      boundary: files,
    });
    expect(
      args({ kind: "files.import", body: { folder_id: "inbox", path: "r.pdf" } }).args,
    ).toEqual({ target: { folder_id: "inbox", path: "r.pdf" }, boundary: files });
  });

  test("write takes text or an encoded content and defaults replace to false", () => {
    expect(
      args({ kind: "files.write", body: { folder_id: "docs", path: "s.md", content: "Hi" } }).args,
    ).toEqual({
      target: { folder_id: "docs", path: "s.md" },
      content: { encoding: "utf8", text: "Hi" },
      replace: false,
      boundary: files,
    });
    expect(
      args({
        kind: "files.write",
        body: {
          folder_id: "docs",
          path: "s.bin",
          content: { encoding: "base64", data: "AAE=" },
          replace: true,
        },
      }).args,
    ).toEqual({
      target: { folder_id: "docs", path: "s.bin" },
      content: { encoding: "base64", data: "AAE=" },
      replace: true,
      boundary: files,
    });
  });

  test("move expands one pair or a list, into the same or another folder", () => {
    expect(
      args({ kind: "files.move", body: { folder_id: "docs", path: "a", to_path: "b/a" } }).args,
    ).toEqual({
      items: [{ from: { folder_id: "docs", path: "a" }, to: { folder_id: "docs", path: "b/a" } }],
      boundary: files,
    });
    const both: DeviceSubBoundary = {
      ...files,
      folders: [
        { folder_id: "archive", access: "write", root_digest: D("e") },
        { folder_id: "docs", access: "write", root_digest: D("a") },
      ],
    };
    expect(
      args({
        kind: "files.move",
        boundary: both,
        body: {
          folder_id: "docs",
          to_folder_id: "archive",
          items: [
            { from: "a", to: "a" },
            { from: "b", to: "2026/b" },
          ],
        },
      }).args,
    ).toEqual({
      items: [
        { from: { folder_id: "docs", path: "a" }, to: { folder_id: "archive", path: "a" } },
        { from: { folder_id: "docs", path: "b" }, to: { folder_id: "archive", path: "2026/b" } },
      ],
      boundary: both,
    });
  });

  test("trash takes one path or many", () => {
    expect(args({ kind: "files.trash", body: { folder_id: "docs", path: "old" } }).args).toEqual({
      items: [{ folder_id: "docs", path: "old" }],
      boundary: files,
    });
    expect(
      args({ kind: "files.trash", body: { folder_id: "docs", paths: ["a", "b"] } }).args,
    ).toEqual({
      items: [
        { folder_id: "docs", path: "a" },
        { folder_id: "docs", path: "b" },
      ],
      boundary: files,
    });
  });

  test("move and trash need exactly one way of naming their items", () => {
    for (const body of [
      { folder_id: "docs" },
      { folder_id: "docs", path: "a" },
      { folder_id: "docs", to_path: "a" },
      { folder_id: "docs", path: "a", to_path: "b", items: [{ from: "a", to: "b" }] },
      { folder_id: "docs", items: [] },
    ])
      expect(plan({ kind: "files.move", body })).toMatchObject({
        ok: false,
        code: "local_step_invalid",
      });
    for (const body of [
      { folder_id: "docs" },
      { folder_id: "docs", path: "a", paths: ["b"] },
      { folder_id: "docs", paths: Array.from({ length: 201 }, (_, i) => `f${i}`) },
    ])
      expect(plan({ kind: "files.trash", body })).toMatchObject({
        ok: false,
        code: "local_step_invalid",
      });
    expect(
      plan({ kind: "files.trash", body: { folder_id: "docs", paths: Array(200).fill("f") } }).ok,
    ).toBe(true);
  });
});

describe("refusals before anything is sent", () => {
  test("kinds the runner does not run yet", () => {
    for (const kind of [
      "browser.pdf",
      "browser.handover",
      "computer.open",
      "computer.find",
    ] as const)
      expect(plan({ kind, body: {} })).toEqual({
        ok: false,
        code: "kind_not_ready",
        detail: "This device can't run this kind of step yet.",
      });
  });

  test("GET means read: the method must fit what the step does", () => {
    expect(plan({ kind: "files.write", method: "GET", body: {} })).toEqual({
      ok: false,
      code: "local_method_mismatch",
      detail: "This step changes something, so it can't use GET.",
    });
    expect(plan({ kind: "files.list", method: "POST", body: { folder_id: "inbox" } })).toEqual({
      ok: false,
      code: "local_method_mismatch",
      detail: "This step only reads, so it uses GET.",
    });
    expect(plan({ kind: "browser.snapshot", method: "PUT", body: {} }).ok).toBe(false);
  });

  test("a body that does not fit names the field", () => {
    expect(plan({ kind: "files.write", body: { folder_id: "docs", path: "a" } })).toEqual({
      ok: false,
      code: "local_step_invalid",
      detail: expect.stringMatching(/^content: /),
    });
    expect(
      plan({ kind: "files.list", method: "GET", body: { folder_id: "inbox", extra: 1 } }),
    ).toMatchObject({ ok: false, code: "local_step_invalid" });
    expect(plan({ kind: "files.list", method: "GET", body: null })).toEqual({
      ok: false,
      code: "local_step_invalid",
      detail: expect.stringMatching(/^folder_id: /),
    });
    expect(plan({ kind: "browser.press", body: { action: "click" } })).toMatchObject({
      ok: false,
      code: "local_step_invalid",
    });
    expect(plan({ kind: "browser.press", body: { action: "click", ref: "e1" } })).toMatchObject({
      ok: false,
      code: "local_step_invalid",
    });
  });

  test("an unknown issue without a path still explains itself", () => {
    expect(plan({ kind: "files.trash", body: { folder_id: "docs" } })).toEqual({
      ok: false,
      code: "local_step_invalid",
      detail: "name either path or paths",
    });
  });

  test("no approval or an approval for another capability", () => {
    expect(
      plan({ kind: "files.list", method: "GET", body: { folder_id: "inbox" }, boundary: null }),
    ).toEqual({
      ok: false,
      code: "outside_boundary",
      detail: "This step is not part of an approval for this device.",
    });
    expect(
      plan({ kind: "files.list", method: "GET", body: { folder_id: "inbox" }, boundary: browser }),
    ).toMatchObject({ ok: false, code: "outside_boundary" });
  });

  test("a folder filled in at run time must be in the approval with enough access", () => {
    expect(plan({ kind: "files.list", method: "GET", body: { folder_id: "taxes" } })).toEqual({
      ok: false,
      code: "outside_boundary",
      detail: "The folder taxes is not part of this workflow's approval.",
    });
    expect(
      plan({ kind: "files.write", body: { folder_id: "inbox", path: "a", content: "" } }),
    ).toEqual({
      ok: false,
      code: "outside_boundary",
      detail: "The approval lets this workflow only read the folder inbox.",
    });
    expect(
      plan({
        kind: "files.move",
        body: { folder_id: "docs", to_folder_id: "inbox", path: "a", to_path: "a" },
      }),
    ).toMatchObject({ ok: false, code: "outside_boundary" });
    expect(plan({ kind: "files.import", body: { folder_id: "inbox", path: "a" } }).ok).toBe(true);
    expect(plan({ kind: "files.read_text", method: "GET", body: { folder_id: "docs" } }).ok).toBe(
      true,
    );
    expect(
      plan({
        kind: "files.list",
        method: "GET",
        body: { folder_id: "inbox" },
        boundary: { ...files, folders: undefined },
      }),
    ).toMatchObject({ ok: false, code: "outside_boundary" });
  });
});

describe("edges of the files bodies", () => {
  test("the refusal codes are fixed", () => {
    expect([...STEP_ARGS_REFUSALS]).toEqual([
      "kind_not_ready",
      "local_method_mismatch",
      "local_step_invalid",
      "outside_boundary",
    ]);
  });

  test("paths may be long but never empty", () => {
    expect(
      args({
        kind: "files.move",
        body: { folder_id: "docs", path: "notes/a.txt", to_path: "archive/a.txt" },
      }).args,
    ).toMatchObject({ items: [{ from: { path: "notes/a.txt" }, to: { path: "archive/a.txt" } }] });
    expect(
      args({
        kind: "files.move",
        body: { folder_id: "docs", items: [{ from: "notes/a.txt", to: "archive/a.txt" }] },
      }).args,
    ).toMatchObject({ items: [{ from: { path: "notes/a.txt" } }] });
    expect(
      args({ kind: "files.trash", body: { folder_id: "docs", paths: ["notes/a.txt"] } }).args,
    ).toMatchObject({ items: [{ path: "notes/a.txt" }] });
    for (const body of [
      { folder_id: "docs", path: "", to_path: "b" },
      { folder_id: "docs", items: [{ from: "", to: "b" }] },
      { folder_id: "docs", items: [{ from: "a", to: "" }] },
    ])
      expect(plan({ kind: "files.move", body }).ok).toBe(false);
    for (const body of [
      { folder_id: "docs", path: "" },
      { folder_id: "docs", paths: [""] },
    ])
      expect(plan({ kind: "files.trash", body }).ok).toBe(false);
  });

  test("a move names its items one way, and says so", () => {
    expect(plan({ kind: "files.move", body: { folder_id: "docs" } })).toEqual({
      ok: false,
      code: "local_step_invalid",
      detail: "name either path and to_path or items",
    });
  });

  test("an import without a name sends none", () => {
    const sent = args({ kind: "files.import", body: { folder_id: "inbox", path: "r.pdf" } }).args;
    expect("name" in sent).toBe(false);
  });
});

test("a nested field is named by its full path", () => {
  expect(
    plan({ kind: "files.move", body: { folder_id: "docs", items: [{ from: "", to: "b" }] } }),
  ).toEqual({
    ok: false,
    code: "local_step_invalid",
    detail: expect.stringMatching(/^items\.0\.from: /),
  });
});

test("a held step maps its body without an approval, and the approval adds only the boundary", () => {
  const input = {
    kind: "files.write" as const,
    method: "POST",
    body: { folder_id: "taxes", path: "a.md", content: "x" },
    partition: PARTITION,
  };
  expect(parseLocalStep(input)).toEqual({
    ok: true,
    body: { folder_id: "taxes", path: "a.md", content: "x", replace: false },
    plan: {
      kind: "files.write",
      args: {
        target: { folder_id: "taxes", path: "a.md" },
        content: { encoding: "utf8", text: "x" },
        replace: false,
      },
      element: null,
      app_id: null,
    },
  });
  expect(parseLocalStep({ ...input, method: "GET" })).toMatchObject({
    ok: false,
    code: "local_method_mismatch",
  });
});
