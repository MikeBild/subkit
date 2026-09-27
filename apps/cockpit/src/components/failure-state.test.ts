// The four states a read can be in, decided once.
//
// Several pages asked only "pending?" and then rendered rows, so a failed read
// fell through to the empty state: nobody was a member, nothing was
// configured, a conversation that could not be opened looked like a new one.

import { describe, expect, test } from "bun:test";
import { queryView } from "./failure-state";

const empty = (data: { items: unknown[] }) => data.items.length === 0;
const base = { data: undefined, error: null, failureReason: null, isPending: true };

describe("queryView", () => {
  test("nothing yet and nothing wrong is loading", () => {
    expect(queryView<{ items: unknown[] }>(base, empty)).toBe("loading");
  });

  test("a failed read is an error, not an empty list", () => {
    expect(
      queryView<{ items: unknown[] }>(
        { ...base, isPending: false, error: new Error("500") },
        empty,
      ),
    ).toBe("error");
  });

  test("the first failure already counts, while the query is still retrying", () => {
    // React Query keeps `isPending` through its retries — about seven seconds
    // of skeletons for a request that is already known to have failed.
    expect(
      queryView<{ items: unknown[] }>({ ...base, failureReason: new Error("500") }, empty),
    ).toBe("error");
  });

  test("rows are ready, no rows are empty", () => {
    expect(queryView({ ...base, isPending: false, data: { items: [1] } }, empty)).toBe("ready");
    expect(queryView({ ...base, isPending: false, data: { items: [] } }, empty)).toBe("empty");
  });

  test("data already on screen stays while a refresh fails", () => {
    // A failed background refresh must not blank a list the reader is using.
    expect(
      queryView(
        { ...base, isPending: false, data: { items: [1] }, error: new Error("500") },
        empty,
      ),
    ).toBe("ready");
  });
});
