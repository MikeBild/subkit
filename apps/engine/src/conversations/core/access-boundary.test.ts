import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..", "..");
const SCOPES = ["conversations", "api/operations", "http/routes/conversations", "mcp", "chat"];
const ALLOWED = new Set(["conversations/core/access.ts"]);
// A conversation's owner_id compared with a principal, in either direction.
const OWNER_COMPARE =
  /owner_id\s*(!==|===)\s*[A-Za-z_.?]*principal[A-Za-z_.?]*\.id\b|principal[A-Za-z_.?]*\.id\s*(!==|===)\s*[A-Za-z_.?]*owner_id/;
// Owned rows of other kinds that happen to live in these folders.
const OTHER_OWNERS = /\b(task|body)\.owner_id\b/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "tests" ? [] : files(path);
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("conversation access boundary", () => {
  test("only conversations/core/access.ts compares a conversation owner with a principal", () => {
    const hits = SCOPES.flatMap((scope) => files(join(SRC, scope)))
      .map((path) => relative(SRC, path))
      .filter((rel) => !ALLOWED.has(rel))
      .flatMap((rel) =>
        readFileSync(join(SRC, rel), "utf8")
          .split("\n")
          .map((line, index) => ({ rel, line, index }))
          .filter(({ line }) => OWNER_COMPARE.test(line) && !OTHER_OWNERS.test(line))
          .map(({ rel, index }) => `${rel}:${index + 1}`),
      );
    expect(hits).toEqual([]);
  });
});
