import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { version } from "xlsx";
import manifest from "../../vendor/xlsx.json";

test("vendored spreadsheet parser matches its recorded digest and installed release", async () => {
  const bytes = await readFile(resolve(import.meta.dir, "../../vendor/xlsx.tgz"));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(manifest.sha256);
  expect(version).toBe(manifest.version);
  expect(await Bun.file(resolve(import.meta.dir, "../../vendor/xlsx.LICENSE")).text()).toContain(
    "Apache License",
  );
});
