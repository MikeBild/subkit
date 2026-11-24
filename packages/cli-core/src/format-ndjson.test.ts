import { afterEach, describe, expect, test } from "bun:test";
import { printNdjson } from "./format.ts";

const originalWrite = process.stdout.write.bind(process.stdout);
let captured = "";

const capture = (): void => {
  captured = "";
  process.stdout.write = ((chunk: string) => {
    captured += chunk;
    return true;
  }) as typeof process.stdout.write;
};

afterEach(() => {
  process.stdout.write = originalWrite;
});

describe("printNdjson", () => {
  test("writes nested values as one compact JSON line terminated by a newline", () => {
    capture();
    const nestedEvent = { level: "info", fields: { list: [1, 2], inner: { ok: true } } };
    printNdjson(nestedEvent);
    printNdjson("second");
    expect(captured).toBe(
      '{"level":"info","fields":{"list":[1,2],"inner":{"ok":true}}}\n"second"\n',
    );
    expect(
      captured
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toEqual([nestedEvent, "second"]);
  });
});
