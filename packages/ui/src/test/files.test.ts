import { describe, expect, it } from "bun:test";
import { FILE_ICON } from "@ui/lib/files";
import { File, FileImage } from "lucide-react";

describe("file icons", () => {
  it("has one icon per kind", () => {
    expect(FILE_ICON.image).toBe(FileImage);
    expect(FILE_ICON.text).toBe(File);
    expect(Object.keys(FILE_ICON).sort()).toEqual(["csv", "image", "md", "pdf", "text"]);
  });
});
