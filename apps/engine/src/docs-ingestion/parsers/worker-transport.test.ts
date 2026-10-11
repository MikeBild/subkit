import { expect, test } from "bun:test";
import { runJs } from "../../sandboxes/quickjs/runtime.ts";
import { parseBinaryFile } from "./index.ts";

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
