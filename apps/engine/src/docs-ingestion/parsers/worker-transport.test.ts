import { expect, test } from "bun:test";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import { parseBinaryFile, parseCsvFile } from "./index.ts";

test("the existing file ceiling reaches parser validation through worker IPC", async () => {
  const buffer = Buffer.alloc(25 * 1024 * 1024, 0x20);
  buffer.write("%PDF-1.7\n");
  let failure: unknown;
  try {
    await parseBinaryFile(buffer, "pdf");
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).not.toMatch(
    /transport limit|request exceeds|invalid response|without a response/,
  );
  const healthy = await runJs({ code: "return 42;", input: null, clock: null });
  expect(healthy.output).toBe(42);
  expect(healthy.stats.worker_pid).not.toBe(process.pid);
}, 30_000);

test("decoded parser inputs above the IPC ceiling fail before dispatch", async () => {
  await expect(parseBinaryFile(Buffer.alloc(32 * 1024 * 1024 + 1), "pdf")).rejects.toThrow(
    "transport limit",
  );
});

test("a wide CSV comes back through worker IPC with every row and column", async () => {
  const columns = Array.from(
    { length: 120 },
    (_, i) => `column_name_number_${String(i).padStart(3, "0")}`,
  );
  const lines = [columns.join(",")];
  for (let r = 0; r < 12_000; r += 1)
    lines.push(columns.map((_, c) => `${r % 97}${c % 10}`).join(","));
  const result = await parseCsvFile(Buffer.from(lines.join("\n")), { max_rows: 10_000 });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.rows).toHaveLength(10_000);
  expect(result.row_count).toBe(12_000);
  expect(result.truncated).toBe(true);
  expect(result.rows[9_999]?.column_name_number_119).toBe(`${9_999 % 97}9`);
}, 60_000);
