import { expect, test } from "bun:test";
import { exportInstallationFile } from "./installation-export";

test("selects a local destination before fetching and streams only the explicit download", async () => {
  const actions: string[] = [];
  const chunks: Uint8Array[] = [];
  const result = await exportInstallationFile(
    "report.txt",
    async () => {
      actions.push("read");
      return new Response("exported source");
    },
    async (options) => {
      actions.push("pick");
      expect(options.suggestedName).toBe("report.txt");
      return {
        createWritable: async () =>
          new WritableStream({
            write(chunk) {
              chunks.push(chunk);
            },
          }),
      };
    },
  );
  expect(result).toBe("saved");
  expect(actions).toEqual(["pick", "read"]);
  expect(new TextDecoder().decode(chunks[0])).toBe("exported source");
});

test("does not fetch or write when the user cancels or the browser has no picker", async () => {
  let reads = 0;
  const read = async () => {
    reads += 1;
    return new Response("private source");
  };
  expect(await exportInstallationFile("report.txt", read, null)).toBe("unsupported");
  expect(
    await exportInstallationFile("report.txt", read, async () => {
      throw new DOMException("cancelled", "AbortError");
    }),
  ).toBe("cancelled");
  expect(reads).toBe(0);
});

test("leaves an existing destination untouched when the authenticated download fails", async () => {
  let writes = 0;
  await expect(
    exportInstallationFile(
      "report.txt",
      async () => new Response(null, { status: 401 }),
      async () => ({
        createWritable: async () => {
          writes += 1;
          return new WritableStream();
        },
      }),
    ),
  ).rejects.toThrow("file_download_failed");
  expect(writes).toBe(0);
});
