import { describe, expect, test } from "bun:test";
import type { ActorDirectory } from "@/app/actor-directory-model";
import type { FileVersion } from "@/pages/file-versions-model";
import { FileVersionTimeline } from "./file-versions";
import { render } from "./patterns/test-utils";

const versions: FileVersion[] = [
  {
    version: 3,
    current: true,
    filename: "angebot.pdf",
    content_type: "application/pdf",
    size_bytes: 2048,
    sha256: null,
    restored_from: 1,
    uploaded_at: "2026-10-03T08:00:00.000Z",
    uploaded_by: { kind: "user", id: "4f0e8c0e-1111-4111-8111-111111111111" },
    replaced_at: null,
  },
  {
    version: 2,
    current: false,
    filename: "angebot.pdf",
    content_type: "application/pdf",
    size_bytes: 1024,
    sha256: null,
    restored_from: null,
    uploaded_at: "2026-10-02T08:00:00.000Z",
    uploaded_by: null,
    replaced_at: "2026-10-03T08:00:00.000Z",
  },
  {
    version: 1,
    current: false,
    filename: "angebot.pdf",
    content_type: "application/pdf",
    size_bytes: 512,
    sha256: null,
    restored_from: null,
    uploaded_at: "2026-10-01T08:00:00.000Z",
    uploaded_by: null,
    replaced_at: "2026-10-02T08:00:00.000Z",
  },
];

const directory: ActorDirectory = new Map([
  ["user:4f0e8c0e-1111-4111-8111-111111111111", "Mike Bild"],
]);

describe("file version timeline", () => {
  test("lists every version newest first with what changed and who uploaded it", () => {
    const html = render(
      <FileVersionTimeline items={versions} directory={directory} onOpen={() => {}} />,
    );
    const order = ["file-version-3", "file-version-2", "file-version-1"].map((id) =>
      html.indexOf(`data-testid="${id}"`),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("v3 · Aus v1 wiederhergestellt");
    expect(html).toContain("v2 · Neue Fassung hochgeladen");
    expect(html).toContain("v1 · Erste Fassung");
    expect(html).toContain("Mike Bild");
    expect(html).toContain("Aktuell");
    expect(html).not.toContain("4f0e8c0e-1111");
  });

  test("speaks English for English readers", () => {
    const html = render(
      <FileVersionTimeline items={versions} directory={directory} onOpen={() => {}} />,
      "en",
    );
    expect(html).toContain("v1 · First version");
    expect(html).toContain("Current");
  });
});
