import { expect, mock, test } from "bun:test";

const received: string[][] = [];
mock.module(
  new URL(
    "../../../../../node_modules/@huggingface/transformers/dist/transformers.web.js",
    import.meta.url,
  ).pathname,
  () => ({
    env: {},
    pipeline: async () => async (texts: string[]) => {
      received.push(texts);
      return { tolist: () => texts.map(() => [1, 0]) };
    },
  }),
);

const { embedTexts } = await import("../local-provider.ts");

test("bounds tokenizer input for large API catalogs while preserving batch alignment", async () => {
  const short = "GET /v1/apps";
  const large = "schema ".repeat(300_000);
  const result = await embedTexts([large, short]);
  expect(result).toEqual([
    [1, 0],
    [1, 0],
  ]);
  expect(received[0]?.[0]).toHaveLength(8192);
  expect(large.startsWith(received[0]?.[0] ?? "")).toBe(true);
  expect(received[0]?.[1]).toBe(short);
});
