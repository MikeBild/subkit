import { expect, test } from "bun:test";
import type { TranslationKey } from "@/lib/i18n";
import { translate } from "@/lib/i18n";
import {
  type AttachmentNotice,
  MAX_ATTACHMENT_BYTES,
  takeAttachmentFiles,
} from "./chat-attachments";

const t = (key: TranslationKey, values?: Record<string, string | number>) =>
  translate("de", key, values);

function file(name: string, size: number, type = ""): File {
  const value = new File([], name, { type });
  Object.defineProperty(value, "size", { value: size });
  return value;
}

function take(files: File[]) {
  const notices: { message: string; action?: { label: string; onClick(): void } }[] = [];
  let opened = 0;
  const notify: AttachmentNotice = (message, options) =>
    notices.push({ message, action: options?.action });
  const taken = takeAttachmentFiles(files, t, {
    notify,
    openPackages: () => {
      opened += 1;
    },
  });
  return { taken, notices, opened: () => opened };
}

test("points a large package to the package import with an action", () => {
  const result = take([file("export.zip", MAX_ATTACHMENT_BYTES + 1)]);
  expect(result.taken).toEqual([]);
  expect(result.notices).toHaveLength(1);
  expect(result.notices[0]?.message).toContain("export.zip");
  expect(result.notices[0]?.message).toContain("Paket importieren");
  expect(result.notices[0]?.action?.label).toBe("Pakete öffnen");
  result.notices[0]?.action?.onClick();
  expect(result.opened()).toBe(1);
});

test("recognises a package by its zip type", () => {
  const result = take([file("export", MAX_ATTACHMENT_BYTES + 1, "application/x-zip-compressed")]);
  expect(result.notices[0]?.action?.label).toBe("Pakete öffnen");
});

test("refuses other large files with the general message", () => {
  const result = take([file("report.pdf", MAX_ATTACHMENT_BYTES + 1, "application/pdf")]);
  expect(result.taken).toEqual([]);
  expect(result.notices).toEqual([
    {
      message: t("platform.file.tooLarge", { name: "report.pdf", max: "5 MB" }),
      action: undefined,
    },
  ]);
});

test("accepts a package up to the attachment limit", () => {
  const result = take([file("export.zip", MAX_ATTACHMENT_BYTES, "application/zip")]);
  expect(result.notices).toEqual([]);
  expect(result.taken).toHaveLength(1);
  expect(result.taken[0]?.kind).toBe("upload");
});
