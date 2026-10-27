import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ResolvedFile } from "../../files/resolver.ts";
import { decodeWorkflowInputFile } from "./workflow-file-input.ts";

function fixture(text: string, size?: number): { file: ResolvedFile; hash: string } {
  const bytes = new TextEncoder().encode(text);
  return {
    hash: createHash("sha256").update(bytes).digest("hex"),
    file: {
      id: "input",
      filename: "input.json",
      content_type: "application/json",
      size_bytes: size ?? bytes.byteLength,
      async openRead() {
        return (async function* () {
          yield bytes.slice(0, 3);
          yield bytes.slice(3);
        })();
      },
    },
  };
}

test("loads structured input without expanding file references", async () => {
  const input = { parts: [{ data: { $file: "fid_example", $range: { start: 10, length: 4 } } }] };
  const { file, hash } = fixture(JSON.stringify(input));
  expect(await decodeWorkflowInputFile(file, hash)).toEqual(input);
});

test("rejects changed bytes, incomplete reads and unbounded input", async () => {
  const { file, hash } = fixture('{"parts":[]}');
  await expect(decodeWorkflowInputFile(file, "0".repeat(64))).rejects.toThrow("content changed");
  await expect(
    decodeWorkflowInputFile({ ...file, size_bytes: file.size_bytes + 1 }, hash),
  ).rejects.toThrow("content changed");
  await expect(
    decodeWorkflowInputFile({ ...file, size_bytes: file.size_bytes - 1 }, hash),
  ).rejects.toThrow("size changed");
  await expect(decodeWorkflowInputFile({ ...file, size_bytes: 1_048_577 }, hash)).rejects.toThrow(
    "supported size",
  );
});

test("requires a JSON object", async () => {
  for (const text of ["[]", "null", "42", "invalid"]) {
    const { file, hash } = fixture(text);
    await expect(decodeWorkflowInputFile(file, hash)).rejects.toThrow();
  }
});
