import { expect, test } from "bun:test";
import { runJs } from "./runtime.ts";

test("typed array replacement cannot read beyond a resized backing buffer", async () => {
  const result = await runJs({
    code: `
      const buffer = new ArrayBuffer(4096, { maxByteLength: 4096 });
      const values = new Int32Array(buffer);
      values.fill(111);
      const copy = values.with(0, {
        valueOf() {
          buffer.resize(4);
          return 999;
        },
      });
      return {
        length: copy.length,
        first: copy[0],
        tailIsZero: copy.subarray(1).every((value) => value === 0),
      };
    `,
    input: null,
    clock: null,
  });
  expect(result.output).toEqual({ length: 1024, first: 999, tailIsZero: true });
});
