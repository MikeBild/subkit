import { describe, expect, test } from "bun:test";
import {
  claimBody,
  claimedAsPending,
  claimedFiles,
  EMPTY_TRAY_MEMORY,
  failedIds,
  mergeProblems,
  observeTray,
  problemCodes,
  problemTone,
  type TrayItem,
  trayChips,
  trayUnavailable,
} from "./tray-model";

const NOW = Date.parse("2026-11-21T12:00:00Z");

function item(
  id: string,
  filename: string,
  extra: { status?: TrayItem["file"]["status"]; expires?: string; size?: number } = {},
): TrayItem {
  return {
    id,
    file: {
      id: `fid_${id}`,
      filename,
      content_type: null,
      size_bytes: extra.size ?? 2048,
      status: extra.status ?? "ready",
      slug: `slug-${id}`,
    },
    staged_at: "2026-11-21T10:00:00Z",
    expires_at: extra.expires ?? "2026-11-22T10:00:00Z",
  };
}

describe("tray chips", () => {
  test("show usable staged files with their kind and size", () => {
    expect(trayChips([item("a", "Rechnung.pdf"), item("b", "foto.PNG", { size: 9 })], NOW)).toEqual(
      [
        {
          id: "a",
          fileId: "fid_a",
          name: "Rechnung.pdf",
          size: 2048,
          kind: "pdf",
          contentType: null,
        },
        { id: "b", fileId: "fid_b", name: "foto.PNG", size: 9, kind: "image", contentType: null },
      ],
    );
  });

  test("leave out failed scans, expired files and files held for a send", () => {
    const items = [
      item("a", "a.md"),
      item("b", "b.md", { status: "failed" }),
      item("c", "c.md", { expires: "2026-11-21T11:59:59Z" }),
      item("d", "d.md", { status: "expired" }),
      item("e", "e.md"),
    ];
    expect(trayChips(items, NOW, new Set(["e"])).map((chip) => chip.id)).toEqual(["a"]);
  });

  test("keep a file that is still being scanned", () => {
    expect(trayChips([item("a", "a.csv", { status: "scanning" })], NOW)[0]?.kind).toBe("csv");
  });
});

describe("tray problems", () => {
  test("report a failed scan once, however often the tray refreshes", () => {
    const items = [item("a", "a.pdf", { status: "failed" }), item("b", "b.pdf")];
    const first = observeTray(EMPTY_TRAY_MEMORY, items, NOW);
    expect(first.fresh).toEqual([{ id: "a", name: "a.pdf", reason: "scan_failed" }]);
    expect(observeTray(first.memory, items, NOW).fresh).toEqual([]);
  });

  test("a file that vanished after its expiry counts as expired", () => {
    const shown = observeTray(
      EMPTY_TRAY_MEMORY,
      [item("a", "a.pdf", { expires: "2026-11-21T11:00:00Z" })],
      Date.parse("2026-11-21T10:30:00Z"),
    );
    expect(shown.fresh).toEqual([]);
    expect(observeTray(shown.memory, [], NOW).fresh).toEqual([
      { id: "a", name: "a.pdf", reason: "expired" },
    ]);
  });

  test("a file that vanished before its expiry was claimed or removed elsewhere", () => {
    const shown = observeTray(EMPTY_TRAY_MEMORY, [item("a", "a.pdf")], NOW);
    expect(observeTray(shown.memory, [], NOW).fresh).toEqual([]);
  });

  test("a file removed here is never reported as expired", () => {
    const shown = observeTray(
      EMPTY_TRAY_MEMORY,
      [item("a", "a.pdf", { expires: "2026-11-21T11:00:00Z" })],
      Date.parse("2026-11-21T10:30:00Z"),
    );
    expect(observeTray(shown.memory, [], NOW, new Set(["a"])).fresh).toEqual([]);
  });

  test("a still listed file past its expiry is reported as expired", () => {
    expect(
      observeTray(EMPTY_TRAY_MEMORY, [item("a", "a.pdf", { status: "expired" })], NOW).fresh,
    ).toEqual([{ id: "a", name: "a.pdf", reason: "expired" }]);
  });

  test("merging keeps each problem once and in arrival order", () => {
    const a = { id: "a", name: "a", reason: "expired" as const };
    const b = { id: "b", name: "b", reason: "scan_failed" as const };
    expect(mergeProblems([a], [a, b])).toEqual([a, b]);
  });

  test("a failed scan makes the notice a danger and names both codes", () => {
    const expired = { id: "a", name: "a", reason: "expired" as const };
    const failed = { id: "b", name: "b", reason: "scan_failed" as const };
    expect(problemTone([expired])).toBe("warning");
    expect(problemTone([expired, failed])).toBe("danger");
    expect(problemCodes([expired, failed, expired])).toBe(
      "composer_attachment_expired, file_rejected",
    );
    expect(failedIds([expired, failed])).toEqual(["b"]);
  });
});

describe("claim", () => {
  test("names exactly the shown ids, so later arrivals stay in the tray", () => {
    expect(claimBody("conv-1", ["a", "b"])).toEqual({ conversation_id: "conv-1", ids: ["a", "b"] });
  });

  test("claims nothing when no file is shown", () => {
    expect(claimBody("conv-1", [])).toBeNull();
  });

  test("hands back the linked files in the order the server linked them", () => {
    const linked = (id: string) => ({
      id,
      slug: `slug-${id}`,
      filename: `${id}.pdf`,
      size_bytes: 10,
      content_type: "application/pdf",
    });
    expect(claimedFiles({ attachments: [linked("x"), linked("y")] })).toEqual([
      { id: "x", slug: "slug-x", name: "x.pdf", size: 10, contentType: "application/pdf" },
      { id: "y", slug: "slug-y", name: "y.pdf", size: 10, contentType: "application/pdf" },
    ]);
  });

  test("claimed files of a failed send go back into the composer as linked files", () => {
    let n = 0;
    const key = () => `k${++n}`;
    expect(
      claimedAsPending(
        [{ id: "fid_x", slug: "s", name: "x.pdf", size: 10, contentType: null }],
        key,
      ),
    ).toEqual([
      { key: "k1", kind: "file", id: "fid_x", name: "x.pdf", size: 10, contentType: null },
    ]);
  });
});

test("an engine without the tray or a key without a person counts as an empty tray", () => {
  expect(trayUnavailable({ status: 404, code: "not_found" })).toBe(true);
  expect(trayUnavailable({ status: 403, code: "person_required" })).toBe(true);
  expect(trayUnavailable({ status: 403, code: "forbidden" })).toBe(false);
  expect(trayUnavailable({ status: 500, code: null })).toBe(false);
});
