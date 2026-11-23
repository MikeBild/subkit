import { describe, expect, test } from "bun:test";
import {
  acceptBlockedKey,
  acceptDigest,
  acceptedIndices,
  acceptedOperations,
  applyAccepted,
  chatApprovalOutput,
  operationSentence,
  promptReviewChanges,
  selectAll,
  selectionKey,
  selectionScope,
  stepOperations,
  stepReviewChanges,
  toggleSelection,
  withPatchedStep,
} from "./change-review";

const translate = (key: string, params?: Record<string, string>) =>
  params ? `${key}|${JSON.stringify(params)}` : key;

const before = {
  id: "fetch",
  kind: "request",
  url: "/v1/items",
  headers: { accept: "text/plain" },
  data_selector: "data.items",
};
const after = {
  id: "fetch",
  kind: "request",
  url: "/v2/items",
  headers: { accept: "text/plain", "x-api-version": "2" },
};

describe("stepOperations", () => {
  test("one operation per changed leaf path when the engine lists none", () => {
    const operations = stepOperations(before, after);
    expect(
      operations.map((operation) => [operation.index, operation.path, operation.kind]),
    ).toEqual([
      [0, "data_selector", "removed"],
      [1, "headers.x-api-version", "added"],
      [2, "url", "changed"],
    ]);
  });

  test("keeps the order and indices of the paths the engine lists", () => {
    const operations = stepOperations(before, after, ["url", "data_selector"]);
    expect(operations.map((operation) => operation.path)).toEqual(["url", "data_selector"]);
    expect(operations[0]).toMatchObject({ index: 0, before: "/v1/items", after: "/v2/items" });
  });

  test("a replaced non-object value is one whole-step operation", () => {
    expect(stepOperations("a", { id: "x" })).toEqual([
      { index: 0, path: "", kind: "changed", before: "a", after: { id: "x" } },
    ]);
  });
});

describe("operationSentence", () => {
  test("names the field and both short values", () => {
    const [, , url] = stepOperations(before, after);
    expect(url ? operationSentence(url, translate) : null).toEqual({
      key: "changeReview.sentence.changedValue",
      params: { field: "changeReview.field.url", before: "/v1/items", after: "/v2/items" },
    });
  });

  test("a header is named by its own name", () => {
    const [, header] = stepOperations(before, after);
    expect(header ? operationSentence(header, translate) : null).toEqual({
      key: "changeReview.sentence.addedValue",
      params: {
        field: 'changeReview.field.header|{"name":"x-api-version"}',
        after: "2",
      },
    });
  });

  test("a removal and a long value carry no values", () => {
    const [removed] = stepOperations(before, after);
    expect(removed ? operationSentence(removed, translate).key : null).toBe(
      "changeReview.sentence.removed",
    );
    const long = stepOperations({ expression: "a" }, { expression: "x".repeat(200) })[0];
    expect(long ? operationSentence(long, translate) : null).toEqual({
      key: "changeReview.sentence.changed",
      params: { field: "changeReview.field.expression" },
    });
  });

  test("long values move into the detail of the review change", () => {
    const changes = stepReviewChanges(
      stepOperations({ expression: "a" }, { expression: "x".repeat(200) }),
      translate,
    );
    expect(changes[0]).toMatchObject({ index: 0, before: "a", after: "x".repeat(200) });
    expect(stepReviewChanges(stepOperations(before, after), translate)[2]).toMatchObject({
      before: null,
      after: null,
    });
  });
});

describe("promptReviewChanges", () => {
  test("takes the sentence the engine wrote and drops an empty preview", () => {
    expect(
      promptReviewChanges([{ label: "Rename step", preview: " " }, { label: "Add step" }]),
    ).toEqual([
      { index: 0, sentence: "Rename step", before: null, after: null, preview: null },
      { index: 1, sentence: "Add step", before: null, after: null, preview: null },
    ]);
  });
});

