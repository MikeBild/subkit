import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findComments } from "../audit/comments.ts";
import { createCache } from "../audit/ratchets.ts";
import { subsystemEntryHits } from "../audit/rules.ts";

const file = "apps/engine/src/execution/steps/request/query-params.ts";
const repo = fileURLToPath(new URL("../../../../", import.meta.url));

describe("request query invariants", () => {
  test("contains no prohibited comments", () => {
    expect(findComments(file, readFileSync(join(repo, file), "utf8"))).toEqual([]);
  });

  test("imports the LLM subsystem through its entry point", () => {
    expect(subsystemEntryHits(file, createCache(repo).resolvedImports(file))).toEqual([]);
  });
});
