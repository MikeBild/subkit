import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import {
  sourceChunksQuery,
  sourceContentQuery,
  sourceHistoryQuery,
  sourceQuery,
} from "@/features/knowledge/api/knowledge-source-queries";
import { KEYS } from "@/features/knowledge/queries";

function pollAfter(status: string): number | false | undefined {
  const client = new QueryClient();
  const options = sourceQuery("s1");
  client.setQueryData(options.queryKey, { status } as never);
  const query = client.getQueryCache().find({ queryKey: options.queryKey });
  const interval = options.refetchInterval;
  return typeof interval === "function" ? interval(query as never) : interval;
}

describe("source queries", () => {
  test("every source query lives under the source key, so one invalidation reaches all", () => {
    const root: unknown[] = [...KEYS.source("s1")];
    const key = (options: { queryKey: readonly unknown[] }): unknown[] => [...options.queryKey];
    expect(key(sourceQuery("s1"))).toEqual(root);
    expect(key(sourceHistoryQuery("s1"))).toEqual([...root, "history"]);
    expect(key(sourceContentQuery("s1", true))).toEqual([...root, "content"]);
    expect(key(sourceChunksQuery({ id: "s1", version: "4", status: "active" }))).toEqual([
      ...root,
      "chunks",
      "4",
    ]);
  });

  test("a source is polled while it is being read and left alone otherwise", () => {
    expect(pollAfter("processing")).toBe(2000);
    expect(pollAfter("active")).toBe(false);
    expect(pollAfter("error")).toBe(false);
  });

  test("sections load only once reading is done, the text only while the editor is open", () => {
    expect(sourceChunksQuery({ id: "s1", version: "1", status: "processing" }).enabled).toBe(false);
    expect(sourceChunksQuery({ id: "s1", version: "1", status: "active" }).enabled).toBe(true);
    expect(sourceContentQuery("s1", false).enabled).toBe(false);
    expect(sourceContentQuery("s1", true).enabled).toBe(true);
  });
});
