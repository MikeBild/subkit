import { expect, test } from "bun:test";
import fc from "fast-check";
import { prepareKnowledgeChunks } from "./ingestion-plan.ts";

const chunk = { content: "text", fingerprint: "same", byte_size: 4, shingles: new Set([1, 2]) };

test("supplied parsed chunks retain duplicates while file parsing deduplicates before budgeting", () => {
  const chunks = Object.freeze([chunk, { ...chunk }]);
  expect(prepareKnowledgeChunks(chunks, true, 0.8)).toEqual({
    accepted: [...chunks],
    skipped: 0,
    total_bytes: 8,
  });
  expect(prepareKnowledgeChunks(chunks, false, 0.8)).toEqual({
    accepted: [chunk],
    skipped: 1,
    total_bytes: 4,
  });
  expect(chunks).toHaveLength(2);
  expect(prepareKnowledgeChunks([], false, 0.8)).toEqual({
    accepted: [],
    skipped: 0,
    total_bytes: 0,
  });
});

test("the supplied similarity threshold governs accepted-byte accounting", () => {
  const similar = {
    ...chunk,
    fingerprint: "different",
    byte_size: 9,
    shingles: new Set([1, 2, 3]),
  };
  expect(prepareKnowledgeChunks([chunk, similar], false, 0.6).total_bytes).toBe(4);
  expect(prepareKnowledgeChunks([chunk, similar], false, 0.8).total_bytes).toBe(13);
});

test("parsed chunk byte accounting is additive and preserves the input", () => {
  fc.assert(
    fc.property(fc.array(fc.integer({ min: 0, max: 10000 }), { maxLength: 20 }), (sizes) => {
      const chunks = Object.freeze(sizes.map((byte_size) => ({ ...chunk, byte_size })));
      const plan = prepareKnowledgeChunks(chunks, true, 0.8);
      expect(plan.total_bytes).toBe(sizes.reduce((a, b) => a + b, 0));
      expect(plan.skipped).toBe(0);
      expect(chunks.map((item) => item.byte_size)).toEqual(sizes);
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