describe("selection", () => {
  test("starts with every change accepted and toggles one at a time", () => {
    const all = selectAll(3);
    expect(selectionScope(all, 3)).toBe("all");
    const some = toggleSelection(all, 1);
    expect(acceptedIndices(some, 3)).toEqual([0, 2]);
    expect(selectionScope(some, 3)).toBe("some");
    expect(selectionKey(some, 3)).toBe("0,2");
    expect(selectionScope(toggleSelection(toggleSelection(some, 0), 2), 3)).toBe("none");
    expect(acceptedIndices(toggleSelection(some, 1), 3)).toEqual([0, 1, 2]);
  });

  test("ignores indices outside the list", () => {
    expect(acceptedIndices(new Set([5, -1, 1]), 2)).toEqual([1]);
  });

  test("chat answer carries approved_indices and declines when nothing is accepted", () => {
    expect(chatApprovalOutput(selectAll(2), 2)).toEqual({
      confirmed: true,
      partial: false,
      approved_indices: [0, 1],
    });
    expect(chatApprovalOutput(new Set([1]), 2)).toEqual({
      confirmed: true,
      partial: true,
      approved_indices: [1],
    });
    expect(chatApprovalOutput(new Set(), 2)).toEqual({ confirmed: false });
  });

  test("accepted_operations is sent only for a subset", () => {
    expect(acceptedOperations(selectAll(2), 2)).toBeUndefined();
    expect(acceptedOperations(new Set([1]), 2)).toEqual([1]);
    expect(acceptedOperations(new Set(), 2)).toBeUndefined();
  });
});

describe("applyAccepted", () => {
  const operations = stepOperations(before, after);

  test("applies only the accepted operations and leaves the original untouched", () => {
    expect(applyAccepted(before, operations, [2])).toEqual({ ...before, url: "/v2/items" });
    expect(before.url).toBe("/v1/items");
    expect(applyAccepted(before, operations, [0, 1])).toEqual({
      id: "fetch",
      kind: "request",
      url: "/v1/items",
      headers: { accept: "text/plain", "x-api-version": "2" },
    });
  });

  test("all accepted equals the proposed step, none equals the current step", () => {
    expect(applyAccepted(before, operations, [0, 1, 2])).toEqual(after);
    expect(applyAccepted(before, operations, [])).toEqual(before);
  });

  test("puts the patched step in its place and refuses an unknown step", () => {
    expect(withPatchedStep([{ id: "a" }, before], "fetch", after)).toEqual([{ id: "a" }, after]);
    expect(withPatchedStep([{ id: "a" }], "fetch", after)).toBeNull();
  });
});

describe("accepting", () => {
  const passed = { ok: true, error: null, digest: "d-sub" };

  test("nothing selected blocks", () => {
    expect(acceptBlockedKey({ scope: "none", key: "", tested: null, digestRequired: true })).toBe(
      "changeReview.blocked.none",
    );
  });

  test("a subset needs a test of exactly that subset when a digest is required", () => {
    const base = { scope: "some" as const, key: "0,2", digestRequired: true };
    expect(acceptBlockedKey({ ...base, tested: null })).toBe("changeReview.blocked.testFirst");
    expect(acceptBlockedKey({ ...base, tested: { key: "0", result: passed } })).toBe(
      "changeReview.blocked.testFirst",
    );
    expect(
      acceptBlockedKey({
        ...base,
        tested: { key: "0,2", result: { ok: false, error: "boom", digest: null } },
      }),
    ).toBe("changeReview.blocked.testFailed");
    expect(acceptBlockedKey({ ...base, tested: { key: "0,2", result: passed } })).toBeNull();
  });

  test("the whole change and a chat selection need no test", () => {
    expect(
      acceptBlockedKey({ scope: "all", key: "0,1", tested: null, digestRequired: true }),
    ).toBeNull();
    expect(
      acceptBlockedKey({ scope: "some", key: "0", tested: null, digestRequired: false }),
    ).toBeNull();
  });

  test("the digest follows the selection", () => {
    const tested = { key: "0", result: passed };
    expect(acceptDigest({ scope: "all", key: "0,1", tested, fullDigest: "d-all" })).toBe("d-all");
    expect(acceptDigest({ scope: "some", key: "0", tested, fullDigest: "d-all" })).toBe("d-sub");
    expect(acceptDigest({ scope: "some", key: "1", tested, fullDigest: "d-all" })).toBeNull();
    expect(acceptDigest({ scope: "none", key: "", tested, fullDigest: "d-all" })).toBeNull();
  });
});
